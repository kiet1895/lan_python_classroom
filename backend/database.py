import threading
import time


class Database:
    def __init__(self):
        self.lock = threading.Lock()
        
        # Sức chứa của lớp học (số lượng học sinh tối đa)
        self.session_capacity = 0
        
        # Lưu trữ danh sách học sinh theo IP:
        # { ip_address: { 
        #     "name": "...", 
        #     "tabs": [ { "id": "...", "name": "...", "code": "..." } ],
        #     "active_tab_id": "...",
        #     "code": "...", 
        #     "faults": 0, 
        #     "status": "online/offline", 
        #     "hand_raised": False, 
        #     "slot_id": 1 
        # } }
        self.students = {}
        
        # Trạng thái khóa màn hình toàn bộ học sinh
        self.is_frozen = False
        
        # Code mẫu hiện tại đang được giáo viên chia sẻ
        self.code_template = ""
        self.is_sharing_template = False
        self.template_stdin = ""
        self.template_console = {"success": True, "stdout": "", "stderr": "", "exit_code": 0}
        
        # Chế độ kiểm tra (ẩn code giữa các máy con trên màn hình giáo viên)
        self.exam_mode = False

        # Danh sách IP của các học sinh được giáo viên chia sẻ bài làm
        self.shared_ips = set()

        # Đề bài hiện tại của lớp học (Hỗ trợ hỗn hợp mô tả và tệp đính kèm)
        self.assignment = {
            "type": "none",       # "none", "text", "image", "pdf"
            "content": "",        # Nội dung text hoặc URL tệp tải lên
            "filename": "",       # Tên gốc của tệp
            "description": "",    # Mô tả dạng văn bản/Markdown (có thể dán ảnh)
            "file_url": "",       # Đường dẫn tệp đính kèm
            "file_type": "none",  # Loại tệp đính kèm: "none", "image", "pdf"
            "file_name": ""       # Tên gốc của tệp đính kèm
        }

    def set_capacity(self, num):
        """Thiết lập số lượng học sinh tối đa và làm mới toàn bộ cơ sở dữ liệu."""
        with self.lock:
            self.session_capacity = num
            self.students.clear()
            self.is_frozen = False
            self.code_template = ""
            self.is_sharing_template = False
            self.template_stdin = ""
            self.template_console = {"success": True, "stdout": "", "stderr": "", "exit_code": 0}
            self.exam_mode = False
            self.shared_ips.clear()
            self.assignment = {
                "type": "none",
                "content": "",
                "filename": "",
                "description": "",
                "file_url": "",
                "file_type": "none",
                "file_name": ""
            }

    def get_capacity(self):
        """Lấy số lượng học sinh tối đa đã thiết lập."""
        with self.lock:
            return self.session_capacity

    def add_student(self, ip, name):
        """
        Đăng ký học sinh mới hoặc cập nhật học sinh cũ (nếu trùng IP).
        Trả về dictionary thông tin học sinh nếu thành công, trả về None nếu lớp đã đầy.
        """
        with self.lock:
            # 1. Nếu IP đã tồn tại, cập nhật trạng thái hoạt động và tên học sinh
            if ip in self.students:
                self.students[ip]["status"] = "online"
                if name:
                    self.students[ip]["name"] = name
                # Tự nâng cấp cấu trúc dữ liệu nếu thiếu trường
                if "tabs" not in self.students[ip]:
                    self.students[ip]["tabs"] = [
                        { "id": "tab_default", "name": "Bài 1", "code": self.students[ip].get("code", self.code_template) }
                    ]
                if "active_tab_id" not in self.students[ip]:
                    self.students[ip]["active_tab_id"] = "tab_default"
                if "feedback" not in self.students[ip]:
                    self.students[ip]["feedback"] = ""
                return self.students[ip]
            
            # 2. Kiểm tra xem lớp học đã được thiết lập chưa
            if self.session_capacity <= 0:
                return None
            
            # 3. Tìm các slot_id đã được sử dụng
            assigned_slots = {student["slot_id"] for student in self.students.values()}
            
            # 4. Tìm slot_id trống đầu tiên từ 1 đến session_capacity
            available_slot = None
            for slot_id in range(1, self.session_capacity + 1):
                if slot_id not in assigned_slots:
                    available_slot = slot_id
                    break
            
            # 5. Nếu không còn slot nào trống, từ chối kết nối (lớp đã đầy)
            if available_slot is None:
                return None
            
            self.students[ip] = {
                "name": name,
                "tabs": [
                    { "id": "tab_default", "name": "Bài 1", "code": self.code_template }
                ],
                "active_tab_id": "tab_default",
                "code": self.code_template,  # Kế thừa code mẫu hiện tại (nếu có)
                "stdin": "",
                "faults": 0,
                "status": "online",
                "hand_raised": False,
                "slot_id": available_slot,
                "feedback": ""
            }
            return self.students[ip]

    def get_student_by_ip(self, ip):
        """Lấy thông tin học sinh theo địa chỉ IP."""
        with self.lock:
            student = self.students.get(ip)
            if student:
                # Tự nâng cấp cấu trúc dữ liệu nếu thiếu trường
                if "tabs" not in student:
                    student["tabs"] = [
                        { "id": "tab_default", "name": "Bài 1", "code": student.get("code", self.code_template) }
                    ]
                if "active_tab_id" not in student:
                    student["active_tab_id"] = "tab_default"
                if "stdin" not in student:
                    student["stdin"] = ""
                if "feedback" not in student:
                    student["feedback"] = ""
            return student

    def update_code(self, ip, code):
        """Đồng bộ mã nguồn của học sinh (cho tab active hiện tại)."""
        with self.lock:
            if ip in self.students:
                self.students[ip]["code"] = code
                active_id = self.students[ip].get("active_tab_id", "tab_default")
                for t in self.students[ip]["tabs"]:
                    if t["id"] == active_id:
                        t["code"] = code
                        break
                return True
            return False

    def log_fault(self, ip):
        """Tăng số lần mất tập trung (rời tab/blur window) của học sinh."""
        with self.lock:
            if ip in self.students:
                self.students[ip]["faults"] += 1
                return self.students[ip]["faults"]
            return 0

    def set_status(self, ip, status):
        """Cập nhật trạng thái online/offline của học sinh."""
        with self.lock:
            if ip in self.students:
                self.students[ip]["status"] = status
                return True
            return False

    def set_hand_raised(self, ip, raised):
        """Cập nhật trạng thái giơ tay của học sinh."""
        with self.lock:
            if ip in self.students:
                self.students[ip]["hand_raised"] = raised
                return True
            return False

    def get_all_students(self):
        """Lấy toàn bộ danh sách học sinh hiện có (dưới dạng một bản sao để an toàn thread)."""
        with self.lock:
            # Đảm bảo tự động nâng cấp cấu trúc dữ liệu cũ
            for ip, student in self.students.items():
                if "tabs" not in student:
                    student["tabs"] = [
                        { "id": "tab_default", "name": "Bài 1", "code": student.get("code", self.code_template) }
                    ]
                if "active_tab_id" not in student:
                    student["active_tab_id"] = "tab_default"
                if "stdin" not in student:
                    student["stdin"] = ""
                if "feedback" not in student:
                    student["feedback"] = ""
            return dict(self.students)

    def reset_faults(self, ip):
        """Reset số lỗi mất tập trung của học sinh về 0."""
        with self.lock:
            if ip in self.students:
                self.students[ip]["faults"] = 0
                return True
            return False

    # --------------------------------------------------------------------------
    # QUẢN LÝ CÁC TAB CỦA HỌC SINH
    # --------------------------------------------------------------------------
    def add_student_tab(self, ip, tab_id, name, code=""):
        """Thêm tab mới cho học sinh và tự động chọn active tab mới."""
        with self.lock:
            if ip in self.students:
                # Tránh trùng tab_id
                for t in self.students[ip]["tabs"]:
                    if t["id"] == tab_id:
                        return False
                self.students[ip]["tabs"].append({
                    "id": tab_id,
                    "name": name,
                    "code": code
                })
                self.students[ip]["active_tab_id"] = tab_id
                self.students[ip]["code"] = code
                return True
            return False

    def delete_student_tab(self, ip, tab_id):
        """Xóa tab của học sinh. Không cho xóa nếu chỉ còn 1 tab."""
        with self.lock:
            if ip in self.students:
                tabs = self.students[ip]["tabs"]
                if len(tabs) <= 1:
                    return False
                
                # Tìm tab cần xóa
                target_idx = -1
                for i, t in enumerate(tabs):
                    if t["id"] == tab_id:
                        target_idx = i
                        break
                
                if target_idx != -1:
                    tabs.pop(target_idx)
                    # Nếu xóa tab đang active, chuyển active sang tab còn lại đầu tiên
                    if self.students[ip]["active_tab_id"] == tab_id:
                        self.students[ip]["active_tab_id"] = tabs[0]["id"]
                        self.students[ip]["code"] = tabs[0]["code"]
                    return True
            return False

    def rename_student_tab(self, ip, tab_id, new_name):
        """Đổi tên tab của học sinh."""
        with self.lock:
            if ip in self.students:
                for t in self.students[ip]["tabs"]:
                    if t["id"] == tab_id:
                        t["name"] = new_name
                        return True
            return False

    def switch_student_tab(self, ip, tab_id):
        """Chuyển tab hoạt động của học sinh."""
        with self.lock:
            if ip in self.students:
                for t in self.students[ip]["tabs"]:
                    if t["id"] == tab_id:
                        self.students[ip]["active_tab_id"] = tab_id
                        self.students[ip]["code"] = t["code"]
                        return True
            return False

    def update_student_code(self, ip, tab_id, code):
        """Cập nhật code của học sinh tại một tab cụ thể và lưu snapshot lịch sử."""
        with self.lock:
            if ip in self.students:
                for t in self.students[ip]["tabs"]:
                    if t["id"] == tab_id:
                        t["code"] = code
                        # Nếu tab được cập nhật là active tab, đồng bộ với trường code chính
                        if self.students[ip]["active_tab_id"] == tab_id:
                            self.students[ip]["code"] = code
                        
                        pass
                        return True
            return False

    def update_student_stdin(self, ip, stdin):
        """Cập nhật dữ liệu đầu vào (stdin) của học sinh."""
        with self.lock:
            if ip in self.students:
                self.students[ip]["stdin"] = stdin
                return True
            return False

    # --------------------------------------------------------------------------
    # QUẢN LÝ ĐỀ BÀI (ASSIGNMENT METHODS)
    # --------------------------------------------------------------------------
    def get_assignment(self):
        """Lấy thông tin đề bài hiện tại."""
        with self.lock:
            return self.assignment

    def set_assignment(self, type_, content, filename="", description="", file_url="", file_type="none", file_name=""):
        """Thiết lập đề bài mới (hỗ trợ tương thích ngược và dạng hỗn hợp)."""
        with self.lock:
            self.assignment = {
                "type": type_,
                "content": content,
                "filename": filename,
                "description": description or (content if type_ == "text" else ""),
                "file_url": file_url or (content if type_ in ("image", "pdf") else ""),
                "file_type": file_type or (type_ if type_ in ("image", "pdf") else "none"),
                "file_name": file_name or filename
            }
            return self.assignment

    def clear_assignment(self):
        """Xóa đề bài hiện tại."""
        with self.lock:
            self.assignment = {
                "type": "none",
                "content": "",
                "filename": "",
                "description": "",
                "file_url": "",
                "file_type": "none",
                "file_name": ""
            }
            return self.assignment

    def toggle_share_student(self, ip, share_status):
        """Bật/tắt trạng thái chia sẻ bài làm của học sinh cho cả lớp xem."""
        with self.lock:
            if share_status:
                self.shared_ips.add(ip)
            else:
                self.shared_ips.discard(ip)
            return list(self.shared_ips)

    def get_shared_students(self):
        """Lấy danh sách thông tin bài làm của các học sinh đang được chia sẻ."""
        with self.lock:
            result = {}
            for ip in self.shared_ips:
                if ip in self.students:
                    result[ip] = {
                        "name": self.students[ip]["name"],
                        "code": self.students[ip]["code"],
                        "slot_id": self.students[ip]["slot_id"]
                    }
            return result

    def update_student_feedback(self, ip, feedback):
        """Cập nhật nhận xét của giáo viên cho học sinh."""
        with self.lock:
            if ip in self.students:
                self.students[ip]["feedback"] = feedback
                return True
            return False

# Khởi tạo đối tượng Database duy nhất (Singleton) dùng chung cho toàn ứng dụng
db = Database()
