# Hướng Dẫn Sử Dụng: Phòng Lập Trình Python LAN

Dự án này là một nền tảng thực hành lập trình Python cục bộ thông qua mạng nội bộ (LAN), cho phép giáo viên quản lý, khóa màn hình, gửi bài mẫu, chạy code học sinh từ xa và thu bài nhanh chóng dưới dạng file văn bản (.txt) đã được tổng hợp.

---

## Cấu Trúc Thư Mục Dự Án

```
lan_python_classroom/
│
├── backend/
│   ├── __init__.py
│   ├── config.py               # Cấu hình lõi (Thời gian timeout, giới hạn ký tự output)
│   ├── database.py             # Bộ nhớ đệm (In-memory) lưu số lượng HS, IP, trạng thái, mã code
│   ├── code_runner.py          # Hộp cát (Sandbox) chạy code Python an toàn, chặn lệnh nguy hiểm
│   ├── socket_handlers.py      # Xử lý sự kiện Real-time (Setup lớp, Gõ code, Rời tab, Giơ tay)
│   └── app.py                  # Điểm khởi chạy Server (Flask), định nghĩa các đường dẫn (Routes)
│
├── frontend/
│   ├── templates/
│   │   ├── base.html           # Khung HTML dùng chung (Import thư viện CSS/JS)
│   │   ├── student.html        # Giao diện Học sinh (Ô CodeMirror, Nút Giơ tay, Màn hình khóa)
│   │   ├── teacher.html        # Giao diện Giáo viên (Popup tạo lớp, Lưới học sinh, Thanh công cụ)
│   │   └── teacher_login.html  # Trang đăng nhập bảo mật dành cho giáo viên
│   │
│   └── static/
│       ├── css/
│       │   └── style.css       # Định dạng lưới Grid động, Glassmorphism, cảnh báo
│       │
│       └── js/
│           ├── student.js      # Bắt sự kiện gõ code, rời tab (blur/focus), tự động kết nối lại
│           └── teacher.js      # Render lưới học sinh theo số lượng, nhận kết quả chạy code
│
├── requirements.txt            # Danh sách thư viện Python (flask, flask-socketio, eventlet)
└── README.md                   # Cẩm nang cài đặt & chạy server trên cả macOS và Windows
```

---

## Hướng Dẫn Cài Đặt Chi Tiết

Hệ thống yêu cầu cài đặt Python phiên bản **3.8 trở lên** trên máy giáo viên (máy làm server). Các máy con (học sinh) chỉ cần trình duyệt web (Chrome, CocCoc, Edge, Firefox,...) và kết nối chung một mạng nội bộ (LAN / Wi-Fi).

### Bước 1: Tải mã nguồn về máy Giáo viên
Sao chép toàn bộ thư mục `lan_python_classroom` vào máy tính giáo viên.

### Bước 2: Cài đặt thư viện phụ thuộc
Mở ứng dụng Command Prompt (Windows) hoặc Terminal (macOS) tại thư mục dự án và chạy lệnh sau để cài đặt các thư viện cần thiết:

```bash
pip install -r requirements.txt
```

---

## Hướng Dẫn Khởi Chạy Server (Máy Giáo Viên)

1. Mở Terminal / CMD tại thư mục dự án và chạy:
   ```bash
   python backend/app.py
   ```
2. Server sẽ khởi động thành công trên cổng mạng `5001` mặc định.

### Cách tìm IP mạng nội bộ của máy Giáo viên để học sinh kết nối:

Để học sinh truy cập vào server, giáo viên cần lấy địa chỉ IPv4 LAN của máy mình và gửi cho học sinh.

#### Trên macOS:
Mở Terminal và nhập lệnh:
```bash
ifconfig | grep "inet " | grep -v 127.0.0.1
```
*(Tìm địa chỉ IP có định dạng ví dụ: `192.168.1.15` hoặc `10.0.0.x`)*

#### Trên Windows:
Mở Command Prompt (CMD) và nhập lệnh:
```bash
ipconfig
```
*(Tìm dòng `IPv4 Address` thuộc card mạng đang kết nối, ví dụ: `192.168.1.100`)*

---

## Cấu Hình Tường Lửa (Firewall) Để Cho Phép Kết Nối LAN

Nếu các máy học sinh không thể truy cập vào trang web của giáo viên (báo lỗi Timeout hoặc Lỗi kết nối), nguyên nhân thông thường là do Tường lửa (Firewall) trên máy Giáo viên đang chặn cổng `5001`.

### Trên Windows:
1. Mở **Windows Defender Firewall** từ thanh tìm kiếm.
2. Chọn **Advanced settings** ở cột bên trái.
3. Chọn **Inbound Rules** -> Click **New Rule...** ở cột bên phải.
4. Chọn kiểu **Port** -> Nhấn **Next**.
5. Chọn **TCP** và tại **Specific local ports** điền: `5001` -> Nhấn **Next**.
6. Chọn **Allow the connection** -> Nhấn **Next**.
7. Tích chọn cả 3 ô (Domain, Private, Public) -> Nhấn **Next**.
8. Đặt tên rule là `Python LAN Classroom` và nhấn **Finish**.

