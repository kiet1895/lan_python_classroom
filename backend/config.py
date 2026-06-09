import os

class Config:
    """Cấu hình lõi cho hệ thống Phòng lập trình Python LAN."""
    
    # Khóa bí mật cho session Flask
    SECRET_KEY = os.environ.get('SECRET_KEY', 'supersecretkey-lan-python-classroom')
    
    # Thời gian chạy tối đa của chương trình Python (giây) để tránh vòng lặp vô hạn
    RUNTIME_TIMEOUT = int(os.environ.get('RUNTIME_TIMEOUT', 3))
    
    # Giới hạn độ dài tối đa của kết quả đầu ra (stdout/stderr) để tránh làm tràn bộ nhớ trình duyệt
    MAX_OUTPUT_LENGTH = int(os.environ.get('MAX_OUTPUT_LENGTH', 10000))
    
    # Mật khẩu đăng nhập dành cho Giáo viên
    TEACHER_PASSWORD = os.environ.get('TEACHER_PASSWORD', 'admin123')
