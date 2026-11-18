/**
 * test-connection.js - Tests IMAP connection and credentials for all accounts in config/accounts.json
 * Run with: npm run test-connection
 */

const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');

const ACCOUNTS_FILE = path.join(__dirname, '..', 'config', 'accounts.json');

async function testAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    console.error(`❌ Error: ${ACCOUNTS_FILE} not found.`);
    process.exit(1);
  }

  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  console.log(`🔍 Testing ${accounts.length} account(s) from config/accounts.json...\n`);

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    console.log(`[${i + 1}/${accounts.length}] Testing "${acc.accountName || acc.email}" (${acc.email})...`);

    if (acc.auth.pass.includes('dien_app_password_vao_day')) {
      console.log(`   ⚠️ Bỏ qua: Bạn chưa thay mật khẩu ứng dụng (App Password) trong config/accounts.json\n`);
      continue;
    }

    const client = new ImapFlow({
      host: acc.host,
      port: acc.port || 993,
      secure: acc.secure !== false,
      auth: acc.auth,
      logger: false
    });

    try {
      await client.connect();
      const status = await client.status('INBOX', { messages: true, unseen: true });
      console.log(`   ✅ Kết nối và xác thực thành công!`);
      console.log(`   📬 Tổng số thư trong INBOX: ${status.messages} (Chưa đọc: ${status.unseen || 0})\n`);
      await client.logout();
    } catch (err) {
      console.error(`   ❌ Lỗi kết nối: ${err.message}\n`);
    }
  }
}

testAccounts().catch(console.error);

