// Khởi tạo kết nối Socket.IO
const socket = io();

// Các biến quản lý trạng thái lớp học
let classCapacity = window.CLASS_CAPACITY || 0;
let students = {}; // Map lưu học sinh theo IP: { ip: student_data }
let studentEditors = {}; // Map lưu CodeMirror instance của học sinh: { ip: cm_instance }
let templateEditor = null; // CodeMirror cho phần soạn code mẫu
let lastTeacherEditTimes = {}; // ip -> timestamp (thời gian giáo viên gõ phím cuối cùng để tránh lỗi đè)
let lastTeacherStdinEditTimes = {}; // ip -> timestamp (tránh ghi đè khi giáo viên đang nhập liệu stdin)
let teacherStdinSyncTimeouts = {}; // ip -> timeout

let isSharingTemplateLive = false;
let teacherTemplateCode = "";
let teacherTemplateStdin = "";
let teacherTemplateConsole = null;


let isFrozenGlobal = false;
let examModeGlobal = false;

// Trạng thái Viewed Tabs và Đề bài phía giáo viên
let viewedTabs = {}; // ip -> tab_id (Tab giáo viên đang xem của từng học sinh)
let pinnedTabs = {}; // ip -> boolean (Có phải giáo viên đã pin tab thủ công)
let currentAssignment = { type: "none", content: "", filename: "" };

// Đợi DOM load xong
document.addEventListener("DOMContentLoaded", () => {
    // Đăng ký máy giáo viên với server
    socket.emit("register_teacher");
    
    initSocketEvents();
    initUIEvents();
    
    if (classCapacity > 0) {
        initGrid(classCapacity);
    }
});

/* ==========================================================================
   CẤU HÌNH LẮNG NGHE SỰ KIỆN SOCKET.IO
   ========================================================================== */
