# Multi-Account IMAP Alert Daemon (Node.js)

Tiến trình chạy ngầm cực nhẹ (~30MB RAM, 0% CPU) giám sát **nhiều tài khoản email cùng lúc** qua giao thức **IMAP IDLE** thời gian thực (độ trễ < 1 giây), tự động gửi thông báo đến **Telegram** và bắn Push đánh thức **điện thoại Android**.

---

## 📁 Cấu trúc thư mục

```text
daemon/
├── config/
│   ├── accounts.example.json   # Tệp mẫu cấu hình các loại hòm thư
│   └── accounts.json           # Danh sách tài khoản thực tế của bạn
├── src/
│   ├── index.js                # Điểm khởi chạy chính
│   ├── imap-listener.js        # Quản lý kết nối IMAP IDLE từng tài khoản
│   ├── notifier.js             # Bắn thông báo Push & Telegram
│   └── test-connection.js      # Script kiểm tra tài khoản
├── scripts/
│   ├── install-launchd.sh      # Cài đặt tự khởi động cùng máy Mac
│   └── uninstall-launchd.sh    # Gỡ bỏ dịch vụ khởi động cùng máy
└── .env                        # Biến môi trường (Push Gateway, Telegram)
```

---

## 🛠️ Hướng dẫn thiết lập trong 2 phút

### 1. Điền danh sách tài khoản vào `config/accounts.json`

Mở file [`daemon/config/accounts.json`](file:///Users/luana/Tool/EMAIL%20MONITORING%20%26%20ALERT%20%20/daemon/config/accounts.json) và thêm danh sách các email bạn muốn theo dõi:

```json
[
  {
    "accountName": "Gmail Chính",
    "email": "user1@gmail.com",
    "host": "imap.gmail.com",
    "port": 993,
    "secure": true,
    "auth": {
      "user": "user1@gmail.com",
      "pass": "xxxx yyyy zzzz wwww"
    }
  },
  {
    "accountName": "Outlook Công Việc",
    "email": "mywork@outlook.com",
    "host": "outlook.office365.com",
    "port": 993,
    "secure": true,
    "auth": {
      "user": "mywork@outlook.com",
      "pass": "mat_khau_email"
    }
  }
]
```

> **Cách lấy Mật khẩu ứng dụng (App Password) cho Gmail:**
> 1. Truy cập [myaccount.google.com/security](https://myaccount.google.com/security).
> 2. Bật **Xác minh 2 bước** (nếu chưa bật).
> 3. Tìm mục **Mật khẩu ứng dụng** (App Passwords) -> Tạo tên "IMAP Daemon" -> Copy 16 ký tự mật mã dán vào ô `"pass"`.

---

### 2. Kiểm tra kết nối tài khoản

Trước khi chạy chính thức, hãy chạy lệnh sau để kiểm tra xem tài khoản và mật khẩu đã đúng chưa:

```bash
cd daemon
npm run test-connection
```

Nếu thành công, màn hình sẽ báo `✅ Kết nối và xác thực thành công!` cho từng tài khoản.

---

### 3. Khởi chạy thử nghiệm (Xem log trực tiếp)

```bash
npm start
```

Khi có email mới gửi vào bất kỳ tài khoản nào, màn hình sẽ hiển thị:
```text
[15:10:00] [Gmail Chính] 📬 New email detected!
[15:10:01] [Gmail Chính] 🚨 Incoming email: "Hợp đồng mới" from "Đối tác"
[Notifier] 📲 Android Push sent successfully for [user1@gmail.com]
[Notifier] 💬 Telegram alert sent for [user1@gmail.com]
```

---

### 4. Cài đặt chạy ngầm tự khởi động cùng máy Mac (Khuyên dùng)

Để script tự động chạy nền mỗi khi bạn mở máy MacBook (không cần mở cửa sổ Terminal):

```bash
./scripts/install-launchd.sh
```

- Để xem log khi chạy ngầm:
  ```bash
  tail -f daemon/logs/daemon.log
  ```
- Để gỡ bỏ chạy ngầm:
  ```bash
  ./scripts/uninstall-launchd.sh
  ```

