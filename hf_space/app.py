"""
app.py - Email Alert 24/7 Cloud Daemon (Hugging Face Gradio Space)
Hoạt động độc lập 100% miễn phí trên Hugging Face Cloud.
Giám sát đa tài khoản Gmail/Outlook/Custom qua IMAP IDLE (< 1s) cả hộp thư Đến lẫn Thư rác (Spam).
Tự động đồng bộ tài khoản từ Cloudflare Gateway được thêm qua ứng dụng Android.
"""

import imaplib
import email
from email.header import decode_header
import json
import os
import re
import select
import sys
import threading
import time
import urllib.request
import gradio as gr
from datetime import datetime

# --- CẤU HÌNH CLOUD MẶC ĐỊNH ---
GATEWAY_URL = os.getenv("PUSH_GATEWAY_URL", "https://email-alert-push-gateway.luana-email-alert.workers.dev").rstrip("/")
GATEWAY_SECRET = os.getenv("PUSH_API_SECRET", "MyPushSecret2026")

active_listeners = {}  # email -> AccountWorker
logs_buffer = []       # List of log strings
lock = threading.Lock()
start_time = time.time()
cached_endpoint = None
last_fetch_endpoint = 0

def add_log(msg):
    now = datetime.now().strftime("%H:%M:%S")
    formatted = f"[{now}] {msg}"
    print(formatted, flush=True)
    with lock:
        logs_buffer.append(formatted)
        if len(logs_buffer) > 200:
            logs_buffer.pop(0)

def decode_mime_header(header_value):
    if not header_value:
        return ""
    decoded_fragments = decode_header(header_value)
    result = []
    for fragment, charset in decoded_fragments:
        if isinstance(fragment, bytes):
            result.append(fragment.decode(charset or "utf-8", errors="replace"))
        else:
            result.append(str(fragment))
    return "".join(result)