function initSocketEvents() {
    // Trạng thái kết nối tới server
    socket.on("connect", () => {
        console.log("Đã kết nối tới server với vai trò Giáo viên");
    });

    // Nhận dữ liệu khởi tạo lớp học hoặc cập nhật lại toàn bộ
    socket.on("teacher_init", (data) => {
        classCapacity = data.capacity;
        students = data.students || {};
        isFrozenGlobal = data.is_frozen;
        examModeGlobal = data.exam_mode;
        const sharedIps = data.shared_ips || [];
        currentAssignment = data.assignment || { type: "none", content: "", filename: "" };
        
        // Cập nhật badges sĩ số
        updateCapacityBadge();
        
        // Hiển thị/ẩn ô tìm kiếm học sinh dựa trên sĩ số lớp
        const searchBox = document.getElementById("search-box-container");
        const searchInput = document.getElementById("search-student-input");
        if (searchBox) {
            searchBox.style.display = classCapacity > 0 ? "flex" : "none";
        }
        if (searchInput) {
            searchInput.value = ""; // Đặt lại chuỗi tìm kiếm khi reset hoặc khởi tạo
        }
        
        // Khởi tạo lại lưới hiển thị
        if (classCapacity > 0) {
            initGrid(classCapacity);
            
            // Điền thông tin học sinh hiện có vào lưới
            Object.keys(students).forEach(ip => {
                students[ip].is_sharing = sharedIps.includes(ip);
                // Mặc định tab xem bằng tab active học sinh
                if (!viewedTabs[ip]) {
                    viewedTabs[ip] = students[ip].active_tab_id || "tab_default";
                }
                renderStudentSlot(ip, students[ip]);
            });
            
            // Áp dụng bộ lọc tìm kiếm hiện tại nếu có
            filterStudents();
            
            // Đồng bộ lại giao diện nút chia sẻ
            syncShareButtons(sharedIps);
            
            // Cập nhật giao diện nút khóa/mở khóa màn hình
            updateFreezeButtonUI(isFrozenGlobal);
            // Cập nhật giao diện nút chế độ kiểm tra
            updateExamButtonUI(examModeGlobal);
            
            // Cập nhật trạng thái đề bài hiển thị trên drawer
            renderAssignmentStatus();
            
            // Lưu và hiển thị trạng thái code mẫu
            isSharingTemplateLive = data.is_sharing_template || false;
            teacherTemplateCode = data.code_template || "";
            teacherTemplateStdin = data.template_stdin || "";
            teacherTemplateConsole = data.template_console || null;
            
            updateShareLiveButtonUI(isSharingTemplateLive);
            
            if (templateEditor) {
                templateEditor.setValue(teacherTemplateCode);
            }
            const stdinInput = document.getElementById("template-stdin-input");
            if (stdinInput) {
                stdinInput.value = teacherTemplateStdin;
            }
            if (teacherTemplateConsole) {
                renderTemplateConsoleOutput(teacherTemplateConsole);
            }
        }
    });

    // Học sinh mới gia nhập lớp học / Cập nhật trạng thái tab
    socket.on("student_update", (data) => {
        const ip = data.ip;
        const student = data.student;
        
        students[ip] = student;
        
        // Nếu GV chưa pin thủ công hoặc tab được pin không còn tồn tại, tự động theo dõi tab active của học sinh
        const tabExists = student.tabs && student.tabs.some(t => t.id === viewedTabs[ip]);
        if (!pinnedTabs[ip] || !tabExists) {
            viewedTabs[ip] = student.active_tab_id || "tab_default";
        }
        
        renderStudentSlot(ip, student);
        updateActiveCountBadge();
        filterStudents();
    });

    // Thay đổi trạng thái kết nối học sinh (Online/Offline)
    socket.on("student_status_change", (data) => {
        const ip = data.ip;
        const status = data.status;
        
        if (students[ip]) {
            students[ip].status = status;
            
            const card = document.getElementById(`student-card-${ip.replace(/\./g, '-')}`);
            const dot = document.getElementById(`card-dot-${ip.replace(/\./g, '-')}`);
            
            if (card && dot) {
                if (status === "online") {
                    card.classList.remove("card-offline");
                    dot.className = "status-dot green";
                } else {
                    card.classList.add("card-offline");
                    dot.className = "status-dot red";
                }
            }
            updateActiveCountBadge();
        }
    });

    // Đồng bộ mã nguồn học sinh đang gõ
    socket.on("student_code_sync", (data) => {
        const ip = data.ip;
        const code = data.code;
        const tab_id = data.tab_id || "tab_default";
        
        if (students[ip]) {
            // Cập nhật mã nguồn tab trong bộ nhớ đệm
            if (students[ip].tabs) {
                const tab = students[ip].tabs.find(t => t.id === tab_id);
                if (tab) {
                    tab.code = code;
                }
            } else {
                students[ip].code = code;
            }
        }
        
        // Ghi đè lên CodeMirror máy GV chỉ khi tab được đồng bộ đang là tab giáo viên đang xem
        const currentViewedTabId = viewedTabs[ip] || (students[ip] ? students[ip].active_tab_id : "tab_default");
        if (currentViewedTabId === tab_id) {
            const editor = studentEditors[ip];
            if (editor && editor.getValue() !== code) {
                // Chỉ chặn ghi đè nếu giáo viên có focus và ĐANG soạn thảo (trong vòng 3 giây qua) để tránh lỗi gõ tiếng Việt / mất focus
                const isTeacherEditing = editor.hasFocus() && (Date.now() - (lastTeacherEditTimes[ip] || 0) < 3000);
                if (isTeacherEditing) {
                    return;
                }
                
                if (!code) {
                    editor.setValue("");
                } else {
                    const cursor = editor.getCursor();
                    const scrollInfo = editor.getScrollInfo();
                    
                    editor.setValue(code);
                    
                    if (editor.hasFocus()) {
                        try {
                            const lineCount = editor.lineCount();
                            let line = Math.max(0, Math.min(cursor.line, lineCount - 1));
                            const lineLength = (editor.getLine(line) || "").length;
                            let ch = Math.max(0, Math.min(cursor.ch, lineLength));
                            editor.setCursor({ line: line, ch: ch }, { scroll: false });
                        } catch (e) {
                            console.warn("Lỗi khôi phục con trỏ:", e);
                        }
                        
                        try {
                            editor.scrollTo(scrollInfo.left, scrollInfo.top);
                        } catch (e) {
                            console.warn("Lỗi khôi phục scroll:", e);
                        }
                    }
                }
            }
        }
    });

    // Nhận dữ liệu đầu vào (stdin) của học sinh được đồng bộ từ client
    socket.on("student_stdin_sync", (data) => {
        const ip = data.ip;
        const stdin = data.stdin;
        if (students[ip]) {
            students[ip].stdin = stdin;
        }
        const safeIp = ip.replace(/\./g, '-');
        const stdinInput = document.getElementById(`card-stdin-${safeIp}`);
        if (stdinInput) {
            const isTeacherEditing = (document.activeElement === stdinInput) && (Date.now() - (lastTeacherStdinEditTimes[ip] || 0) < 3000);
            if (!isTeacherEditing) {
                stdinInput.value = stdin || "";
            }
        }
    });

    // Nhận cập nhật đề bài từ server
    socket.on("assignment_updated", (assignment) => {
        currentAssignment = assignment;
        renderAssignmentStatus();
    });

    // Cập nhật số lỗi mất tập trung của học sinh
    socket.on("student_fault_update", (data) => {
        const ip = data.ip;
        const faults = data.faults;
        
        if (students[ip]) {
            students[ip].faults = faults;
        }
        
        const faultBadge = document.getElementById(`card-fault-${ip.replace(/\./g, '-')}`);
        if (faultBadge) {
            faultBadge.textContent = `Lỗi rời tab: ${faults}`;
            if (faults > 0) {
                faultBadge.className = "card-fault-indicator warning-high";
            }
        }
    });

    // Cập nhật trạng thái giơ tay nhấp nháy của học sinh
    socket.on("student_hand_update", (data) => {
        const ip = data.ip;
        const raised = data.hand_raised;
        
        if (students[ip]) {
            students[ip].hand_raised = raised;
        }
        
        const card = document.getElementById(`student-card-${ip.replace(/\./g, '-')}`);
        const handIndicator = document.getElementById(`card-hand-${ip.replace(/\./g, '-')}`);
        
        if (card && handIndicator) {
            if (raised) {
                card.classList.add("card-hand-raised");
                handIndicator.classList.remove("d-none");
            } else {
                card.classList.remove("card-hand-raised");
                handIndicator.classList.add("d-none");
            }
        }
    });

    // Đồng bộ trạng thái khóa màn hình toàn cục
    socket.on("freeze_status_sync", (data) => {
        isFrozenGlobal = data.frozen;
        updateFreezeButtonUI(isFrozenGlobal);
    });

    // Đồng bộ trạng thái chế độ kiểm tra toàn cục
    socket.on("exam_mode_sync", (data) => {
        examModeGlobal = data.exam_mode;
        updateExamButtonUI(examModeGlobal);
        
        // Bật/tắt class ẩn code trên toàn bộ các card học sinh
        const cards = document.querySelectorAll(".student-card");
        cards.forEach(card => {
            // Không áp dụng cho ô trống trống
            if (!card.classList.contains("empty-slot")) {
                if (examModeGlobal) {
                    card.classList.add("exam-hidden");
                } else {
                    card.classList.remove("exam-hidden");
                }
            }
        });
    });

    // Nhận kết quả biên dịch và chạy code từ sandbox
    socket.on("run_result", (data) => {
        const ip = data.target_ip;
        const safeIp = ip.replace(/\./g, '-');
        
        const consoleBody = document.getElementById(`card-console-body-${safeIp}`);
        const consoleHeaderStatus = document.querySelector(`#student-card-${safeIp} .card-console-status`);
        
        if (consoleBody) {
            consoleBody.innerHTML = "";
            consoleBody.classList.remove("card-console-placeholder", "error");
            
            if (data.success) {
                consoleBody.textContent = data.stdout || "Chương trình chạy hoàn tất (Không có output).";
                if (consoleHeaderStatus) {
                    consoleHeaderStatus.textContent = "Thành công";
                    consoleHeaderStatus.style.color = "#10b981";
                }
            } else {
                consoleBody.classList.add("error");
                consoleBody.textContent = data.stderr || "Chương trình lỗi biên dịch/thực thi.";
                if (consoleHeaderStatus) {
                    consoleHeaderStatus.textContent = `Lỗi (code ${data.exit_code})`;
                    consoleHeaderStatus.style.color = "#ef4444";
                }
            }
            // Tự động cuộn xuống cuối
            consoleBody.scrollTop = consoleBody.scrollHeight;
        }
    });

    // Đồng bộ trạng thái chia sẻ bài học sinh từ máy chủ
    socket.on("share_status_sync", (data) => {
        const sharedIps = data.shared_ips || [];
        Object.keys(students).forEach(ip => {
            students[ip].is_sharing = sharedIps.includes(ip);
            const safeIp = ip.replace(/\./g, '-');
            const btnShare = document.getElementById(`btn-share-${safeIp}`);
            if (btnShare) {
                if (students[ip].is_sharing) {
                    btnShare.className = "btn btn-warning btn-sm";
                    btnShare.innerHTML = '<i class="fa-solid fa-square-share-nodes"></i> Đang chia sẻ';
                    btnShare.title = "Dừng chia sẻ bài làm này cho cả lớp";
                } else {
                    btnShare.className = "btn btn-secondary btn-sm";
                    btnShare.innerHTML = '<i class="fa-solid fa-share-nodes"></i> Chia sẻ bài';
                    btnShare.title = "Chia sẻ bài làm này cho cả lớp xem";
                }
            }
        });
    });

    // Đồng bộ trạng thái chia sẻ bài giảng trực tiếp
    socket.on("teacher_share_template_state", (data) => {
        isSharingTemplateLive = data.share;
        teacherTemplateCode = data.code;
        teacherTemplateStdin = data.stdin;
        teacherTemplateConsole = data.console;
        
        updateShareLiveButtonUI(isSharingTemplateLive);
        
        if (templateEditor && templateEditor.getValue() !== teacherTemplateCode) {
            templateEditor.setValue(teacherTemplateCode);
        }
        const stdinInput = document.getElementById("template-stdin-input");
        if (stdinInput && stdinInput.value !== teacherTemplateStdin) {
            stdinInput.value = teacherTemplateStdin;
        }
        if (teacherTemplateConsole) {
            renderTemplateConsoleOutput(teacherTemplateConsole);
        }
    });

    // Đồng bộ thay đổi code mẫu khi gõ trên máy khác
    socket.on("teacher_template_code_sync", (data) => {
        teacherTemplateCode = data.code;
        if (templateEditor && templateEditor.getValue() !== teacherTemplateCode) {
            templateEditor.setValue(teacherTemplateCode);
        }
    });

    // Đồng bộ thay đổi input của code mẫu
    socket.on("teacher_template_stdin_sync", (data) => {
        teacherTemplateStdin = data.stdin;
        const stdinInput = document.getElementById("template-stdin-input");
        if (stdinInput && stdinInput.value !== teacherTemplateStdin) {
            stdinInput.value = teacherTemplateStdin;
        }
    });

    // Đồng bộ kết quả chạy thử code mẫu
    socket.on("teacher_template_run_result", (data) => {
        teacherTemplateConsole = data;
        renderTemplateConsoleOutput(data);
    });
}

