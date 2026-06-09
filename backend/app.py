import os
import sys
import time
import socket
from werkzeug.utils import secure_filename

def get_local_ip():
    """Tự động xác định địa chỉ IP mạng nội bộ (LAN)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip

# Thêm thư mục gốc của dự án vào sys.path để hỗ trợ chạy trực tiếp script
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import Flask, render_template, request, session, redirect, url_for, Response
from flask_socketio import SocketIO
from backend.config import Config
from backend.database import db
from backend.socket_handlers import register_socket_handlers, get_client_ip

# Xác định đường dẫn tương đối tới frontend
base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
template_dir = os.path.join(base_dir, 'frontend', 'templates')
static_dir = os.path.join(base_dir, 'frontend', 'static')

# Khởi tạo Flask
app = Flask(
    __name__,
    template_folder=template_dir,
    static_folder=static_dir
)
app.config.from_object(Config)

# Cấu hình thư mục tải lên đề bài (static/uploads)
upload_dir = os.path.join(static_dir, 'uploads')
os.makedirs(upload_dir, exist_ok=True)
app.config['UPLOAD_FOLDER'] = upload_dir
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # Giới hạn 16MB

# Khởi tạo SocketIO với eventlet (hoặc gevent/threading tuỳ môi trường)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# Đăng ký các sự kiện socket
register_socket_handlers(socketio)

@app.route('/')
def student_index():
    """Giao diện máy học sinh."""
    ip = get_client_ip()
    student = db.get_student_by_ip(ip)
    capacity = db.get_capacity()
    
    # Nếu giáo viên chưa thiết lập lớp học
    if capacity <= 0:
        return render_template('student.html', no_session=True)
        
    return render_template(
        'student.html',
        student=student,
        is_frozen=db.is_frozen,
        no_session=False,
        assignment=db.get_assignment()
    )

@app.route('/teacher', methods=['GET', 'POST'])
def teacher_index():
    """Giao diện Dashboard quản lý của giáo viên."""
    if not session.get('teacher_logged_in'):
        return redirect(url_for('teacher_login'))
        
    capacity = db.get_capacity()
    local_ip = get_local_ip()
    port = int(os.environ.get('PORT', 5001))
    student_url = f"http://{local_ip}:{port}"
    return render_template('teacher.html', capacity=capacity, student_url=student_url)

@app.route('/teacher_login', methods=['GET', 'POST'])
def teacher_login():
    """Trang đăng nhập bảo mật dành cho giáo viên."""
    if session.get('teacher_logged_in'):
        return redirect(url_for('teacher_index'))
        
    error = None
    if request.method == 'POST':
        password = request.form.get('password')
        if password == Config.TEACHER_PASSWORD:
            session['teacher_logged_in'] = True
            return redirect(url_for('teacher_index'))
        else:
            error = "Mật khẩu quản trị viên không chính xác."
            
    return render_template('teacher_login.html', error=error)

@app.route('/teacher_logout')
def teacher_logout():
    """Đăng xuất tài khoản giáo viên."""
    session.pop('teacher_logged_in', None)
    return redirect(url_for('teacher_login'))

@app.route('/export')
def export_code():
    """Xuất mã nguồn của toàn bộ lớp học thành tập tin text (.txt)."""
    if not session.get('teacher_logged_in'):
        return redirect(url_for('teacher_login'))
        
    report = []
    report.append("=" * 60 + "\n")
    report.append("          BÁO CÁO THU BÀI LÀM LỚP HỌC PYTHON LAN\n")
    report.append("=" * 60 + "\n\n")
    
    students = db.get_all_students()
    # Sắp xếp danh sách học sinh theo Slot ID tăng dần
    sorted_students = sorted(students.items(), key=lambda x: x[1].get('slot_id', 999))
    
    for ip, info in sorted_students:
        report.append("-" * 60)
        report.append(f" HỌC SINH: {info['name']}")
        report.append(f" Địa chỉ IP: {ip}")
        report.append(f" Slot máy: Ô số {info['slot_id']}")
        report.append(f" Số lỗi rời tab/mất tập trung: {info['faults']}")
        report.append(f" Trạng thái: {info['status'].upper()}")
        report.append("-" * 60)
        
        tabs = info.get("tabs", [])
        if tabs:
            for tab in tabs:
                report.append(f"=== TAB: {tab['name']} (ID: {tab['id']}) ===")
                report.append(tab.get('code', ''))
                report.append("-" * 40)
        else:
            report.append("MÃ NGUỒN:")
            report.append(info.get('code', ''))
            
        report.append("-" * 60 + "\n\n")
        
    file_content = "\n".join(report)
    
    return Response(
        file_content,
        mimetype="text/plain",
        headers={"Content-disposition": "attachment; filename=thu_bai_python_lan.txt"}
    )

@app.route('/teacher/set_assignment', methods=['POST'])
@app.route('/teacher/set_assignment', methods=['POST'])
def set_assignment():
    """Giáo viên đăng tải đề bài mới."""
    if not session.get('teacher_logged_in'):
        return {"success": False, "message": "Unauthorized"}, 401
    
    # Lấy mô tả dạng văn bản/Markdown
    description = request.form.get('description') or request.form.get('content') or ""
    
    file_url = ""
    file_type = "none"
    file_name = ""
    
    # Kiểm tra xem có đính kèm tệp hình ảnh hoặc PDF hay không
    if 'file' in request.files:
        file = request.files['file']
        if file.filename != '':
            orig_filename = file.filename
            ext = os.path.splitext(orig_filename)[1].lower()
            if ext in ('.png', '.jpg', '.jpeg', '.gif'):
                file_type = "image"
            elif ext == '.pdf':
                file_type = "pdf"
            else:
                return {"success": False, "message": "Định dạng tệp đính kèm không hợp lệ. Chỉ chấp nhận Ảnh hoặc PDF."}, 400
                
            safe_name = secure_filename(orig_filename)
            timestamped_name = f"{int(time.time())}_{safe_name}"
            filepath = os.path.join(app.config['UPLOAD_FOLDER'], timestamped_name)
            file.save(filepath)
            
            file_url = f"/static/uploads/{timestamped_name}"
            file_name = orig_filename
            
    # Tương thích ngược với các bản tin cũ
    legacy_type = "none"
    legacy_content = ""
    if file_type != "none":
        legacy_type = file_type
        legacy_content = file_url
    elif description:
        legacy_type = "text"
        legacy_content = description
        
    db.set_assignment(
        type_=legacy_type,
        content=legacy_content,
        filename=file_name,
        description=description,
        file_url=file_url,
        file_type=file_type,
        file_name=file_name
    )
    
    socketio.emit('assignment_updated', db.get_assignment())
    return {"success": True, "assignment": db.get_assignment()}

@app.route('/teacher/upload_image', methods=['POST'])
def upload_image():
    """Nhận hình ảnh được giáo viên dán trực tiếp từ clipboard."""
    if not session.get('teacher_logged_in'):
        return {"success": False, "message": "Unauthorized"}, 401
        
    if 'file' not in request.files:
        return {"success": False, "message": "Không tìm thấy tệp ảnh tải lên."}, 400
        
    file = request.files['file']
    if file.filename == '':
        return {"success": False, "message": "Chưa chọn tệp ảnh."}, 400
        
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ('.png', '.jpg', '.jpeg', '.gif'):
        return {"success": False, "message": "Định dạng ảnh không hợp lệ (Chỉ hỗ trợ PNG, JPG, JPEG, GIF)."}, 400
        
    safe_name = secure_filename(file.filename)
    timestamped_name = f"paste_{int(time.time())}_{safe_name}"
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], timestamped_name)
    file.save(filepath)
    
    url = f"/static/uploads/{timestamped_name}"
    return {"success": True, "url": url}

@app.route('/teacher/clear_assignment', methods=['POST'])
def clear_assignment():
    """Giáo viên xóa đề bài hiện tại."""
    if not session.get('teacher_logged_in'):
        return {"success": False, "message": "Unauthorized"}, 401
    
    db.clear_assignment()
    socketio.emit('assignment_updated', db.get_assignment())
    return {"success": True}

@app.route('/assignment/view')
def view_assignment_page():
    """Giao diện xem đề bài riêng biệt toàn màn hình của học sinh."""
    assignment = db.get_assignment()
    return render_template('assignment_view.html', assignment=assignment)

if __name__ == '__main__':
    # Chạy server ở host 0.0.0.0 để các máy trong mạng LAN có thể kết nối
    # Sử dụng cổng 5001 mặc định để tránh xung đột với cổng 5000 (AirPlay Receiver trên macOS)
    port = int(os.environ.get('PORT', 5001))
    debug_mode = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    socketio.run(app, host='0.0.0.0', port=port, debug=debug_mode)