def get_device_endpoint():
    global cached_endpoint, last_fetch_endpoint
    now = time.time()
    if cached_endpoint and (now - last_fetch_endpoint < 300):
        return cached_endpoint

    try:
        req = urllib.request.Request(
            f"{GATEWAY_URL}/v1/devices/status",
            headers={"Authorization": f"Bearer {GATEWAY_SECRET}", "User-Agent": "EmailAlertDaemon/1.0"}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            if data.get("success") and data.get("data", {}).get("endpoint"):
                cached_endpoint = data["data"]["endpoint"]
                last_fetch_endpoint = now
                return cached_endpoint
    except Exception as e:
        add_log(f"⚠️ Lỗi lấy device endpoint: {e}")
    return cached_endpoint

def send_push_notification(account_email, sender, subject, snippet, is_spam=False):
    payload = {
        "type": "NEW_EMAIL",
        "event_id": f"py_{int(time.time()*1000)}",
        "message_id": f"py_msg_{int(time.time()*1000)}",
        "recipient_account": account_email,
        "sender": sender,
        "subject": f"[SPAM / Thư rác] {subject}" if is_spam and not subject.startswith("[SPAM") else subject,
        "snippet": f"[Thư bị lọc vào Thư rác]: {snippet}" if is_spam else snippet,
        "received_at": datetime.utcnow().isoformat() + "Z",
        "gmail_url": "https://mail.google.com"
    }
    payload_bytes = json.dumps(payload).encode("utf-8")

    # 1. Direct Push via UnifiedPush / ntfy.sh
    endpoint = get_device_endpoint()
    if endpoint:
        try:
            req = urllib.request.Request(
                endpoint,
                data=payload_bytes,
                headers={"Content-Type": "application/json", "TTL": "86400", "Urgency": "high"}
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    add_log(f"📲 Chuông báo đã gửi thành công tới điện thoại cho [{account_email}]: {subject}")
                    return True
        except Exception as err:
            add_log(f"⚠️ Gửi trực tiếp qua endpoint thất bại ({err}), chuyển sang Gateway...")

    # 2. Gateway fallback
    try:
        gw_req = urllib.request.Request(
            f"{GATEWAY_URL}/v1/notifications/send",
            data=payload_bytes,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {GATEWAY_SECRET}",
                "User-Agent": "EmailAlertDaemon/1.0"
            }
        )
        with urllib.request.urlopen(gw_req, timeout=10) as resp:
            if resp.status == 200:
                add_log(f"📲 Chuông báo đã gửi qua Gateway cho [{account_email}]: {subject}")
                return True
    except Exception as gw_err:
        add_log(f"❌ Lỗi gửi chuông báo qua Gateway: {gw_err}")
    return False

class FolderWatcher(threading.Thread):
    def __init__(self, account_config, folder_name, is_spam=False):
        super().__init__(daemon=True)
        self.account = account_config
        self.folder_name = folder_name
        self.is_spam = is_spam
        self.running = True
        self.processed_uids = set()

    def run(self):
        acc_email = self.account["email"]
        add_log(f"[{acc_email}] 🟢 Bắt đầu theo dõi thư mục: {self.folder_name} ({'SPAM' if self.is_spam else 'INBOX'})")

        while self.running:
            mail = None
            try:
                mail = imaplib.IMAP4_SSL(self.account.get("host", "imap.gmail.com"), self.account.get("port", 993))
                mail.login(self.account["auth"]["user"], self.account["auth"]["pass"])
                status, count_data = mail.select(f'"{self.folder_name}"')
                if status != "OK":
                    add_log(f"[{acc_email}] Không thể mở thư mục {self.folder_name}: {status}")
                    time.sleep(15)
                    continue

                # Initialize existing count
                try:
                    last_count = int(count_data[0].decode())
                except:
                    last_count = 0

                add_log(f"[{acc_email}/{self.folder_name}] Đang chờ thư mới (Hiện có: {last_count} thư)...")

                while self.running:
                    # Enter IMAP IDLE
                    tag = mail._new_tag().decode()
                    mail.send(f"{tag} IDLE\r\n".encode())
                    mail.readline()  # "+ idling"

                    # Wait for server push notification up to 28 seconds
                    sock = mail.socket()
                    r, _, _ = select.select([sock], [], [], 28)

                    # Terminate IDLE
                    mail.send(b"DONE\r\n")
                    mail.readline()  # "OK IDLE terminated"

                    if not self.running:
                        break

                    if r:
                        # Event detected, check latest message count
                        st, new_count_data = mail.status(f'"{self.folder_name}"', '(MESSAGES)')
                        if st == "OK":
                            m = re.search(r'MESSAGES\s+(\d+)', new_count_data[0].decode())
                            new_count = int(m.group(1)) if m else last_count

                            if new_count > last_count:
                                add_log(f"[{acc_email}] 📬 Phát hiện thư mới ({last_count} ➔ {new_count}) tại {self.folder_name}!")
                                for seq in range(last_count + 1, new_count + 1):
                                    self.fetch_and_notify(mail, str(seq))
                                last_count = new_count

            except Exception as e:
                if self.running:
                    add_log(f"[{acc_email}/{self.folder_name}] Mất kết nối ({e}), tự động kết nối lại sau 10s...")
                    time.sleep(10)
            finally:
                if mail:
                    try:
                        mail.logout()
                    except:
                        pass

    def fetch_and_notify(self, mail, seq):
        try:
            status, data = mail.fetch(seq, '(RFC822)')
            if status != "OK" or not data:
                return

            for part in data:
                if isinstance(part, tuple):
                    msg = email.message_from_bytes(part[1])
                    subject = decode_mime_header(msg.get("Subject", "(Không có tiêu đề)"))
                    sender = decode_mime_header(msg.get("From", "Unknown Sender"))

                    body_text = ""
                    if msg.is_multipart():
                        for p in msg.walk():
                            if p.get_content_type() == "text/plain":
                                payload = p.get_payload(decode=True)
                                if payload:
                                    body_text = payload.decode("utf-8", errors="ignore")
                                break
                    else:
                        payload = msg.get_payload(decode=True)
                        if payload:
                            body_text = payload.decode("utf-8", errors="ignore")

                    snippet = re.sub(r'\s+', ' ', body_text).strip()[:200]
                    if not snippet:
                        snippet = subject

                    add_log(f"🚨 [{'SPAM' if self.is_spam else 'INBOX'}] Nhận thư từ {sender}: \"{subject}\"")
                    send_push_notification(self.account["email"], sender, subject, snippet, is_spam=self.is_spam)
                    break

        except Exception as ex:
            add_log(f"⚠️ Lỗi đọc nội dung thư seq={seq}: {ex}")

    def stop(self):
        self.running = False

class AccountWorker:
    def __init__(self, account_config):
        self.account = account_config
        self.watchers = []

    def start(self):
        acc_email = self.account["email"]
        add_log(f"[{acc_email}] Đang dò tìm thư mục Hộp thư đến và Thư rác...")
        try:
            mail = imaplib.IMAP4_SSL(self.account.get("host", "imap.gmail.com"), self.account.get("port", 993))
            mail.login(self.account["auth"]["user"], self.account["auth"]["pass"])
            status, folder_list = mail.list()
            mail.logout()

            inbox_name = "INBOX"
            spam_name = None

            for f in folder_list:
                decoded = f.decode("utf-8", errors="ignore")
                if "\\Junk" in decoded or re.search(r'(spam|thư rác|junk)', decoded, re.IGNORECASE):
                    parts = decoded.split(' "/" ')
                    if len(parts) == 2:
                        spam_name = parts[1].strip('"')
                        break

            # 1. Watch INBOX
            inbox_watcher = FolderWatcher(self.account, inbox_name, is_spam=False)
            inbox_watcher.start()
            self.watchers.append(inbox_watcher)

            # 2. Watch SPAM
            if spam_name:
                spam_watcher = FolderWatcher(self.account, spam_name, is_spam=True)
                spam_watcher.start()
                self.watchers.append(spam_watcher)

        except Exception as e:
            add_log(f"❌ Lỗi khởi động tài khoản [{acc_email}]: {e}")

    def stop(self):
        for w in self.watchers:
            w.stop()
        self.watchers = []

def sync_accounts_loop():
    while True:
        try:
            req = urllib.request.Request(
                f"{GATEWAY_URL}/v1/accounts?raw=true",
                headers={"Authorization": f"Bearer {GATEWAY_SECRET}", "User-Agent": "EmailAlertDaemon/1.0"}
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode())
                remote_accounts = data.get("data", [])

            valid_accounts = [
                a for a in remote_accounts
                if a.get("email") and a.get("auth", {}).get("pass")
            ]
            current_emails = {a["email"].lower(): a for a in valid_accounts}

            # Remove deleted
            for email_key in list(active_listeners.keys()):
                if email_key not in current_emails:
                    add_log(f"➖ Đã hủy theo dõi tài khoản: {email_key}")
                    active_listeners[email_key].stop()
                    del active_listeners[email_key]

            # Add new
            for email_key, acc_config in current_emails.items():
                if email_key not in active_listeners:
                    add_log(f"➕ Phát hiện tài khoản mới: [{acc_config['email']}]. Khởi động IMAP IDLE...")
                    worker = AccountWorker(acc_config)
                    worker.start()
                    active_listeners[email_key] = worker

        except Exception as err:
            add_log(f"⚠️ Lỗi đồng bộ tài khoản từ Gateway: {err}")

        time.sleep(20)

# Khởi chạy luồng đồng bộ ngầm
threading.Thread(target=sync_accounts_loop, daemon=True).start()

# --- GIAO DIỆN WEB GRADIO (HIỂN THỊ TRẠNG THÁI & TEST CHUÔNG) ---
def get_dashboard_info():
    uptime_sec = int(time.time() - start_time)
    hours, remainder = divmod(uptime_sec, 3600)
    minutes, seconds = divmod(remainder, 60)
    uptime_str = f"{hours}h {minutes}m {seconds}s"

    acc_list = list(active_listeners.keys())
    accounts_text = "\n".join([f"- 📬 **{acc}** (Đang giám sát IDLE < 1s)" for acc in acc_list]) or "Chưa có tài khoản nào được kết nối."

    status_md = f"""
### 🟢 Trạng Thái Hoạt Động (24/7 Cloud Daemon)
- **Thời gian hoạt động:** `{uptime_str}`
- **Số tài khoản đang giám sát:** `{len(acc_list)}`
- **Gateway Cloudflare:** `{GATEWAY_URL}`

#### Danh sách hộp thư đang theo dõi:
{accounts_text}
"""
    with lock:
        log_text = "\n".join(reversed(logs_buffer[-30:]))
    return status_md, log_text

def test_push_action():
    acc = list(active_listeners.keys())[0] if active_listeners else "test@example.com"
    success = send_push_notification(
        account_email=acc,
        sender="Hugging Face Cloud <test@huggingface.co>",
        subject="[Test Cloud] Chuông báo hoạt động hoàn hảo!",
        snippet="Hệ thống Email Alert đang chạy 24/7 trên Hugging Face Cloud. Bạn có thể tắt máy tính!",
        is_spam=False
    )
    if success:
        return "✅ Đã gửi chuông báo thành công về điện thoại của bạn!"
    return "❌ Gửi thất bại. Vui lòng kiểm tra lại thiết bị."

with gr.Blocks(title="Email Alert Cloud Daemon") as demo:
    gr.Markdown("# 🚀 Email Monitoring & Alert Daemon (24/7 Cloud)")
    gr.Markdown("Hệ thống tự động túc trực giám sát đa hộp thư qua **IMAP IDLE (< 1s)** và phát chuông báo tức thì về điện thoại.")

    with gr.Row():
        status_box = gr.Markdown()

    with gr.Row():
        btn_test = gr.Button("🔔 Bấm để Test Chuông Báo Trên Điện Thoại", variant="primary")
        btn_refresh = gr.Button("🔄 Làm Mới Trạng Thái")

    test_result = gr.Label(label="Kết quả Test")
    btn_test.click(fn=test_push_action, outputs=test_result)

    logs_view = gr.Textbox(label="Nhật ký hoạt động thời gian thực (Live Logs)", lines=12, max_lines=20)

    btn_refresh.click(fn=get_dashboard_info, outputs=[status_box, logs_view])
    demo.load(fn=get_dashboard_info, outputs=[status_box, logs_view])

if __name__ == "__main__":
    demo.launch(ssr_mode=False)