/* ==========================================================================
   CẤU HÌNH SỰ KIỆN GIAO DIỆN NGƯỜI DÙNG (UI EVENTS)
   ========================================================================== */
function initUIEvents() {
    // Mở Setup Modal
    const btnOpenSetup = document.getElementById("btn-open-setup");
    if (btnOpenSetup) {
        btnOpenSetup.addEventListener("click", () => {
            document.getElementById("setup-modal").style.display = "flex";
        });
    }

    // Đóng Setup Modal (Chỉ cho phép hủy khi đã có lớp học tồn tại)
    const btnCancelSetup = document.getElementById("btn-cancel-setup");
    if (btnCancelSetup) {
        btnCancelSetup.addEventListener("click", () => {
            document.getElementById("setup-modal").style.display = "none";
        });
    }

    // Nút thiết lập lại lớp học từ header
    const btnReSetup = document.getElementById("btn-re-setup");
    if (btnReSetup) {
        btnReSetup.addEventListener("click", () => {
            document.getElementById("setup-modal").style.display = "flex";
            const input = document.getElementById("capacity-input");
            input.value = classCapacity;
        });
    }

    // Gửi yêu cầu thiết lập lớp học mới
    const setupForm = document.getElementById("setup-session-form");
    if (setupForm) {
        setupForm.addEventListener("submit", () => {
            const capacityInput = document.getElementById("capacity-input");
            const capacity = parseInt(capacityInput.value) || 0;
            if (capacity > 0) {
                // Xác nhận reset dữ liệu cũ
                if (classCapacity > 0 && !confirm("Lưu ý: Thiết lập lớp mới sẽ làm mới hoàn toàn danh sách học sinh và code hiện tại. Bạn có chắc muốn tiếp tục?")) {
                    return;
                }
                
                socket.emit("setup_session", { capacity: capacity });
                document.getElementById("setup-modal").style.display = "none";
            }
        });
    }

    // Tải Code mẫu (Toggle Drawer)
    const btnToggleTemplate = document.getElementById("btn-toggle-template");
    const templateDrawer = document.getElementById("template-drawer");
    if (btnToggleTemplate && templateDrawer) {
        btnToggleTemplate.addEventListener("click", () => {
            if (templateDrawer.style.display === "none") {
                templateDrawer.style.display = "block";
                initTemplateEditor();
            } else {
                templateDrawer.style.display = "none";
            }
        });
    }

    // Đóng Drawer Code mẫu
    const btnCloseTemplate = document.getElementById("btn-close-template");
    if (btnCloseTemplate && templateDrawer) {
        btnCloseTemplate.addEventListener("click", () => {
            templateDrawer.style.display = "none";
        });
    }

    // Gửi Code mẫu cho học sinh
    const btnPushTemplate = document.getElementById("btn-push-template");
    if (btnPushTemplate) {
        btnPushTemplate.addEventListener("click", () => {
            if (!templateEditor) {
                alert("Trình soạn thảo code mẫu chưa sẵn sàng.");
                return;
            }
            const code = templateEditor.getValue();
            if (confirm("Hành động này sẽ ghi đè code mẫu lên trình soạn thảo của TẤT CẢ học sinh. Xác nhận gửi?")) {
                socket.emit("teacher_action", {
                    action: "push_template",
                    code: code
                });
                templateDrawer.style.display = "none";
            }
        });
    }

    // Khóa / Mở khóa màn hình toàn bộ học sinh
    const btnFreezeAll = document.getElementById("btn-freeze-all");
    if (btnFreezeAll) {
        btnFreezeAll.addEventListener("click", () => {
            const targetFreeze = !isFrozenGlobal;
            socket.emit("teacher_action", {
                action: "freeze_all",
                freeze: targetFreeze
            });
        });
    }

    // Bật / Tắt chế độ kiểm tra (ẩn code tránh học sinh nhìn máy chiếu copy)
    const btnToggleExam = document.getElementById("btn-toggle-exam");
    if (btnToggleExam) {
        btnToggleExam.addEventListener("click", () => {
            const targetExam = !examModeGlobal;
            socket.emit("teacher_action", {
                action: "toggle_exam_mode",
                exam_mode: targetExam
            });
        });
    }

    // Sự kiện tìm kiếm học sinh
    const searchInput = document.getElementById("search-student-input");
    if (searchInput) {
        searchInput.addEventListener("input", filterStudents);
    }

    // Sự kiện Ẩn/Hiện Drawer đề bài
    const btnToggleAssignment = document.getElementById("btn-toggle-assignment");
    const assignmentDrawer = document.getElementById("assignment-drawer");
    if (btnToggleAssignment && assignmentDrawer) {
        btnToggleAssignment.addEventListener("click", () => {
            if (assignmentDrawer.style.display === "none") {
                assignmentDrawer.style.display = "block";
                renderAssignmentStatus();
            } else {
                assignmentDrawer.style.display = "none";
            }
        });
    }

    const btnCloseAssignment = document.getElementById("btn-close-assignment");
    if (btnCloseAssignment && assignmentDrawer) {
        btnCloseAssignment.addEventListener("click", () => {
            assignmentDrawer.style.display = "none";
        });
    }

    // Thiết lập dán hình ảnh trực tiếp từ clipboard vào textarea đề bài
    const assignTextContent = document.getElementById("assign-text-content");
    if (assignTextContent) {
        assignTextContent.addEventListener("paste", function(e) {
            const items = (e.clipboardData || e.originalEvent.clipboardData).items;
            for (let index in items) {
                const item = items[index];
                if (item.kind === 'file' && item.type.indexOf('image/') !== -1) {
                    const blob = item.getAsFile();
                    const formData = new FormData();
                    formData.append('file', blob, `pasted_image_${Date.now()}.png`);
                    
                    const startPos = assignTextContent.selectionStart;
                    const endPos = assignTextContent.selectionEnd;
                    const textVal = assignTextContent.value;
                    const placeholder = "![Đang tải ảnh lên từ clipboard...]()";
                    assignTextContent.value = textVal.substring(0, startPos) + placeholder + textVal.substring(endPos);
                    
                    fetch('/teacher/upload_image', {
                        method: 'POST',
                        body: formData
                    })
                    .then(res => res.json())
                    .then(data => {
                        if (data.success) {
                            assignTextContent.value = assignTextContent.value.replace(placeholder, `![Ảnh đã dán](${data.url})`);
                        } else {
                            assignTextContent.value = assignTextContent.value.replace(placeholder, `[Lỗi tải ảnh: ${data.message}]`);
                        }
                    })
                    .catch(err => {
                        assignTextContent.value = assignTextContent.value.replace(placeholder, `[Lỗi mạng khi tải ảnh]`);
                    });
                    e.preventDefault(); // Ngăn hành vi dán text mặc định
                }
            }
        });
    }

    // Form gửi đề bài qua AJAX (Hỗ trợ mô tả + file đính kèm)
    const assignmentForm = document.getElementById("assignment-form");
    if (assignmentForm) {
        assignmentForm.addEventListener("submit", (e) => {
            e.preventDefault();
            
            const description = document.getElementById("assign-text-content").value.trim();
            const fileInput = document.getElementById("assign-file-input");
            
            if (!description && (!fileInput || fileInput.files.length === 0)) {
                alert("Vui lòng nhập hướng dẫn đề bài hoặc chọn tệp đính kèm.");
                return;
            }
            
            const formData = new FormData();
            formData.append("description", description);
            
            if (fileInput && fileInput.files.length > 0) {
                formData.append("file", fileInput.files[0]);
            }
            
            const btnPush = document.getElementById("btn-push-assignment");
            if (btnPush) {
                btnPush.disabled = true;
                btnPush.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang gửi...';
            }
            
            fetch("/teacher/set_assignment", {
                method: "POST",
                body: formData
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    alert("Đã gửi đề bài thành công tới cả lớp!");
                    if (assignmentDrawer) assignmentDrawer.style.display = "none";
                    if (fileInput) fileInput.value = "";
                } else {
                    alert("Có lỗi xảy ra: " + data.message);
                }
            })
            .catch(err => {
                console.error(err);
                alert("Có lỗi kết nối khi tải đề bài lên.");
            })
            .finally(() => {
                if (btnPush) {
                    btnPush.disabled = false;
                    btnPush.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Gửi đề bài';
                }
            });
        });
    }

    // Nút xóa đề bài hiện tại
    const btnClearAssignment = document.getElementById("btn-clear-assignment");
    if (btnClearAssignment) {
        btnClearAssignment.addEventListener("click", () => {
            if (!confirm("Bạn có chắc chắn muốn xóa đề bài hiện tại khỏi lớp học?")) {
                return;
            }
            
            fetch("/teacher/clear_assignment", {
                method: "POST"
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    alert("Đã xóa đề bài thành công.");
                    if (assignmentDrawer) assignmentDrawer.style.display = "none";
                } else {
                    alert("Không thể xóa đề bài: " + data.message);
                }
            })
            .catch(err => {
                console.error(err);
                alert("Có lỗi kết nối khi thực hiện xóa đề bài.");
            });
        });
    }
}

