import re
import subprocess
import sys
import tempfile
import os
import threading
from backend.config import Config

def is_safe_code(code_string):
    """
    Kiểm tra mã nguồn xem có chứa các câu lệnh nguy hiểm hoặc cố tình bypass bảo mật không.
    Trả về (True, "") nếu an toàn, (False, "Thông báo lỗi") nếu không an toàn.
    """
    # 1. Chặn các import thư viện hệ thống nguy hiểm
    # os, sys, subprocess, shutil, socket, urllib, requests, pty, ctypes, pathlib, platform, builtins
    import_pattern = r'\b(import|from)\s+(os|sys|subprocess|shutil|socket|urllib|requests|pty|ctypes|builtins|pathlib|platform|importlib|gc)\b'
    if re.search(import_pattern, code_string):
        return False, "Mã nguồn chứa thư viện hệ thống bị cấm (os, sys, subprocess, open,...) vì lý do an toàn."
        
    # 2. Chặn các hàm xây dựng sẵn (Built-in) có nguy cơ phá hoại hoặc treo hệ thống
    # open: Thao tác file
    # eval, exec, compile: Thực thi chuỗi code động
    # __import__: Import động bypass regex
    # input: Chặn đứng tiến trình do chờ nhập liệu
    dangerous_keywords = [
        (r'\bopen\s*\(', "Hàm mở file 'open()' bị cấm."),
        (r'\beval\s*\(', "Hàm thực thi 'eval()' bị cấm."),
        (r'\bexec\s*\(', "Hàm thực thi 'exec()' bị cấm."),
        (r'\b__import__\s*\(', "Hàm import động '__import__()' bị cấm."),
        (r'\binput\s*\(', "Hàm 'input()' bị cấm vì có thể gây treo hệ thống trong môi trường LAN."),
        (r'\bgetattr\s*\(', "Hàm 'getattr()' bị cấm để tránh bypass bảo mật."),
        (r'\bsetattr\s*\(', "Hàm 'setattr()' bị cấm để tránh bypass bảo mật.")
    ]
    
    for pattern, error_msg in dangerous_keywords:
        if re.search(pattern, code_string):
            return False, error_msg
            
    # 3. Chặn truy cập thuộc tính dunder ẩn nhằm phá sandbox (Ví dụ: Class.__subclasses__)
    dunder_pattern = r'\b__(subclasses|globals|code|builtins|import|dict|getattribute)__\b'
    if re.search(dunder_pattern, code_string):
        return False, "Cảnh báo bảo mật: Không được truy cập các thuộc tính dunder (__...__) ẩn."
        
    return True, ""

def execute_python_code(code_string):
    """
    Thực thi mã nguồn Python trong môi trường Sandbox độc lập.
    Đầu ra giới hạn ký tự, cấu hình timeout để tránh treo hệ thống.
    """
    # Kiểm tra an toàn của mã nguồn
    is_safe, error_message = is_safe_code(code_string)
    if not is_safe:
        return {
            "success": False,
            "stdout": "",
            "stderr": f"Sandbox Blocked: {error_message}",
            "exit_code": -1
        }
        
    # Tạo thư mục tạm và ghi file code
    temp_dir = tempfile.gettempdir()
    # Thêm pid và thread ident để tên file hoàn toàn độc nhất
    temp_file_name = f"lan_py_{os.getpid()}_{threading.get_ident()}.py"
    temp_file_path = os.path.join(temp_dir, temp_file_name)
    
    try:
        # Ghi mã nguồn của học sinh ra file tạm với mã hóa UTF-8
        with open(temp_file_path, "w", encoding="utf-8") as f:
            f.write(code_string)
            
        # Khởi chạy tiến trình python phụ để chạy file code
        result = subprocess.run(
            [sys.executable, temp_file_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=Config.RUNTIME_TIMEOUT
        )
        
        stdout = result.stdout
        stderr = result.stderr
        exit_code = result.returncode
        
        # Giới hạn độ dài output (stdout)
        if len(stdout) > Config.MAX_OUTPUT_LENGTH:
            stdout = stdout[:Config.MAX_OUTPUT_LENGTH] + f"\n... [ĐẦU RA BỊ RÚT GỌN VÌ VƯỢT QUÁ {Config.MAX_OUTPUT_LENGTH} KÝ TỰ] ..."
            
        # Giới hạn độ dài lỗi (stderr)
        if len(stderr) > Config.MAX_OUTPUT_LENGTH:
            stderr = stderr[:Config.MAX_OUTPUT_LENGTH] + f"\n... [LỖI BỊ RÚT GỌN VÌ VƯỢT QUÁ {Config.MAX_OUTPUT_LENGTH} KÝ TỰ] ..."
            
        return {
            "success": exit_code == 0,
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": exit_code
        }
        
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "stdout": "",
            "stderr": f"Lỗi: Quá thời gian chạy tối đa cho phép ({Config.RUNTIME_TIMEOUT} giây). Chương trình đã bị buộc dừng để tránh treo máy.",
            "exit_code": -2
        }
    except Exception as e:
        return {
            "success": False,
            "stdout": "",
            "stderr": f"Lỗi hệ thống khi biên dịch/chạy mã nguồn: {str(e)}",
            "exit_code": -3
        }
    finally:
        # Đảm bảo xóa file tạm sau khi chạy xong
        if os.path.exists(temp_file_path):
            try:
                os.remove(temp_file_path)
            except Exception:
                pass