### Trên macOS:
1. Vào **System Settings** -> **Network** -> **Firewall**.
2. Nếu Firewall đang mở, nhấp vào **Options...**.
3. Đảm bảo rằng bạn không chặn kết nối đến (`Block all incoming connections`).
4. Nhấn nút **+** và thêm ứng dụng `Python` hoặc cho phép các kết nối đến của Python Server.

---

## Hướng Dẫn Sử Dụng Các Tính Năng Trong Lớp Học

### 1. Truy cập giao diện quản lý (Giáo viên)
- Truy cập địa chỉ: `http://localhost:5001/teacher` (hoặc `http://<IP_MÁY_GV>:5001/teacher` từ máy khác).
- Mật khẩu đăng nhập mặc định: `admin123` (Có thể tùy chỉnh mật khẩu này trong file `backend/config.py`).
- Nhập sĩ số học sinh hôm nay để hệ thống tạo danh sách các ô trống (Ví dụ: Nhập `20` hệ thống sẽ render 20 slot trống có tiêu đề "Đang chờ kết nối...").

### 2. Học sinh truy cập
- Học sinh mở trình duyệt và truy cập địa chỉ: `http://<IP_MÁY_GV>:5001`.
- Nhập **Họ và tên** rồi nhấn "Vào phòng học".
- Trình duyệt học sinh tự động gán vào một slot trống trên máy giáo viên theo thứ tự đăng nhập. Nếu số lượng học sinh vượt quá sĩ số giáo viên đã cài đặt, hệ thống sẽ báo lớp đầy và chặn truy cập.

### 3. Đồng bộ hóa & Chống mất code (Resilience)
- Học sinh gõ code tới đâu, mã nguồn tự động đồng bộ theo thời gian thực về máy giáo viên mà không cần nhấn lưu.
- Nếu học sinh bị rớt mạng, tắt trình duyệt hoặc reload lại trang, hệ thống sẽ dựa vào địa chỉ IP máy học sinh để khôi phục lại toàn bộ trạng thái làm việc (họ tên, vị trí ô, lỗi mất tập trung, mã nguồn đang soạn thảo dở).

### 4. Hộp cát an toàn (Anti-Crash Sandbox)
- Giáo viên có thể ấn nút **Run Code** dưới ô của bất kỳ học sinh nào để kiểm thử chương trình của học sinh đó. Kết quả (Stdout/Stderr) sẽ hiển thị đồng thời cả trên màn hình giáo viên và bảng kết quả phía dưới trình soạn thảo của học sinh.
- Môi trường chạy code được giới hạn **3 giây** (ngăn chặn vòng lặp vô hạn `while True` làm sập máy chủ).
- Dung lượng đầu ra được giới hạn tối đa **10,000 ký tự** (ngăn chặn các lệnh in vô hạn làm đơ trình duyệt).
- Chặn các câu lệnh và thư viện nguy hiểm như thao tác mở file (`open`), chạy tập lệnh OS (`os`, `sys`, `subprocess`, `shutil`), kết nối mạng (`socket`, `urllib`, `requests`) và các hàm thực thi chuỗi động (`eval`, `exec`).

### 5. Cảnh báo mất tập trung (Tab Blur Monitoring)
- Khi học sinh rời tab học tập (chuyển sang chơi game, lướt web, mở tab khác hoặc ẩn trình duyệt), hệ thống sẽ đếm lỗi mất tập trung.
- Lỗi sẽ hiển thị lên máy giáo viên bằng **Badge màu đỏ phát sáng** để giáo viên nhắc nhở học sinh.

### 6. Khóa màn hình (Freeze Screen)
- Khi cần học sinh tập trung nghe giảng bài, giáo viên nhấn nút **Khóa Màn Hình** trên thanh công cụ.
- Màn hình của toàn bộ học sinh sẽ hiện thông báo "VUI LÒNG NHÌN LÊN BẢNG" và vô hiệu hóa hoàn toàn trình soạn thảo, ngăn học sinh tiếp tục gõ code.

### 7. Chế độ kiểm tra (Exam Mode)
- Khi giáo viên trình chiếu màn hình Dashboard lên máy chiếu của lớp, học sinh có thể nhìn trộm code của bạn khác.
- Giáo viên có thể bật **Chế độ kiểm tra** trên thanh công cụ. Code của toàn bộ học sinh trên màn hình Dashboard của giáo viên sẽ tự động bị mờ đi (blur) nhưng giáo viên vẫn có thể thấy Tên, IP, Lỗi rời tab và nút Run Code bình thường.

### 8. Xuất file Thu bài (Export)
- Kết thúc buổi học, giáo viên nhấn nút **Thu bài (Export)**.
- Hệ thống tự động tải về một tập tin văn bản `thu_bai_python_lan.txt` chứa thông tin chi tiết của tất cả học sinh (Tên, IP, Lỗi rời tab, Trạng thái online) và mã nguồn tương ứng đã sắp xếp theo thứ tự ô máy.

---

## Tác Giả Phần Mềm
Dự án được xây dựng và phát triển bởi: **Kiet1895_NGT**