/* ==========================================================================
   KHỞI TẠO LƯỚI GRID HIỂN THỊ ĐỘNG (DYNAMIC GRID RENDER)
   ========================================================================== */
function initGrid(capacity) {
    const gridContainer = document.getElementById("student-grid");
    if (!gridContainer) return;
    
    gridContainer.innerHTML = ""; // Clear
    studentEditors = {}; // Reset editor instances
    
    for (let slotId = 1; slotId <= capacity; slotId++) {
        const slotCard = document.createElement("div");
        slotCard.className = "student-card glass-panel empty-slot";
        slotCard.id = `slot-card-${slotId}`;
        
        slotCard.innerHTML = `
            <div class="empty-slot-icon">
                <i class="fa-solid fa-desktop"></i>
            </div>
            <div class="empty-slot-title">ĐANG CHỜ KẾT NỐI...</div>
            <div style="font-size: 0.8rem; margin-top: 5px; color: var(--color-text-muted);">MÁY SỐ: Ô ${slotId}</div>
        `;
        
        gridContainer.appendChild(slotCard);
    }
    updateActiveCountBadge();
}

/* Điền dữ liệu học sinh vào ô lưới tương ứng */
function renderStudentSlot(ip, student) {
    const slotId = student.slot_id;
    const safeIp = ip.replace(/\./g, '-');
    const slotCard = document.getElementById(`student-card-${safeIp}`) || document.getElementById(`slot-card-${slotId}`);
    if (!slotCard) return;
    
    // Đổi thẻ từ trống sang có dữ liệu học sinh
    slotCard.className = `student-card glass-panel ${student.status === 'offline' ? 'card-offline' : ''} ${student.hand_raised ? 'card-hand-raised' : ''} ${examModeGlobal ? 'exam-hidden' : ''}`;
    slotCard.id = `student-card-${safeIp}`;
    slotCard.dataset.ip = ip;
    
    // Thiết kế thanh tab mini của học sinh trên Grid giáo viên
    let tabsHtml = "";
    const activeViewedTabId = viewedTabs[ip] || student.active_tab_id || "tab_default";
    
    if (student.tabs && student.tabs.length > 0) {
        tabsHtml = '<div class="card-student-tabs">';
        student.tabs.forEach(tab => {
            const isStudentActive = (student.active_tab_id === tab.id);
            const isTeacherViewed = (activeViewedTabId === tab.id);
            
            tabsHtml += `
                <button class="card-tab-btn ${isTeacherViewed ? 'active' : ''} ${isStudentActive ? 'student-active' : ''}" 
                        onclick="switchTeacherViewedTab('${ip}', '${tab.id}')"
                        title="${isStudentActive ? 'Học sinh đang viết ở tab này' : 'Click để xem bài làm này'}">
                    ${isStudentActive ? '<i class="fa-solid fa-user-pen" style="font-size: 0.7rem; margin-right: 4px;"></i>' : ''}
                    <span>${tab.name}</span>
                </button>
            `;
        });
        tabsHtml += '</div>';
    }

    const isAlreadyRendered = !slotCard.classList.contains("empty-slot") && studentEditors[ip];
    if (isAlreadyRendered) {
        // Cập nhật lớp hiển thị của thẻ
        slotCard.className = `student-card glass-panel ${student.status === 'offline' ? 'card-offline' : ''} ${student.hand_raised ? 'card-hand-raised' : ''} ${examModeGlobal ? 'exam-hidden' : ''}`;
        
        // Cập nhật trạng thái chấm tròn online/offline
        const dot = document.getElementById(`card-dot-${safeIp}`);
        if (dot) {
            dot.className = `status-dot ${student.status === 'online' ? 'green' : 'red'}`;
        }
        
        // Cập nhật tên học sinh
        const nameSpan = slotCard.querySelector(".card-student-name");
        if (nameSpan) {
            nameSpan.textContent = student.name;
            nameSpan.title = student.name;
        }
        
        // Cập nhật số lỗi rời tab
        const faultBadge = document.getElementById(`card-fault-${safeIp}`);
        if (faultBadge) {
            faultBadge.textContent = `Lỗi rời tab: ${student.faults}`;
            if (student.faults > 0) {
                faultBadge.className = "card-fault-indicator warning-high";
            } else {
                faultBadge.className = "card-fault-indicator";
            }
        }
        
        // Cập nhật biểu tượng giơ tay
        const hand = document.getElementById(`card-hand-${safeIp}`);
        if (hand) {
            if (student.hand_raised) {
                hand.classList.remove("d-none");
            } else {
                hand.classList.add("d-none");
            }
        }
        
        // Cập nhật các tab mini của học sinh
        const tabsContainer = slotCard.querySelector(".card-student-tabs");
        if (tabsContainer) {
            if (tabsHtml) {
                tabsContainer.outerHTML = tabsHtml;
            } else {
                tabsContainer.remove();
            }
        } else if (tabsHtml) {
            const header = slotCard.querySelector(".card-header");
            if (header) {
                header.insertAdjacentHTML('afterend', tabsHtml);
            }
        }
        
        // Cập nhật giá trị CodeMirror
        const viewedTab = (student.tabs || []).find(t => t.id === activeViewedTabId);
        const currentCode = viewedTab ? viewedTab.code : (student.code || "");
        const cm = studentEditors[ip];
        if (cm && cm.getValue() !== currentCode) {
            const isTeacherEditing = cm.hasFocus() && (Date.now() - (lastTeacherEditTimes[ip] || 0) < 3000);
            if (!isTeacherEditing) {
                cm.setValue(currentCode);
            }
        }
        
        // Cập nhật giá trị Stdin input
        const stdinInput = document.getElementById(`card-stdin-${safeIp}`);
        if (stdinInput) {
            const isTeacherEditing = (document.activeElement === stdinInput) && (Date.now() - (lastTeacherStdinEditTimes[ip] || 0) < 3000);
            if (!isTeacherEditing) {
                stdinInput.value = student.stdin || "";
            }
        }
        
        // Cập nhật nút chia sẻ bài
        const btnShare = document.getElementById(`btn-share-${safeIp}`);
        if (btnShare) {
            if (student.is_sharing) {
                btnShare.className = "btn btn-warning btn-sm";
                btnShare.innerHTML = '<i class="fa-solid fa-square-share-nodes"></i> Đang chia sẻ';
            } else {
                btnShare.className = "btn btn-secondary btn-sm";
                btnShare.innerHTML = '<i class="fa-solid fa-share-nodes"></i> Chia sẻ bài';
            }
        }
        
        return;
    }

    // Render markup đầy đủ
    slotCard.innerHTML = `
        <div class="card-header">
            <div class="card-header-left">
                <div class="status-dot ${student.status === 'online' ? 'green' : 'red'}" id="card-dot-${safeIp}"></div>
                <span class="card-student-name" title="${student.name}">${student.name}</span>
            </div>
            <div class="card-header-right">
                <span class="card-hand-indicator ${student.hand_raised ? '' : 'd-none'}" id="card-hand-${safeIp}">
                    <i class="fa-solid fa-hand-pointer"></i>
                </span>
                <span class="card-fault-indicator ${student.faults > 0 ? 'warning-high' : ''}" id="card-fault-${safeIp}">Lỗi rời tab: ${student.faults}</span>
            </div>
        </div>
        ${tabsHtml}
        <div class="card-body">
            <textarea id="card-editor-${safeIp}"></textarea>
            
            <div class="exam-hidden-placeholder">
                <i class="fa-solid fa-user-lock"></i>
                <span>Chế độ kiểm tra đang bật</span>
                <span style="font-size: 0.75rem; color: var(--color-text-muted);">(Code học sinh đang được ẩn trên máy chiếu)</span>
            </div>
            
            <div class="card-console" id="card-console-${safeIp}">
                <div class="card-console-header">
                    <span>Console</span>
                    <span class="card-console-status" style="font-weight: 700;"></span>
                </div>
                <div class="card-console-stdin">
                    <span class="card-console-stdin-label">
                        <i class="fa-solid fa-keyboard"></i> Input:
                    </span>
                    <textarea id="card-stdin-${safeIp}" class="card-console-stdin-textarea" placeholder="Ví dụ:&#10;Kiet&#10;18" oninput="syncTeacherEditedStdin('${ip}')">${student.stdin || ""}</textarea>
                </div>
                <div class="card-console-body card-console-placeholder" id="card-console-body-${safeIp}">Chờ chạy thử...</div>
            </div>
        </div>
        <div class="card-footer">
            <span class="card-ip" title="${ip}">IP: ${ip} | Ô ${slotId}</span>
            <div class="card-actions" style="display: flex; gap: 8px;">
                <button class="btn btn-secondary btn-sm" id="btn-share-${safeIp}" style="padding: 6px 12px; font-size: 0.8rem;" onclick="toggleShareStudent('${ip}')" title="Chia sẻ bài làm này cho cả lớp xem">
                    <i class="fa-solid fa-share-nodes"></i> Chia sẻ bài
                </button>
                <button class="btn btn-indigo btn-sm" style="padding: 6px 12px; font-size: 0.8rem;" onclick="runStudentCode('${ip}')" title="Chạy chương trình của học sinh">
                    <i class="fa-solid fa-play"></i> Run Code
                </button>
            </div>
        </div>
    `;
    
    // Khởi tạo editor CodeMirror trong card cho phép giáo viên chỉnh sửa trực tiếp
    const textarea = document.getElementById(`card-editor-${safeIp}`);
    const cm = CodeMirror.fromTextArea(textarea, {
        mode: "python",
        theme: "dracula",
        lineNumbers: true,
        readOnly: false, // Giáo viên có thể sửa trực tiếp để trợ giúp học sinh
        lineWrapping: true,
        matchBrackets: true,
        autoCloseBrackets: true,
        inputStyle: "contenteditable", // Hỗ trợ gõ tiếng Việt Telex/VNI và tổ hợp phím tắt chuẩn
        extraKeys: {
            "Ctrl-3": function(editor) { editor.toggleComment(); },
            "Cmd-3": function(editor) { editor.toggleComment(); },
            "Backspace": function(editor) {
                if (editor.somethingSelected()) {
                    editor.replaceSelection("");
                    return;
                }
                return CodeMirror.Pass;
            },
            "Delete": function(editor) {
                if (editor.somethingSelected()) {
                    editor.replaceSelection("");
                    return;
                }
                return CodeMirror.Pass;
            }
        }
    });
    
    // Set code ban đầu dựa theo tab đang hiển thị
    const viewedTab = (student.tabs || []).find(t => t.id === activeViewedTabId);
    const initialCode = viewedTab ? viewedTab.code : (student.code || "");
    cm.setValue(initialCode);
    
    // Lưu tham chiếu editor
    studentEditors[ip] = cm;

    // Đăng ký sự kiện thay đổi của CodeMirror học sinh để đồng bộ ngược về máy học sinh
    let syncTimeout;
    cm.on("change", (instance, changeObj) => {
        // Bỏ qua các thay đổi do chương trình đặt giá trị (setValue) để tránh vòng lặp đồng bộ vô hạn
        if (changeObj && changeObj.origin === "setValue") return;

        // Ghi lại thời điểm giáo viên chỉnh sửa để tạm thời chặn cập nhật từ máy con học sinh trong 3s
        lastTeacherEditTimes[ip] = Date.now();

        clearTimeout(syncTimeout);
        syncTimeout = setTimeout(() => {
            const code = cm.getValue();
            const currentTabId = viewedTabs[ip] || student.active_tab_id || "tab_default";
            socket.emit("teacher_edit_code", {
                target_ip: ip,
                tab_id: currentTabId,
                code: code
            });
        }, 400); // Debounce 400ms
    });
}

