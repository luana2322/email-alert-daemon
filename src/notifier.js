/**
 * notifier.js - Dispatches alert notifications to Cloudflare Worker Gateway and Telegram.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PUSH_GATEWAY_URL = (process.env.PUSH_GATEWAY_URL || 'https://email-alert-push-gateway.luana-email-alert.workers.dev').replace(/\/+$/, '');
const PUSH_API_SECRET = process.env.PUSH_API_SECRET || 'MyPushSecret2026';

let TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
let TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Fallback to config/telegram.json if environment variables not set
try {
  const teleConfigFile = path.join(__dirname, '..', 'config', 'telegram.json');
  if (fs.existsSync(teleConfigFile)) {
    const teleConfig = JSON.parse(fs.readFileSync(teleConfigFile, 'utf8'));
    if (!TELEGRAM_BOT_TOKEN && teleConfig.botToken) {
      TELEGRAM_BOT_TOKEN = teleConfig.botToken;
    }
    if (!TELEGRAM_CHAT_ID && teleConfig.chatId) {
      TELEGRAM_CHAT_ID = String(teleConfig.chatId);
    }
  }
} catch (_) {}

/**
 * Escape HTML for Telegram
 */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

let cachedDeviceEndpoint = null;
let lastFetchEndpointTime = 0;

async function getDeviceEndpoint() {
  const now = Date.now();
  if (cachedDeviceEndpoint && (now - lastFetchEndpointTime < 300000)) {
    return cachedDeviceEndpoint;
  }
  if (!PUSH_GATEWAY_URL) return null;
  try {
    const headers = PUSH_API_SECRET ? { 'Authorization': `Bearer ${PUSH_API_SECRET}` } : {};
    const res = await fetch(`${PUSH_GATEWAY_URL}/v1/devices/status`, { headers });
    if (res.ok) {
      const json = await res.json();
      if (json.success && json.data && json.data.endpoint) {
        cachedDeviceEndpoint = json.data.endpoint;
        lastFetchEndpointTime = now;
        return cachedDeviceEndpoint;
      }
    }
  } catch (_) {}
  return cachedDeviceEndpoint;
}

/**
 * Send Push alert to Android device via Direct Push or Cloudflare Worker Gateway
 */
