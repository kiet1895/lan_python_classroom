@echo off
:: Di chuyển vào thư mục chứa file .bat này
cd /d "%~dp0"

title May Chu Phong Lap Trinh Python LAN

echo ==================================================
echo    DANG KHOI CHAY PHONG LAP TRINH PYTHON LAN
echo ==================================================
echo Vui long giu cua so nay mo trong luc day hoc.
echo Dia chi truy cap may giao vien: http://localhost:5001/teacher
echo --------------------------------------------------

:: Kiểm tra và tự động cài đặt thư viện nếu bị thiếu
python -c "import flask, flask_socketio, eventlet" 2>nul
if %errorlevel% neq 0 (
    echo Phat hien thieu thu vien he thong. Dang tu dong cai dat...
    python -m pip install -r requirements.txt
    if %errorlevel% neq 0 (
        echo LOI: Khong the tu dong cai dat thu vien.
        echo Vui long chay lenh 'pip install -r requirements.txt' thu cong.
        pause
        exit /b 1
    )
    echo Cai dat thu vien thanh cong!
    echo --------------------------------------------------
)

:: Khởi chạy máy chủ (Thử lệnh python trước, nếu lỗi sẽ thử python3)
python backend/app.py || python3 backend/app.py

echo.
echo May chu da dung lai.
pause