/* Gọi sandbox chạy code học sinh từ xa */
window.runStudentCode = function(ip) {
    const safeIp = ip.replace(/\./g, '-');
    const consoleBody = document.getElementById(`card-console-body-${safeIp}`);
    const consoleHeaderStatus = document.querySelector(`#student-card-${safeIp} .card-console-status`);
    
    if (consoleBody) {
        consoleBody.className = "card-console-body";
        consoleBody.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang chạy chương trình sandbox...';
        if (consoleHeaderStatus) {
            consoleHeaderStatus.textContent = "Đang chạy...";
            consoleHeaderStatus.style.color = "#38bdf8";
        }
    }
    
    const currentTabId = viewedTabs[ip] || (students[ip] ? students[ip].active_tab_id : "tab_default");
    socket.emit("teacher_action", {
        action: "run_student_code",
        target_ip: ip,
        tab_id: currentTabId
    });
};

/* Gửi tín hiệu bật/tắt chia sẻ bài học sinh */
window.toggleShareStudent = function(ip) {
    const student = students[ip];
    if (student) {
        const isSharing = !!student.is_sharing;
        socket.emit("teacher_action", {
            action: "toggle_share_student",
            target_ip: ip,
            share: !isSharing
        });
    }
};

/* Cập nhật nhãn nút chia sẻ của các card */
function syncShareButtons(sharedIps) {
    Object.keys(students).forEach(ip => {
        const safeIp = ip.replace(/\./g, '-');
        const btnShare = document.getElementById(`btn-share-${safeIp}`);
        if (btnShare) {
            if (sharedIps.includes(ip)) {
                btnShare.className = "btn btn-warning btn-sm";
                btnShare.innerHTML = '<i class="fa-solid fa-square-share-nodes"></i> Đang chia sẻ';
            } else {
                btnShare.className = "btn btn-secondary btn-sm";
                btnShare.innerHTML = '<i class="fa-solid fa-share-nodes"></i> Chia sẻ bài';
            }
        }
    });
}