async function sendPushAlert(emailData) {
  const payload = {
    type: 'NEW_EMAIL',
    event_id: `imap_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    message_id: emailData.messageId || `msg_${Date.now()}`,
    recipient_account: emailData.recipientAccount,
    sender: emailData.sender,
    subject: emailData.subject,
    snippet: (emailData.snippet || '').substring(0, 300),
    received_at: emailData.receivedAt || new Date().toISOString(),
    gmail_url: emailData.webUrl || 'https://mail.google.com'
  };

  // 1. Direct delivery if device endpoint is known (sub-100ms latency, zero proxy overhead)
  const directEndpoint = await getDeviceEndpoint();
  if (directEndpoint) {
    try {
      // Strip ?up=1 so ntfy caches the notification if device was momentarily asleep, avoiding HTTP 507
      const cleanEndpoint = directEndpoint.replace(/[?&]up=1/, '');
      const isSpam = (emailData.subject || '').toUpperCase().includes('[SPAM');
      const directRes = await fetch(cleanEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Title': `🚨 [${emailData.recipientAccount || 'Mail'}] ${emailData.sender}`,
          'Priority': 'urgent',
          'Tags': isSpam ? 'warning,skull' : 'incoming_envelope,bell',
          'Click': emailData.webUrl || 'https://mail.google.com',
          'TTL': '86400',
          'Urgency': 'high'
        },
        body: JSON.stringify(payload)
      });
      if (directRes.ok) {
        console.log(`[Notifier] 📲 Android Push delivered directly to phone for [${emailData.recipientAccount}] "${emailData.subject}"`);
        return;
      } else {
        const statusText = await directRes.text();
        console.warn(`[Notifier] Direct delivery returned ${directRes.status}: ${statusText}. Trying gateway...`);
      }
    } catch (directErr) {
      console.warn(`[Notifier] Direct delivery failed: ${directErr.message}. Trying gateway...`);
    }
  }

  // 2. Gateway delivery fallback
  if (!PUSH_GATEWAY_URL) return;

  const endpoint = `${PUSH_GATEWAY_URL}/v1/notifications/send`;
  const headers = {
    'Content-Type': 'application/json'
  };
  if (PUSH_API_SECRET) {
    headers['Authorization'] = `Bearer ${PUSH_API_SECRET}`;
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      console.log(`[Notifier] 📲 Android Push sent via Gateway for [${emailData.recipientAccount}] "${emailData.subject}"`);
    } else {
      const errText = await res.text();
      console.error(`[Notifier] ❌ Gateway error (${res.status}): ${errText}`);
    }
  } catch (err) {
    console.error(`[Notifier] ❌ Gateway network error: ${err.message}`);
  }
}

const sentMessageCache = new Map(); // messageId -> timestamp
const telegramQueue = [];
let isProcessingTelegram = false;

function cleanSentCache() {
  const now = Date.now();
  for (const [id, time] of sentMessageCache.entries()) {
    if (now - time > 86400000) { // older than 24h
      sentMessageCache.delete(id);
    }
  }
}

function getTelegramConfig() {
  let token = process.env.TELEGRAM_BOT_TOKEN || '';
  let chat = process.env.TELEGRAM_CHAT_ID || '';
  try {
    const teleConfigFile = path.join(__dirname, '..', 'config', 'telegram.json');
    if (fs.existsSync(teleConfigFile)) {
      const teleConfig = JSON.parse(fs.readFileSync(teleConfigFile, 'utf8'));
      if (!token && teleConfig.botToken) token = teleConfig.botToken;
      if (!chat && teleConfig.chatId) chat = String(teleConfig.chatId);
    }
  } catch (_) {}
  return { token, chat };
}

/**
 * Send individual Telegram notification with 429 auto-retry
 */
async function sendTelegramAlertDirect(emailData) {
  const { token, chat } = getTelegramConfig();
  if (!token || !chat) {
    console.warn(`[Notifier] ⚠️ Telegram notification skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing.`);
    return;
  }

  const dateStr = emailData.receivedAt ? new Date(emailData.receivedAt).toLocaleString('vi-VN') : new Date().toLocaleString('vi-VN');

  const lines = [
    '🚨 <b>MAIL ALERT (IMAP IDLE)</b>',
    '',
    `📬 <b>Hộp thư nhận:</b> <code>${escapeHtml(emailData.recipientAccount)}</code>`,
    `👤 <b>Người gửi:</b> ${escapeHtml(emailData.sender || 'Không rõ')}`,
    `📌 <b>Tiêu đề:</b> ${escapeHtml(emailData.subject || '(Không có tiêu đề)')}`,
    '',
    '📝 <b>Nội dung tóm tắt:</b>',
    `<i>${escapeHtml((emailData.snippet || '').substring(0, 400))}</i>`,
    '',
    `⏰ <b>Thời gian:</b> ${dateStr}`
  ];

  const text = lines.join('\n');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chat,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });

      if (res.ok) {
        console.log(`[Notifier] 💬 Telegram alert sent for [${emailData.recipientAccount}]`);
        return;
      }

      const errText = await res.text();
      if (res.status === 429) {
        let retrySec = 3;
        try {
          const json = JSON.parse(errText);
          if (json?.parameters?.retry_after) retrySec = json.parameters.retry_after;
        } catch (_) {}
        console.warn(`[Notifier] ⏳ Telegram rate limited (429). Pausing for ${retrySec}s before attempt ${attempt + 1}...`);
        await new Promise(r => setTimeout(r, (retrySec + 1) * 1000));
        continue;
      }

      console.error(`[Notifier] ❌ Telegram API error (${res.status}): ${errText}`);
      return;
    } catch (err) {
      console.error(`[Notifier] ❌ Telegram network error (attempt ${attempt}): ${err.message}`);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
}

/**
 * Sequential FIFO worker to deliver Telegram messages smoothly with no rate-limit congestion
 */
async function processTelegramQueue() {
  if (isProcessingTelegram) return;
  isProcessingTelegram = true;

  while (telegramQueue.length > 0) {
    const item = telegramQueue.shift();
    try {
      await sendTelegramAlertDirect(item);
    } catch (e) {
      console.error('[Notifier] Error in Telegram queue processing:', e.message);
    }
    // Throttle 500ms between messages to comply with Telegram Bot limits (30 msg/sec global, 1 msg/sec/chat)
    if (telegramQueue.length > 0) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  isProcessingTelegram = false;
}

function enqueueTelegramAlert(emailData) {
  telegramQueue.push(emailData);
  processTelegramQueue();
}

/**
 * Dispatch alert to both channels with deduplication
 */
async function notifyNewEmail(emailData) {
  cleanSentCache();
  const dedupKey = `${emailData.recipientAccount}:${emailData.messageId || emailData.subject}`;
  if (sentMessageCache.has(dedupKey)) {
    console.log(`[Notifier] 🔁 Duplicate alert suppressed for [${emailData.recipientAccount}] "${emailData.subject}"`);
    return;
  }
  sentMessageCache.set(dedupKey, Date.now());

  // 1. Android Push (instant, async)
  sendPushAlert(emailData).catch(e => console.error('[Notifier] Push error:', e.message));

  // 2. Telegram Alert (queued & throttled)
  enqueueTelegramAlert(emailData);
}

module.exports = {
  notifyNewEmail
};

