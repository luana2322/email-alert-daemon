/**
 * index.js - Multi-Account IMAP Alert Daemon Entrypoint
 * Monitors multiple email accounts simultaneously using IMAP IDLE.
 * Automatically synchronizes account list from Cloudflare Gateway (added via Android App).
 * Includes lightweight HTTP health check on port 7860 for Cloud/Hugging Face 24/7 uptime.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { ImapAccountListener } = require('./imap-listener');

const DEFAULT_GATEWAY_URL = 'https://email-alert-push-gateway.luana-email-alert.workers.dev';
const DEFAULT_GATEWAY_SECRET = 'MyPushSecret2026';

const ACCOUNTS_FILE = path.join(__dirname, '..', 'config', 'accounts.json');
const activeListeners = new Map(); // email.toLowerCase() -> ImapAccountListener

function loadLocalAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  try {
    const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
    const accounts = JSON.parse(raw);
    return Array.isArray(accounts) ? accounts : [];
  } catch (err) {
    return [];
  }
}

async function fetchRemoteAccounts() {
  const gatewayUrl = (process.env.PUSH_GATEWAY_URL || DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
  const secret = process.env.PUSH_API_SECRET || DEFAULT_GATEWAY_SECRET;
  if (!gatewayUrl) return null;

  try {
    const headers = secret ? { 'Authorization': `Bearer ${secret}` } : {};
    const res = await fetch(`${gatewayUrl}/v1/accounts?raw=true`, { headers });
    if (res.ok) {
      const json = await res.json();
      if (json.success && Array.isArray(json.data) && json.data.length > 0) {
        return json.data;
      }
    }
  } catch (err) {
    // Gateway temporarily unreachable, fallback to local
  }
  return null;
}

async function syncAccounts() {
  let accounts = await fetchRemoteAccounts();
  const source = accounts ? 'Cloudflare Gateway' : 'local accounts.json';
  if (!accounts || accounts.length === 0) {
    accounts = loadLocalAccounts();
  }

  const valid = accounts.filter(acc => {
    return acc.email && acc.auth && acc.auth.pass && !acc.auth.pass.includes('dien_app_password_vao_day');
  });

  const currentEmails = new Set(valid.map(a => a.email.toLowerCase()));

  // 1. Remove listeners for deleted accounts
  for (const [email, listener] of activeListeners.entries()) {
    if (!currentEmails.has(email)) {
      console.log(`[Daemon] ➖ Account removed: ${email}. Stopping listener...`);
      await listener.stop();
      activeListeners.delete(email);
    }
  }

  // 2. Add listeners for newly added accounts
  for (const acc of valid) {
    const key = acc.email.toLowerCase();
    if (!activeListeners.has(key)) {
      console.log(`[Daemon] ➕ New account detected (${source}): [${acc.email}]. Starting IMAP IDLE...`);
      const listener = new ImapAccountListener(acc);
      activeListeners.set(key, listener);
      listener.start();
    }
  }
}

function startHealthCheckServer() {
  const PORT = parseInt(process.env.PORT || '7860', 10);
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      status: 'ONLINE',
      service: 'Email Alert IMAP Daemon',
      uptimeSeconds: Math.floor(process.uptime()),
      monitoredAccountsCount: activeListeners.size,
      monitoredAccounts: Array.from(activeListeners.keys()),
      timestamp: new Date().toISOString()
    }, null, 2));
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Daemon] 🌐 Cloud Healthcheck server listening on http://0.0.0.0:${PORT}`);
  });

  // Self-keepalive for Render.com free tier (pings public URL every 5 mins to prevent sleep)
  const renderUrl = process.env.RENDER_EXTERNAL_URL || 'https://email-alert-daemon.onrender.com';
  console.log(`[Daemon] 🔄 Render.com Keep-Alive active for: ${renderUrl}`);
  setInterval(async () => {
    try {
      const pingRes = await fetch(renderUrl);
      if (pingRes.ok) {
        // Keeps external router session active
      }
    } catch (_) {}
  }, 5 * 60 * 1000);
}

async function main() {
  const gatewayUrl = (process.env.PUSH_GATEWAY_URL || DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
  console.log('================================================================');
  console.log('   🚀 EMAIL MONITORING & ALERT DAEMON (MULTI-ACCOUNT IMAP IDLE) ');
  console.log('================================================================');
  console.log(`Push Gateway : ${gatewayUrl}`);
  console.log(`Auto Sync    : Every 20s from Gateway (Remote Mobile App Management)`);
  console.log('----------------------------------------------------------------');

  // Start HTTP healthcheck server for Hugging Face / Cloud containers
  startHealthCheckServer();

  // Initial sync
  await syncAccounts();

  // Periodic poll for account updates added from Android app
  setInterval(syncAccounts, 20000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[Daemon] Gracefully shutting down listeners...');
    for (const [_, listener] of activeListeners.entries()) {
      await listener.stop();
    }
    console.log('[Daemon] All connections closed. Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[Daemon] Fatal error:', err);
  process.exit(1);
});