/* Khởi tạo CodeMirror cho Drawer soạn thảo code mẫu */
function initTemplateEditor() {
    const textarea = document.getElementById("template-code-editor");
    if (!textarea || templateEditor) return;
    
    templateEditor = CodeMirror.fromTextArea(textarea, {
        mode: "python",
        theme: "dracula",
        lineNumbers: true,
        indentUnit: 4,
        tabSize: 4,
        lineWrapping: true,
        matchBrackets: true,
        autoCloseBrackets: true,
        inputStyle: "contenteditable", // Gõ tiếng Việt & phím tắt
        extraKeys: {
            "Ctrl-3": function(editor) { editor.toggleComment(); },
            "Cmd-3": function(editor) { editor.toggleComment(); },
            "Backspace": function(editor) {
                if (editor.somethingSelected()) {
                    editor.replaceSelection("");
                    return;
                }
                return CodeMirror.Pass;
            },
            "Delete": function(editor) {
                if (editor.somethingSelected()) {
                    editor.replaceSelection("");
                    return;
                }
                return CodeMirror.Pass;
            }
        }
    });

    // Nạp code mẫu ban đầu
    templateEditor.setValue(teacherTemplateCode);

    // Đồng bộ code mẫu khi gõ (debounce)
    let templateSyncTimeout;
    templateEditor.on("change", (instance, changeObj) => {
        if (changeObj && changeObj.origin === "setValue") return;
        
        clearTimeout(templateSyncTimeout);
        templateSyncTimeout = setTimeout(() => {
            const code = templateEditor.getValue();
            teacherTemplateCode = code;
            socket.emit("teacher_template_sync", { code: code });
        }, 300);
    });

    // Đồng bộ dữ liệu đầu vào (stdin)
    const stdinInput = document.getElementById("template-stdin-input");
    if (stdinInput) {
        stdinInput.value = teacherTemplateStdin;
        let stdinSyncTimeout;
        stdinInput.addEventListener("input", () => {
            clearTimeout(stdinSyncTimeout);
            stdinSyncTimeout = setTimeout(() => {
                const stdin = stdinInput.value;
                teacherTemplateStdin = stdin;
                socket.emit("teacher_template_stdin_sync", { stdin: stdin });
            }, 300);
        });
    }

    // Kết quả console ban đầu
    if (teacherTemplateConsole) {
        renderTemplateConsoleOutput(teacherTemplateConsole);
    }

    // Nút chạy thử ví dụ
    const btnRunTemplate = document.getElementById("btn-run-template");
    if (btnRunTemplate) {
        btnRunTemplate.addEventListener("click", () => {
            const consoleBody = document.getElementById("template-console-output");
            const consoleStatus = document.querySelector(".template-console-status");
            if (consoleBody) {
                consoleBody.className = "console-body card-console-placeholder";
                consoleBody.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang chạy ví dụ...';
                if (consoleStatus) {
                    consoleStatus.textContent = "Đang chạy...";
                    consoleStatus.style.color = "#38bdf8";
                }
            }
            socket.emit("teacher_run_template_code", {
                code: templateEditor.getValue(),
                stdin: stdinInput ? stdinInput.value : ""
            });
        });
    }

    // Nút Chia sẻ trực tiếp
    const btnShareTemplateLive = document.getElementById("btn-share-template-live");
    if (btnShareTemplateLive) {
        btnShareTemplateLive.addEventListener("click", () => {
            const nextShareState = !isSharingTemplateLive;
            socket.emit("toggle_share_template_live", { share: nextShareState });
        });
    }
}

