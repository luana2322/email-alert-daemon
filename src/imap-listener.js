/**
 * imap-listener.js - Manages persistent IMAP IDLE connections for a single email account.
 * Automatically discovers and monitors BOTH primary INBOX and SPAM/JUNK folders in real-time.
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { notifyNewEmail } = require('./notifier');

class MailboxWatcher {
  constructor(account, mailboxPath, isSpam, logPrefix, onNotification) {
    this.account = account;
    this.mailboxPath = mailboxPath;
    this.isSpam = isSpam;
    this.logPrefix = logPrefix;
    this.onNotification = onNotification;

    this.client = null;
    this.isStopping = false;
    this.initialSyncDone = false;
    this.highestUid = 0;
    this.processedUids = new Set();
    this.isHandlingNew = false;
  }

  log(msg) {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] [${this.logPrefix}] ${msg}`);
  }

  error(msg, err) {
    const time = new Date().toLocaleTimeString();
    console.error(`[${time}] [${this.logPrefix}] ❌ ${msg}`, err ? (err.message || err) : '');
  }

  async start() {
    this.isStopping = false;
    await this.connectAndListen();
  }

  async stop() {
    this.isStopping = true;
    if (this.client) {
      try {
        await this.client.logout();
      } catch (_) {}
      this.client = null;
    }
  }

  async connectAndListen() {
    if (this.isStopping) return;

    this.client = new ImapFlow({
      host: this.account.host,
      port: this.account.port || 993,
      secure: this.account.secure !== false,
      auth: this.account.auth,
      logger: false,
      clientInfo: {
        name: 'EmailAlertDaemon',
        version: '1.1.0'
      }
    });

    this.client.on('error', (err) => {
      this.error('IMAP Client Error:', err);
    });

    this.client.on('close', () => {
      this.log('Connection closed.');
      if (!this.isStopping) {
        this.scheduleReconnect();
      }
    });

    try {
      await this.client.connect();
      await this.client.mailboxOpen(this.mailboxPath);

      const status = await this.client.status(this.mailboxPath, { messages: true, uidNext: true });
      const currentMessages = status.messages || 0;
      
      // Initialize highestUid strictly based on IMAP server status
      this.highestUid = (status.uidNext && status.uidNext > 1) ? status.uidNext - 1 : 0;

      // Seed processedUids with existing messages so only brand-new ones notify
      if (currentMessages > 0) {
        try {
          const seedLock = await this.client.getMailboxLock(this.mailboxPath);
          try {
            const seedSeq = Math.max(1, currentMessages - 30);
            for await (const m of this.client.fetch({ seq: `${seedSeq}:*` }, { uid: true })) {
              this.processedUids.add(m.uid);
              if (m.uid > this.highestUid) {
                this.highestUid = m.uid;
              }
            }
          } finally {
            seedLock.release();
          }
        } catch (_) {}
      }

      this.log(`Active on "${this.mailboxPath}" (${this.isSpam ? 'SPAM/JUNK' : 'INBOX'}). Messages: ${currentMessages}, Highest UID: ${this.highestUid}`);
      this.initialSyncDone = true;

      // Handle new messages arriving via IMAP IDLE exists event
      this.client.on('exists', async () => {
        if (!this.initialSyncDone) return;
        await this.handleNewMessages();
      });

      // Maintain persistent IDLE loop (re-entering every 15 mins to keep socket alive)
      while (!this.isStopping && this.client && this.client.usable) {
        try {
          await this.client.idle();
        } catch (idleErr) {
          if (this.isStopping) break;
        }
      }
    } catch (err) {
      this.error(`Failed to watch "${this.mailboxPath}":`, err);
      if (!this.isStopping) {
        this.scheduleReconnect();
      }
    }
  }

  async handleNewMessages() {
    if (this.isHandlingNew || !this.client || !this.client.usable) return;
    this.isHandlingNew = true;

    let lock;
    try {
      lock = await this.client.getMailboxLock(this.mailboxPath);

      const targetUid = this.highestUid + 1;
      const range = `${targetUid}:*`;

      for await (const message of this.client.fetch({ uid: range }, {
        uid: true,
        envelope: true,
        source: true,
        flags: true
      })) {
        const uid = message.uid;
        if (uid <= this.highestUid || this.processedUids.has(uid)) continue;
        this.processedUids.add(uid);
        if (uid > this.highestUid) {
          this.highestUid = uid;
        }

        if (this.processedUids.size > 2000) {
          const arr = Array.from(this.processedUids);
          this.processedUids = new Set(arr.slice(arr.length - 1000));
        }

        const fromObj = (message.envelope.from && message.envelope.from[0]) || {};
        const senderName = fromObj.name
          ? `"${fromObj.name}" <${fromObj.address}>`
          : (fromObj.address || 'Unknown Sender');

        let rawSubject = message.envelope.subject || '(Không có tiêu đề)';
        let subject = this.isSpam ? `[SPAM / Thư rác] ${rawSubject}` : rawSubject;
        const receivedAt = message.envelope.date ? message.envelope.date.toISOString() : new Date().toISOString();
        const messageId = message.envelope.messageId || `uid_${uid}_${Date.now()}`;

        let snippet = '';
        if (message.source) {
          try {
            const parsed = await simpleParser(message.source);
            const textContent = (parsed.text || parsed.intro || '')
              .replace(/\s+/g, ' ')
              .trim()
              .substring(0, 300);
            snippet = this.isSpam
              ? `[Thư bị xếp vào Thư rác]: ${textContent}`
              : textContent;
          } catch (_) {
            snippet = subject;
          }
        }

        this.log(`🚨 Incoming email (${this.isSpam ? 'SPAM' : 'INBOX'}): "${subject}" from ${senderName} [UID ${uid}]`);

        await this.onNotification({
          messageId,
          recipientAccount: this.account.email,
          sender: senderName,
          subject,
          snippet,
          receivedAt,
          webUrl: this.getWebMailUrl()
        });
      }
    } catch (fetchErr) {
      this.error('Failed to fetch new message details:', fetchErr);
    } finally {
      if (lock) {
        lock.release();
      }
      this.isHandlingNew = false;
    }
  }

  getWebMailUrl() {
    if (this.account.email.includes('@gmail.com')) {
      return 'https://mail.google.com';
    } else if (this.account.email.includes('@outlook.com') || this.account.email.includes('@hotmail.com')) {
      return 'https://outlook.live.com';
    }
    return `https://${this.account.host}`;
  }

  scheduleReconnect() {
    if (this.isStopping) return;
    const delay = parseInt(process.env.RECONNECT_DELAY_MS || '10000', 10);
    this.log(`Reconnecting "${this.mailboxPath}" in ${delay / 1000}s...`);
    setTimeout(() => {
      this.connectAndListen();
    }, delay);
  }
}

class ImapAccountListener {
  constructor(accountConfig) {
    this.account = accountConfig;
    this.accountName = accountConfig.accountName || accountConfig.email;
    this.email = accountConfig.email;
    this.isStopping = false;
    this.watchers = [];
  }

  log(msg) {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] [${this.accountName}] ${msg}`);
  }

  error(msg, err) {
    const time = new Date().toLocaleTimeString();
    console.error(`[${time}] [${this.accountName}] ❌ ${msg}`, err ? (err.message || err) : '');
  }

  async start() {
    this.isStopping = false;
    await this.discoverAndStartWatchers();
  }

  async stop() {
    this.isStopping = true;
    for (const watcher of this.watchers) {
      await watcher.stop();
    }
    this.watchers = [];
    this.log('All mailbox watchers stopped.');
  }

  async discoverAndStartWatchers() {
    if (this.isStopping) return;

    this.log(`Discovering mailboxes on ${this.account.host}...`);

    let probeClient = null;
    let mailboxes = [];
    try {
      probeClient = new ImapFlow({
        host: this.account.host,
        port: this.account.port || 993,
        secure: this.account.secure !== false,
        auth: this.account.auth,
        logger: false
      });

      await probeClient.connect();
      mailboxes = await probeClient.list();
      await probeClient.logout();
      probeClient = null;
    } catch (probeErr) {
      this.error('Mailbox discovery probe failed:', probeErr);
      // Fallback: Default to INBOX
      mailboxes = [{ path: 'INBOX', specialUse: '\\Inbox' }];
    }

    if (this.isStopping) return;

    // 1. Identify primary INBOX
    let inboxPath = 'INBOX';
    const inboxBox = mailboxes.find(m => m.specialUse === '\\Inbox');
    if (inboxBox) inboxPath = inboxBox.path;

    // 2. Identify SPAM / JUNK folder
    let spamPath = null;
    const junkBox = mailboxes.find(m => m.specialUse === '\\Junk');
    if (junkBox) {
      spamPath = junkBox.path;
    } else {
      const match = mailboxes.find(m => /(spam|junk|thư rác)/i.test(m.path) || /(spam|junk|thư rác)/i.test(m.name));
      if (match) spamPath = match.path;
    }

    this.log(`Target mailboxes => INBOX: "${inboxPath}" | SPAM: "${spamPath || 'Not Found'}"`);

    // Start INBOX Watcher
    const inboxWatcher = new MailboxWatcher(
      this.account,
      inboxPath,
      false,
      `${this.accountName}/INBOX`,
      notifyNewEmail
    );
    this.watchers.push(inboxWatcher);
    inboxWatcher.start().catch(err => this.error('Inbox watcher crashed:', err));

    // Start SPAM Watcher if folder exists
    if (spamPath) {
      const spamWatcher = new MailboxWatcher(
        this.account,
        spamPath,
        true,
        `${this.accountName}/SPAM`,
        notifyNewEmail
      );
      this.watchers.push(spamWatcher);
      spamWatcher.start().catch(err => this.error('Spam watcher crashed:', err));
    }
  }
}

module.exports = {
  ImapAccountListener
};
