#!/bin/bash
# Tự động di chuyển vào thư mục chứa file này
cd "$(dirname "$0")"

echo "=================================================="
echo "   ĐANG KHỞI CHẠY PHÒNG LẬP TRÌNH PYTHON LAN"
echo "=================================================="
echo "Vui lòng giữ cửa sổ Terminal này mở trong lúc dạy học."
echo "Địa chỉ truy cập máy giáo viên: http://localhost:5001/teacher"
echo "--------------------------------------------------"

# Kiểm tra và tự động cài đặt thư viện nếu bị thiếu
python3 -c "import flask, flask_socketio, eventlet" 2>/dev/null
if [ $? -ne 0 ]; then
    echo "Phát hiện thiếu thư viện hệ thống. Đang tự động cài đặt..."
    python3 -m pip install -r requirements.txt
    if [ $? -ne 0 ]; then
        echo "LỖI: Không thể cài đặt các thư viện tự động."
        echo "Vui lòng chạy lệnh: pip3 install -r requirements.txt để xử lý."
        echo "Nhấn phím bất kỳ để đóng..."
        read -n 1
        exit 1
    fi
    echo "Cài đặt thư viện thành công!"
    echo "--------------------------------------------------"
fi

# Chạy chương trình chính
python3 backend/app.py

# Tránh đóng cửa sổ lập tức nếu có lỗi xảy ra để giáo viên dễ xem log
echo ""
echo "Máy chủ đã dừng lại."
echo "Nhấn phím bất kỳ để đóng cửa sổ..."
read -n 1