/* ==========================================================================
   CÁC HÀM TRỢ GIÚP GIAO DIỆN (UI HELPER FUNCTIONS)
   ========================================================================== */

function updateCapacityBadge() {
    const badge = document.getElementById("capacity-badge");
    if (badge) {
        badge.textContent = `Sĩ số: ${classCapacity > 0 ? classCapacity : 'Chưa thiết lập'}`;
    }
}

function updateActiveCountBadge() {
    const badge = document.getElementById("active-count-badge");
    if (!badge) return;
    
    let active = 0;
    Object.keys(students).forEach(ip => {
        if (students[ip].status === "online") {
            active++;
        }
    });
    badge.textContent = `Hoạt động: ${active}`;
}

function updateFreezeButtonUI(frozen) {
    const btn = document.getElementById("btn-freeze-all");
    if (!btn) return;
    
    const icon = btn.querySelector("i");
    const text = btn.querySelector("span");
    
    if (frozen) {
        btn.className = "btn btn-danger";
        icon.className = "fa-solid fa-unlock";
        text.textContent = "Mở Khóa Màn Hình";
        btn.title = "Mở khóa màn hình cho toàn bộ học sinh";
    } else {
        btn.className = "btn btn-warning";
        icon.className = "fa-solid fa-lock";
        text.textContent = "Khóa Màn Hình";
        btn.title = "Khóa màn hình toàn bộ học sinh";
    }
}

function updateExamButtonUI(examMode) {
    const btn = document.getElementById("btn-toggle-exam");
    if (!btn) return;
    
    const icon = btn.querySelector("i");
    const text = btn.querySelector("span");
    
    if (examMode) {
        btn.className = "btn btn-primary";
        icon.className = "fa-solid fa-eye";
        text.textContent = "Hiện Code Lớp Học";
        btn.title = "Hiển thị lại code học sinh trên màn hình máy chiếu";
    } else {
        btn.className = "btn btn-secondary";
        icon.className = "fa-solid fa-eye-slash";
        text.textContent = "Chế độ kiểm tra";
        btn.title = "Ẩn mã nguồn học sinh để tránh chép bài qua máy chiếu";
    }
}

/* ==========================================================================
   CÁC HÀM TIỆN ÍCH QUẢN LÝ TAB VÀ ĐỀ BÀI (TEACHER HELPERS)
   ========================================================================== */

/* Chuyển tab giáo viên đang xem của học sinh chỉ định */
window.switchTeacherViewedTab = function(ip, tabId) {
    viewedTabs[ip] = tabId;
    const student = students[ip];
    if (student) {
        // Nếu GV chuyển về đúng tab học sinh đang hoạt động thì gỡ pin (tự động theo dõi)
        if (student.active_tab_id === tabId) {
            pinnedTabs[ip] = false;
        } else {
            pinnedTabs[ip] = true;
        }
        // Vẽ lại slot card để nạp mã nguồn tab mới lên CodeMirror máy GV
        renderStudentSlot(ip, student);
    }
};

