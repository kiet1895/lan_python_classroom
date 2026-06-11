from flask import request
from flask_socketio import emit, join_room, leave_room
from backend.database import db
from backend.code_runner import execute_python_code

# Quản lý ánh xạ kết nối socket để kiểm soát online/offline động
# ip_to_sids: { ip: set(sid) }
# sid_to_ip: { sid: ip }
ip_to_sids = {}
sid_to_ip = {}

# Biến toàn cục lưu trữ socketio phục vụ emit ngoài các socket handler
socketio_instance = None

def get_client_ip():
    """Lấy địa chỉ IP chính xác của client kết nối tới Socket.IO."""
    if request.headers.getlist("X-Forwarded-For"):
        ip = request.headers.getlist("X-Forwarded-For")[0].split(',')[0].strip()
    else:
        ip = request.headers.get("X-Real-IP", request.remote_addr)
    return ip

def register_socket_handlers(socketio):
    """Đăng ký các bộ xử lý sự kiện Socket.IO cho server."""
    global socketio_instance
    socketio_instance = socketio
    
    @socketio.on('connect')
    def handle_connect():
        ip = get_client_ip()
        sid = request.sid
        
        # Lưu trữ mapping socket
        sid_to_ip[sid] = ip
        if ip not in ip_to_sids:
            ip_to_sids[ip] = set()
        ip_to_sids[ip].add(sid)
        
        # Kiểm tra xem IP này đã có trong danh sách học sinh của session hiện tại chưa
        student = db.get_student_by_ip(ip)
        if student:
            # Nếu đã có, khôi phục trạng thái hoạt động trực tiếp
            db.set_status(ip, "online")
            join_room('students')
            join_room(f"student_{ip}")
            
            # Cảnh báo cho giáo viên biết học sinh kết nối lại
            emit('student_status_change', {'ip': ip, 'status': 'online'}, room='teachers')
            
            # Gửi gói dữ liệu khôi phục về máy con
            emit('restore_session', {
                'name': student['name'],
                'tabs': student.get('tabs', []),
                'active_tab_id': student.get('active_tab_id', 'tab_default'),
                'code': student['code'],
                'stdin': student.get('stdin', ''),
                'faults': student['faults'],
                'hand_raised': student['hand_raised'],
                'slot_id': student['slot_id'],
                'is_frozen': db.is_frozen,
                'assignment': db.get_assignment(),
                'is_sharing_template': db.is_sharing_template,
                'code_template': db.code_template,
                'template_stdin': db.template_stdin,
                'template_console': db.template_console
            })
            # Gửi thêm thông tin các bài đang được chia sẻ cho máy con vừa kết nối
            emit('shared_codes_update', {'shared_students': db.get_shared_students()})

    @socketio.on('disconnect')
    def handle_disconnect():
        sid = request.sid
        ip = sid_to_ip.pop(sid, None)
        
        if ip and ip in ip_to_sids:
            ip_to_sids[ip].discard(sid)
            # Nếu không còn kết nối socket nào từ IP này, đánh dấu học sinh offline
            if not ip_to_sids[ip]:
                ip_to_sids.pop(ip)
                db.set_status(ip, "offline")
                # Báo cho máy giáo viên cập nhật giao diện
                emit('student_status_change', {'ip': ip, 'status': 'offline'}, room='teachers')

    @socketio.on('register_teacher')
    def handle_register_teacher():
        """Giáo viên đăng ký kênh nhận bản tin thời gian thực."""
        join_room('teachers')
        
        # Gửi toàn bộ dữ liệu lớp học hiện tại để khởi tạo dashboard máy GV
        emit('teacher_init', {
            'capacity': db.get_capacity(),
            'students': db.get_all_students(),
            'is_frozen': db.is_frozen,
            'exam_mode': db.exam_mode,
            'code_template': db.code_template,
            'is_sharing_template': db.is_sharing_template,
            'template_stdin': db.template_stdin,
            'template_console': db.template_console,
            'shared_ips': list(db.shared_ips),
            'assignment': db.get_assignment()
        })

    @socketio.on('student_login')
    def handle_student_login(data):
        """Học sinh đăng nhập và xin cấp slot trong lớp học."""
        ip = get_client_ip()
        name = data.get('name', '').strip()
        
        if not name:
            emit('login_failed', {'message': 'Tên học sinh không được để trống.'})
            return
            
        student = db.add_student(ip, name)
        if student is None:
            emit('login_failed', {'message': 'Lớp học đã đầy hoặc chưa được giáo viên thiết lập.'})
            return
            
        # Đăng ký phòng socket
        join_room('students')
        join_room(f"student_{ip}")
        
        # Phản hồi thành công về máy con
        emit('login_success', student)
        # Gửi thêm đề bài hiện tại (nếu có)
        emit('assignment_updated', db.get_assignment())
        # Gửi trạng thái chia sẻ bài mẫu hiện tại của GV
        emit('teacher_share_template_state', {
            'share': db.is_sharing_template,
            'code': db.code_template,
            'stdin': db.template_stdin,
            'console': db.template_console
        })
        
        # Cập nhật danh sách hiển thị trên máy giáo viên
        emit('student_update', {'ip': ip, 'student': student}, room='teachers')

    @socketio.on('code_sync')
    def handle_code_sync(data):
        """Học sinh đồng bộ mã nguồn đang soạn thảo."""
        ip = get_client_ip()
        code = data.get('code', '')
        tab_id = data.get('tab_id', 'tab_default')
        
        # Nếu màn hình đang bị khóa, chặn lưu code
        if db.is_frozen:
            return
            
        if db.update_student_code(ip, tab_id, code):
            # Truyền đoạn code cập nhật tới máy giáo viên để hiển thị real-time
            emit('student_code_sync', {'ip': ip, 'tab_id': tab_id, 'code': code}, room='teachers')
            # Nếu học sinh này đang được chia sẻ và tab này là tab đang hiển thị hoạt động, phát tiếp code tới toàn bộ học sinh khác
            student = db.get_student_by_ip(ip)
            if ip in db.shared_ips and student and student.get("active_tab_id") == tab_id:
                emit('shared_code_sync', {'ip': ip, 'code': code}, room='students')

    @socketio.on('blur_event')
    def handle_blur_event():
        """Học sinh thoát khỏi tab / mất tiêu điểm (blur)."""
        ip = get_client_ip()
        student = db.get_student_by_ip(ip)
        
        # Chỉ đếm lỗi khi học sinh đã login và đang hoạt động
        if student and student['status'] == 'online':
            new_faults = db.log_fault(ip)
            # Đồng bộ lỗi lên máy giáo viên
            emit('student_fault_update', {'ip': ip, 'faults': new_faults}, room='teachers')
            # Cảnh báo trực tiếp cho học sinh
            emit('fault_warning', {'faults': new_faults})

    @socketio.on('raise_hand')
    def handle_raise_hand(data):
        """Học sinh bật/tắt trạng thái giơ tay xin trợ giúp."""
        ip = get_client_ip()
        raised = bool(data.get('raised', False))
        
        if db.set_hand_raised(ip, raised):
            # Đồng bộ trạng thái giơ tay lên máy giáo viên để nhấp nháy ô học sinh
            emit('student_hand_update', {'ip': ip, 'hand_raised': raised}, room='teachers')

    @socketio.on('setup_session')
    def handle_setup_session(data):
        """Giáo viên cấu hình sĩ số phòng học và tạo lớp mới."""
        capacity = int(data.get('capacity', 0))
        if capacity <= 0:
            emit('setup_failed', {'message': 'Số lượng học sinh thiết lập phải lớn hơn 0.'})
            return
            
        db.set_capacity(capacity)
        
        # Reset toàn bộ client đang kết nối (học sinh phải đăng nhập lại)
        emit('session_reset', {'capacity': capacity}, broadcast=True)
        
        # Cập nhật lại giao diện máy giáo viên
        emit('teacher_init', {
            'capacity': capacity,
            'students': {},
            'is_frozen': False,
            'exam_mode': False,
            'code_template': "",
            'assignment': db.get_assignment()
        }, room='teachers')

    @socketio.on('teacher_action')
    def handle_teacher_action(data):
        """Xử lý các lệnh quản trị từ xa của giáo viên."""
        action = data.get('action')
        
        if action == 'freeze_all':
            freeze = bool(data.get('freeze', False))
            db.is_frozen = freeze
            # Khóa/mở toàn bộ máy học sinh
            emit('freeze_status', {'frozen': freeze}, room='students')
            # Đồng bộ trạng thái nút bấm trên tất cả máy GV đang mở (nếu có)
            emit('freeze_status_sync', {'frozen': freeze}, room='teachers')
            
        elif action == 'push_template':
            code = data.get('code', '')
            db.code_template = code
            
            # Ghi đè code mẫu lên toàn bộ học sinh đang kết nối
            students = db.get_all_students()
            for ip in students:
                db.update_code(ip, code)
                
            emit('load_template', {'code': code}, room='students')
            
            # Làm mới giao diện máy giáo viên để hiển thị code mới đồng bộ
            emit('teacher_init', {
                'capacity': db.get_capacity(),
                'students': db.get_all_students(),
                'is_frozen': db.is_frozen,
                'exam_mode': db.exam_mode,
                'code_template': db.code_template,
                'assignment': db.get_assignment()
            }, room='teachers')
            
        elif action == 'run_student_code':
            target_ip = data.get('target_ip')
            tab_id = data.get('tab_id', 'tab_default')
            student = db.get_student_by_ip(target_ip)
            
            if student:
                code_to_run = student['code']
                for t in student.get('tabs', []):
                    if t['id'] == tab_id:
                        code_to_run = t['code']
                        break
                # Lấy dữ liệu đầu vào (stdin)
                stdin = student.get('stdin', '')
                # Gọi sandbox chạy code
                result = execute_python_code(code_to_run, stdin=stdin)
                
                # Trả kết quả chạy về cho giáo viên
                emit('run_result', {
                    'target_ip': target_ip,
                    'success': result['success'],
                    'stdout': result['stdout'],
                    'stderr': result['stderr'],
                    'exit_code': result['exit_code']
                }, room='teachers')
                
                # Đồng bộ kết quả chạy về máy học sinh tương ứng để học sinh theo dõi
                emit('student_run_result', {
                    'success': result['success'],
                    'stdout': result['stdout'],
                    'stderr': result['stderr']
                }, room=f"student_{target_ip}")
                
        elif action == 'toggle_exam_mode':
            exam_mode = bool(data.get('exam_mode', False))
            db.exam_mode = exam_mode
            # Đồng bộ trạng thái chế độ kiểm tra về máy giáo viên
            emit('exam_mode_sync', {'exam_mode': exam_mode}, room='teachers')
            
        elif action == 'toggle_share_student':
            target_ip = data.get('target_ip')
            share = bool(data.get('share', False))
            db.toggle_share_student(target_ip, share)
            
            # Cập nhật danh sách chia sẻ cho các máy học sinh
            emit('shared_codes_update', {'shared_students': db.get_shared_students()}, room='students')
            # Đồng bộ lại trạng thái nút chia sẻ trên máy giáo viên
            emit('share_status_sync', {'shared_ips': list(db.shared_ips)}, room='teachers')

    @socketio.on('student_run_own_code')
    def handle_student_run_own_code():
        """Học sinh tự chạy code của chính mình."""
        ip = get_client_ip()
        student = db.get_student_by_ip(ip)
        
        if db.is_frozen:
            emit('student_run_result', {
                'success': False,
                'stdout': '',
                'stderr': 'Thao tác bị chặn: Màn hình của bạn đang bị khóa bởi Giáo viên.'
            })
            return
            
        if student:
            active_tab_id = student.get('active_tab_id', 'tab_default')
            code_to_run = student['code']
            for t in student.get('tabs', []):
                if t['id'] == active_tab_id:
                    code_to_run = t['code']
                    break
            # Lấy dữ liệu đầu vào (stdin)
            stdin = student.get('stdin', '')
            result = execute_python_code(code_to_run, stdin=stdin)
            
            # Trả kết quả về cho học sinh tự xem
            emit('student_run_result', {
                'success': result['success'],
                'stdout': result['stdout'],
                'stderr': result['stderr']
            })
            
            # Đồng bộ kết quả này lên màn hình máy giáo viên để giáo viên theo dõi
            emit('run_result', {
                'target_ip': ip,
                'success': result['success'],
                'stdout': result['stdout'],
                'stderr': result['stderr'],
                'exit_code': result['exit_code']
            }, room='teachers')

    @socketio.on('teacher_edit_code')
    def handle_teacher_edit_code(data):
        """Giáo viên sửa trực tiếp code của học sinh từ xa."""
        target_ip = data.get('target_ip')
        code = data.get('code', '')
        tab_id = data.get('tab_id', 'tab_default')
        
        if db.update_student_code(target_ip, tab_id, code):
            # Đồng bộ code mới về máy con học sinh
            emit('teacher_code_sync', {'tab_id': tab_id, 'code': code}, room=f"student_{target_ip}")
            # Đồng bộ sang các máy giáo viên khác (nếu có) để giao diện đồng nhất
            emit('student_code_sync', {'ip': target_ip, 'tab_id': tab_id, 'code': code}, room='teachers', include_self=False)
            
            # Nếu học sinh này đang được chia sẻ và tab đang sửa là active tab của học sinh đó, đồng bộ tới cả lớp
            student = db.get_student_by_ip(target_ip)
            if target_ip in db.shared_ips and student and student.get("active_tab_id") == tab_id:
                emit('shared_code_sync', {'ip': target_ip, 'code': code}, room='students')

    @socketio.on('stdin_sync')
    def handle_stdin_sync(data):
        """Học sinh đồng bộ dữ liệu đầu vào (stdin)."""
        ip = get_client_ip()
        stdin = data.get('stdin', '')
        if db.update_student_stdin(ip, stdin):
            # Đồng bộ sang máy giáo viên
            emit('student_stdin_sync', {'ip': ip, 'stdin': stdin}, room='teachers')

    @socketio.on('teacher_edit_stdin')
    def handle_teacher_edit_stdin(data):
        """Giáo viên sửa trực tiếp dữ liệu đầu vào (stdin) của học sinh từ xa."""
        target_ip = data.get('target_ip')
        stdin = data.get('stdin', '')
        if db.update_student_stdin(target_ip, stdin):
            # Đồng bộ về máy học sinh
            emit('teacher_stdin_sync', {'stdin': stdin}, room=f"student_{target_ip}")
            # Đồng bộ sang các máy giáo viên khác (nếu có) để giao diện đồng nhất
            emit('student_stdin_sync', {'ip': target_ip, 'stdin': stdin}, room='teachers', include_self=False)

    # --------------------------------------------------------------------------
    # CÁC SỰ KIỆN TƯƠNG TÁC TẬP TIN / TAB CỦA HỌC SINH
    # --------------------------------------------------------------------------
    @socketio.on('student_create_tab')
    def handle_student_create_tab(data):
        """Học sinh tạo tab bài tập mới."""
        ip = get_client_ip()
        tab_id = data.get('tab_id')
        name = data.get('name')
        
        if db.is_frozen:
            return
            
        if db.add_student_tab(ip, tab_id, name):
            # Cập nhật danh sách hiển thị trên máy giáo viên
            emit('student_update', {'ip': ip, 'student': db.get_student_by_ip(ip)}, room='teachers')

    @socketio.on('student_delete_tab')
    def handle_student_delete_tab(data):
        """Học sinh đóng tab bài tập."""
        ip = get_client_ip()
        tab_id = data.get('tab_id')
        
        if db.is_frozen:
            return
            
        if db.delete_student_tab(ip, tab_id):
            student = db.get_student_by_ip(ip)
            # Cập nhật máy giáo viên
            emit('student_update', {'ip': ip, 'student': student}, room='teachers')
            
            # Khôi phục trạng thái máy học sinh để đồng bộ tab active mới (do tab cũ bị xóa)
            emit('restore_session', {
                'name': student['name'],
                'tabs': student['tabs'],
                'active_tab_id': student['active_tab_id'],
                'code': student['code'],
                'faults': student['faults'],
                'hand_raised': student['hand_raised'],
                'slot_id': student['slot_id'],
                'is_frozen': db.is_frozen,
                'assignment': db.get_assignment()
            })

    @socketio.on('student_rename_tab')
    def handle_student_rename_tab(data):
        """Học sinh đổi tên tab bài tập."""
        ip = get_client_ip()
        tab_id = data.get('tab_id')
        name = data.get('name')
        
        if db.is_frozen:
            return
            
        if db.rename_student_tab(ip, tab_id, name):
            emit('student_update', {'ip': ip, 'student': db.get_student_by_ip(ip)}, room='teachers')

    @socketio.on('student_switch_tab')
    def handle_student_switch_tab(data):
        """Học sinh chuyển đổi tab đang làm việc."""
        ip = get_client_ip()
        tab_id = data.get('tab_id')
        
        if db.is_frozen:
            return
            
        if db.switch_student_tab(ip, tab_id):
            # Cập nhật máy giáo viên
            emit('student_update', {'ip': ip, 'student': db.get_student_by_ip(ip)}, room='teachers')
            
            # Nếu học sinh này đang được chia sẻ, phát lại code của active tab mới tới cả lớp
            if ip in db.shared_ips:
                student = db.get_student_by_ip(ip)
                emit('shared_code_sync', {'ip': ip, 'code': student['code']}, room='students')

    @socketio.on('toggle_share_template_live')
    def handle_toggle_share_template_live(data):
        """Giáo viên bật/tắt chia sẻ trực tiếp code mẫu."""
        share = bool(data.get('share', False))
        db.is_sharing_template = share
        emit('teacher_share_template_state', {
            'share': share,
            'code': db.code_template,
            'stdin': db.template_stdin,
            'console': db.template_console
        }, broadcast=True)

    @socketio.on('teacher_template_sync')
    def handle_teacher_template_sync(data):
        """Giáo viên gõ thay đổi code mẫu."""
        code = data.get('code', '')
        db.code_template = code
        emit('teacher_template_code_sync', {'code': code}, broadcast=True, include_self=False)

    @socketio.on('teacher_template_stdin_sync')
    def handle_teacher_template_stdin_sync(data):
        """Giáo viên thay đổi ô input của code mẫu."""
        stdin = data.get('stdin', '')
        db.template_stdin = stdin
        emit('teacher_template_stdin_sync', {'stdin': stdin}, broadcast=True, include_self=False)

    @socketio.on('teacher_run_template_code')
    def handle_teacher_run_template_code(data=None):
        """Giáo viên chạy thử code mẫu."""
        if data:
            if 'code' in data:
                db.code_template = data['code']
            if 'stdin' in data:
                db.template_stdin = data['stdin']
                
        code = db.code_template
        stdin = db.template_stdin
        result = execute_python_code(code, stdin=stdin)
        
        db.template_console = {
            'success': result['success'],
            'stdout': result['stdout'],
            'stderr': result['stderr'],
            'exit_code': result['exit_code']
        }
        
        emit('teacher_template_run_result', db.template_console, broadcast=True)

    @socketio.on('student_run_teacher_code')
    def handle_student_run_teacher_code(data):
        """Học sinh tự chạy code mẫu của Giáo viên với input của chính học sinh."""
        ip = get_client_ip()
        
        if db.is_frozen:
            emit('student_run_teacher_code_result', {
                'success': False,
                'stdout': '',
                'stderr': 'Thao tác bị chặn: Màn hình của bạn đang bị khóa bởi Giáo viên.'
            })
            return
            
        stdin = data.get('stdin', '')
        code = db.code_template
        result = execute_python_code(code, stdin=stdin)
        
        emit('student_run_teacher_code_result', {
            'success': result['success'],
            'stdout': result['stdout'],
            'stderr': result['stderr']
        })