/* Cập nhật nhãn hiển thị trạng thái đề bài trên drawer */
function renderAssignmentStatus() {
    const statusEl = document.getElementById("current-assignment-status");
    if (!statusEl) return;
    
    if (currentAssignment.type === "none") {
        statusEl.textContent = "Chưa có đề bài";
        statusEl.style.color = "var(--danger)";
    } else {
        let label = "";
        if (currentAssignment.type === "text") {
            label = "Văn bản/Markdown";
        } else if (currentAssignment.type === "image") {
            label = `Hình ảnh (${currentAssignment.filename || 'đề bài.png'})`;
        } else if (currentAssignment.type === "pdf") {
            label = `Tài liệu PDF (${currentAssignment.filename || 'đề bài.pdf'})`;
        }
        statusEl.textContent = label;
        statusEl.style.color = "var(--success)";
    }
}

/* Lọc danh sách học sinh theo ô tìm kiếm */
function filterStudents() {
    const searchInput = document.getElementById("search-student-input");
    if (!searchInput) return;
    const query = searchInput.value.trim().toLowerCase();
    const normalizedQuery = removeVietnameseTones(query);
    
    const cards = document.querySelectorAll(".student-grid .student-card");
    cards.forEach(card => {
        if (card.classList.contains("empty-slot")) {
            // Ẩn ô trống khi đang tìm kiếm
            if (query === "") {
                card.style.display = "";
            } else {
                card.style.display = "none";
            }
            return;
        }
        
        const nameElement = card.querySelector(".card-student-name");
        if (nameElement) {
            const name = nameElement.textContent.toLowerCase();
            const normalizedName = removeVietnameseTones(name);
            
            if (name.includes(query) || normalizedName.includes(normalizedQuery)) {
                card.style.display = "";
            } else {
                card.style.display = "none";
            }
        }
    });
}

/* Loại bỏ dấu tiếng Việt để phục vụ tìm kiếm không dấu */
function removeVietnameseTones(str) {
    str = str.replace(/à|á|ạ|ả|ã|â|ầ|ấ|ậ|ẩ|ẫ|ă|ằ|ắ|ặ|ẳ|ẵ/g, "a");
    str = str.replace(/è|é|ẹ|ẻ|ẽ|ê|ề|ế|ệ|ể|ễ/g, "e");
    str = str.replace(/ì|í|ị|ỉ|ĩ/g, "i");
    str = str.replace(/ò|ó|ọ|ỏ|õ|ô|ồ|ố|ộ|ổ|ỗ|ơ|ờ|ớ|ợ|ở|ỡ/g, "o");
    str = str.replace(/ù|ú|ụ|ủ|ũ|ư|ừ|ứ|ự|ử|ữ/g, "u");
    str = str.replace(/ỳ|ý|ỵ|ỷ|ỹ/g, "y");
    str = str.replace(/đ/g, "d");
    str = str.replace(/À|Á|Ạ|Ả|Ã|Â|Ầ|Ấ|Ậ|Ẩ|Ẫ|Ă|Ằ|Ắ|Ặ|Ẳ|Ẵ/g, "A");
    str = str.replace(/È|É|Ẹ|Ẻ|Ẽ|Ê|Ề|Ế|Ệ|Ể|Ễ/g, "E");
    str = str.replace(/Ì|Í|Ị|Ỉ|Ĩ/g, "I");
    str = str.replace(/Ò|Ó|Ọ|Ỏ|Õ|Ô|Ồ|Ố|Ộ|Ổ|Ỗ|Ơ|Ờ|Ớ|Ợ|Ở|Ỡ/g, "O");
    str = str.replace(/Ù|Ú|Ụ|Ủ|Ũ|Ư|Ừ|Ứ|Ự|Ử|Ữ/g, "U");
    str = str.replace(/Ỳ|Ý|Ỵ|Ỷ|Ỹ/g, "Y");
    str = str.replace(/Đ/g, "D");
    str = str.replace(/\u0300|\u0301|\u0303|\u0309|\u0323/g, ""); 
    str = str.replace(/\u02C6|\u0306|\u031B/g, ""); 
    return str;
}

/* Đồng bộ dữ liệu đầu vào (stdin) do giáo viên sửa từ xa */
window.syncTeacherEditedStdin = function(ip) {
    const safeIp = ip.replace(/\./g, '-');
    const stdinInput = document.getElementById(`card-stdin-${safeIp}`);
    if (!stdinInput) return;
    
    // Ghi lại thời điểm GV gõ phím để chặn overwrite từ client
    lastTeacherStdinEditTimes[ip] = Date.now();
    
    // Đồng bộ về máy học sinh với cơ chế debounce
    clearTimeout(teacherStdinSyncTimeouts[ip]);
    teacherStdinSyncTimeouts[ip] = setTimeout(() => {
        const stdin = stdinInput.value;
        if (students[ip]) {
            students[ip].stdin = stdin;
        }
        socket.emit("teacher_edit_stdin", {
            target_ip: ip,
            stdin: stdin
        });
    }, 400); // Debounce 400ms
};

function updateShareLiveButtonUI(isSharing) {
    const btn = document.getElementById("btn-share-template-live");
    if (!btn) return;
    
    if (isSharing) {
        btn.className = "btn btn-warning";
        btn.innerHTML = '<i class="fa-solid fa-chalkboard-user"></i> Chia sẻ trực tiếp: Bật';
        btn.title = "Dừng chia sẻ trực tiếp ví dụ này cho học sinh";
    } else {
        btn.className = "btn btn-secondary";
        btn.innerHTML = '<i class="fa-solid fa-chalkboard-user"></i> Chia sẻ trực tiếp: Tắt';
        btn.title = "Chia sẻ trực tiếp code mẫu và kết quả chạy cho học sinh xem thời gian thực";
    }
}

function renderTemplateConsoleOutput(data) {
    const consoleBody = document.getElementById("template-console-output");
    const consoleStatus = document.querySelector(".template-console-status");
    if (!consoleBody) return;
    
    consoleBody.innerHTML = "";
    consoleBody.classList.remove("card-console-placeholder", "error");
    
    if (data.success) {
        consoleBody.textContent = data.stdout || "Chương trình chạy hoàn tất (Không có output).";
        if (consoleStatus) {
            consoleStatus.textContent = "Thành công";
            consoleStatus.style.color = "#10b981";
        }
    } else {
        consoleBody.classList.add("error");
        consoleBody.textContent = data.stderr || "Chương trình lỗi biên dịch/thực thi.";
        if (consoleStatus) {
            consoleStatus.textContent = `Lỗi (code ${data.exit_code})`;
            consoleStatus.style.color = "#ef4444";
        }
    }
    consoleBody.scrollTop = consoleBody.scrollHeight;
}

