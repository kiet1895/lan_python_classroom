// Khởi tạo kết nối Socket.IO
const socket = io();

// Các biến toàn cục
let editor = null;
let currentCode = "";
let isFrozen = false;
let handRaised = false;

// Trạng thái Multi-tab học sinh
let studentTabs = [
    { id: "tab_default", name: "Bài 1", code: "" }
];
let activeTabId = "tab_default";

// Trạng thái Right Pane học sinh (Đề bài & Bài chia sẻ)
let rightPaneActiveTab = "assignment";
let currentAssignment = { type: "none", content: "", filename: "" };
let currentSharedStudents = {}; // Cache danh sách bạn học đang được chia sẻ
let sharedStudentEditors = {}; // ip -> cm_instance (Phạm vi toàn cục)

// Trạng thái theo dõi trang đề bài để tránh phạt lỗi rời tab bằng cơ chế Heartbeat
const assignmentChannel = new BroadcastChannel('assignment_focus_channel');
let lastAssignmentHeartbeatTime = 0;

assignmentChannel.onmessage = (event) => {
    if (event.data.type === 'heartbeat') {
        lastAssignmentHeartbeatTime = event.data.timestamp;
    }
};

function triggerBlurWarning() {
    const warningOverlay = document.getElementById("blur-warning-overlay");
    if (warningOverlay && warningOverlay.classList.contains("d-none")) {
        socket.emit("blur_event");
        
        warningOverlay.classList.remove("d-none");
        warningOverlay.style.display = "flex";
        
        const violationsEl = document.getElementById("warning-violations-count");
        if (violationsEl) {
            const currentFaults = parseInt(document.getElementById("student-faults-count").textContent) || 0;
            violationsEl.textContent = currentFaults + 1;
        }
        
        if (editor) {
            editor.setOption("readOnly", "nocursor");
        }
    }
}

// Đợi DOM load xong
document.addEventListener("DOMContentLoaded", () => {
    initSocketEvents();
    initUIEvents();
    initResizer();
    
    // Nếu Flask xác nhận học sinh đã được nhận diện qua IP, tự khởi tạo workspace
    if (window.STUDENT_LOGGED_IN) {
        initWorkspace();
    }
});

/* ==========================================================================
   CẤU HÌNH LẮNG NGHE SỰ KIỆN SOCKET.IO
   ========================================================================== */
function initSocketEvents() {
    // Theo dõi trạng thái kết nối socket
    socket.on("connect", () => {
        updateConnectionStatus(true);
    });

    socket.on("disconnect", () => {
        updateConnectionStatus(false);
    });

    // Nhận phản hồi đăng nhập thành công
    socket.on("login_success", (student) => {
        document.getElementById("student-login-section").classList.add("d-none");
        document.getElementById("student-workspace-section").classList.remove("d-none");
        
        document.getElementById("student-display-name").textContent = student.name;
        document.getElementById("student-slot-badge").textContent = `Ô số: ${student.slot_id}`;
        document.getElementById("student-faults-count").textContent = student.faults;
        
        studentTabs = student.tabs || [
            { id: "tab_default", name: "Bài 1", code: student.code || "" }
        ];
        activeTabId = student.active_tab_id || "tab_default";
        
        const activeTab = studentTabs.find(t => t.id === activeTabId);
        currentCode = activeTab ? activeTab.code : (student.code || "");
        
        initWorkspace();
        renderTabs();
    });

    // Nhận phản hồi đăng nhập thất bại (Ví dụ: Lớp đầy)
    socket.on("login_failed", (data) => {
        const errorBanner = document.getElementById("login-error-banner");
        const errorText = document.getElementById("login-error-text");
        errorBanner.classList.remove("d-none");
        errorText.textContent = data.message;
        
        // Mở khóa nút đăng nhập
        document.getElementById("btn-student-login").disabled = false;
    });

    // Khôi phục session khi tải lại trang (Resilience)
    socket.on("restore_session", (data) => {
        document.getElementById("student-login-section").classList.add("d-none");
        document.getElementById("student-workspace-section").classList.remove("d-none");
        
        document.getElementById("student-display-name").textContent = data.name;
        document.getElementById("student-slot-badge").textContent = `Ô số: ${data.slot_id}`;
        document.getElementById("student-faults-count").textContent = data.faults;
        
        handRaised = data.hand_raised;
        const btnRaiseHand = document.getElementById("btn-raise-hand");
        if (btnRaiseHand) {
            if (handRaised) {
                btnRaiseHand.classList.add("hand-raised");
            } else {
                btnRaiseHand.classList.remove("hand-raised");
            }
        }
        
        studentTabs = data.tabs || [
            { id: "tab_default", name: "Bài 1", code: data.code || "" }
        ];
        activeTabId = data.active_tab_id || "tab_default";
        
        const activeTab = studentTabs.find(t => t.id === activeTabId);
        currentCode = activeTab ? activeTab.code : (data.code || "");
        isFrozen = data.is_frozen;
        
        initWorkspace();
        if (editor) {
            editor.setValue(currentCode);
        }
        renderTabs();
        applyFreezeState(isFrozen);
        
        if (data.assignment) {
            renderAssignment(data.assignment);
        }
    });

    // Giáo viên làm mới buổi học -> Tải lại trang để đăng nhập mới
    socket.on("session_reset", () => {
        window.location.reload();
    });

    // Cập nhật cảnh báo số lỗi từ server
    socket.on("fault_warning", (data) => {
        document.getElementById("student-faults-count").textContent = data.faults;
        const faultBadge = document.getElementById("fault-badge-container");
        if (data.faults > 0) {
            faultBadge.classList.add("warning-high");
        }
    });

    // Trạng thái khóa màn hình toàn cục từ giáo viên
    socket.on("freeze_status", (data) => {
        isFrozen = data.frozen;
        applyFreezeState(isFrozen);
    });

    // Nhận code mẫu từ giáo viên (Ghi đè trình soạn thảo)
    socket.on("load_template", (data) => {
        if (editor) {
            editor.setValue(data.code);
        } else {
            currentCode = data.code;
        }
    });

    // Nhận kết quả chạy thử code của học sinh
    socket.on("student_run_result", (data) => {
        const consoleOutput = document.getElementById("console-output");
        consoleOutput.innerHTML = ""; // Xóa placeholder
        
        // Khôi phục trạng thái nút Tự Chạy Code
        const btnRun = document.getElementById("btn-student-run");
        if (btnRun) {
            btnRun.disabled = false;
            btnRun.innerHTML = '<i class="fa-solid fa-play"></i> Tự Chạy Code';
        }
        
        if (data.success) {
            const stdoutSpan = document.createElement("span");
            stdoutSpan.textContent = data.stdout || "Chương trình chạy thành công (Không có kết quả in ra stdout).";
            consoleOutput.appendChild(stdoutSpan);
        } else {
            const errorSpan = document.createElement("span");
            errorSpan.className = "console-error";
            errorSpan.textContent = data.stderr || "Chương trình kết thúc với mã lỗi.";
            consoleOutput.appendChild(errorSpan);
        }
        // Tự cuộn console xuống cuối
        const consoleBody = document.getElementById("student-console").querySelector(".console-body");
        consoleBody.scrollTop = consoleBody.scrollHeight;
    });

    // Nhận phản hồi đồng bộ code do giáo viên sửa trực tiếp
    socket.on("teacher_code_sync", (data) => {
        const tab_id = data.tab_id || "tab_default";
        const code = data.code || "";
        
        const tab = studentTabs.find(t => t.id === tab_id);
        if (tab) {
            tab.code = code;
        }
        
        if (tab_id === activeTabId && editor && editor.getValue() !== code) {
            if (!code) {
                editor.setValue("");
            } else {
                const cursor = editor.getCursor();
                const scrollInfo = editor.getScrollInfo();
                editor.setValue(code);
                
                try {
                    const lineCount = editor.lineCount();
                    let line = Math.max(0, Math.min(cursor.line, lineCount - 1));
                    const lineLength = (editor.getLine(line) || "").length;
                    let ch = Math.max(0, Math.min(cursor.ch, lineLength));
                    editor.setCursor({ line: line, ch: ch });
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
    });

    // Nhận cập nhật đề bài mới từ giáo viên
    socket.on("assignment_updated", (assignment) => {
        renderAssignment(assignment);
    });

    // Lắng nghe bản tin cập nhật danh sách bài làm được chia sẻ
    socket.on("shared_codes_update", (data) => {
        const sharedStudents = data.shared_students || {};
        currentSharedStudents = sharedStudents; // Cập nhật cache
        
        const container = document.getElementById("shared-editors-container");
        const panel = document.getElementById("right-pane");
        const resizer = document.getElementById("workspace-resizer");
        const workspaceMain = document.getElementById("student-workspace-main");
        
        if (!container || !panel || !workspaceMain) return;
        
        const sharedIps = Object.keys(sharedStudents);
        
        // Nếu không có bài nào được chia sẻ
        if (sharedIps.length === 0) {
            container.innerHTML = "";
            sharedStudentEditors = {};
            
            // Ẩn chấm đỏ thông báo
            const notiDot = document.getElementById("shared-noti-dot");
            if (notiDot) notiDot.classList.add("d-none");
            
            checkRightPaneVisibility();
            return;
        }
        
        // Hiện panel chia sẻ
        panel.classList.remove("d-none");
        if (resizer) resizer.classList.remove("d-none");
        workspaceMain.classList.add("has-shared");
        
        // Loại bỏ các editor của các máy đã bị ngừng chia sẻ
        Object.keys(sharedStudentEditors).forEach(ip => {
            if (!sharedStudents[ip]) {
                const el = document.getElementById(`shared-card-${ip.replace(/\./g, '-')}`);
                if (el) el.remove();
                delete sharedStudentEditors[ip];
            }
        });
        
        // Tạo mới hoặc cập nhật nội dung các bài đang chia sẻ
        sharedIps.forEach(ip => {
            const studentInfo = sharedStudents[ip];
            const safeIp = ip.replace(/\./g, '-');
            let card = document.getElementById(`shared-card-${safeIp}`);
            
            if (!card) {
                card = document.createElement("div");
                card.className = "shared-student-card glass-panel";
                card.id = `shared-card-${safeIp}`;
                card.innerHTML = `
                    <div class="shared-card-header">
                        <span><i class="fa-solid fa-user"></i> Bạn học: <strong>${studentInfo.name}</strong> (Mở Ô số ${studentInfo.slot_id})</span>
                    </div>
                    <div class="shared-card-body">
                        <textarea id="shared-editor-${safeIp}"></textarea>
                    </div>
                `;
                container.appendChild(card);
                
                const textarea = document.getElementById(`shared-editor-${safeIp}`);
                const cm = CodeMirror.fromTextArea(textarea, {
                    mode: "python",
                    theme: "dracula",
                    lineNumbers: true,
                    readOnly: true, // Bài của bạn chỉ được phép xem
                    lineWrapping: true,
                    inputStyle: "contenteditable"
                });
                cm.setValue(studentInfo.code || "");
                sharedStudentEditors[ip] = cm;
            } else {
                const cm = sharedStudentEditors[ip];
                if (cm && cm.getValue() !== studentInfo.code) {
                    cm.setValue(studentInfo.code || "");
                }
            }
        });
    });

    // Lắng nghe bản tin đồng bộ thay đổi code của bài đang chia sẻ
    socket.on("shared_code_sync", (data) => {
        const ip = data.ip;
        const code = data.code;
        const cm = sharedStudentEditors[ip];
        if (cm && cm.getValue() !== code) {
            cm.setValue(code);
        }
    });
}

/* ==========================================================================
   CẤU HÌNH SỰ KIỆN GIAO DIỆN NGƯỜI DÙNG (UI EVENTS)
   ========================================================================== */
function initUIEvents() {
    // Form đăng nhập của học sinh
    const loginForm = document.getElementById("student-login-form");
    if (loginForm) {
        loginForm.addEventListener("submit", () => {
            const nameInput = document.getElementById("student-name-input");
            const name = nameInput.value.trim();
            if (name.length >= 2) {
                // Tạm khóa nút tránh click liên tục
                document.getElementById("btn-student-login").disabled = true;
                socket.emit("student_login", { name: name });
            }
        });
    }

    // Nút giơ tay trợ giúp
    const btnRaiseHand = document.getElementById("btn-raise-hand");
    if (btnRaiseHand) {
        btnRaiseHand.addEventListener("click", () => {
            if (isFrozen) return; // Bị khóa thì không được tương tác
            handRaised = !handRaised;
            
            if (handRaised) {
                btnRaiseHand.classList.add("hand-raised");
            } else {
                btnRaiseHand.classList.remove("hand-raised");
            }
            socket.emit("raise_hand", { raised: handRaised });
        });
    }

    // Nút tự chạy code của học sinh
    const btnStudentRun = document.getElementById("btn-student-run");
    if (btnStudentRun) {
        btnStudentRun.addEventListener("click", () => {
            if (isFrozen) return;
            
            btnStudentRun.disabled = true;
            btnStudentRun.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang chạy...';
            
            const consoleOutput = document.getElementById("console-output");
            consoleOutput.innerHTML = '<span class="console-placeholder"><i class="fa-solid fa-spinner fa-spin"></i> Đang thực thi mã nguồn trên hệ thống sandbox...</span>';
            
            // Đồng bộ code tức thời trước khi chạy thử
            if (editor) {
                const code = editor.getValue();
                const activeTab = studentTabs.find(t => t.id === activeTabId);
                if (activeTab) {
                    activeTab.code = code;
                }
                socket.emit("code_sync", { tab_id: activeTabId, code: code });
            }
            
            socket.emit("student_run_own_code");
        });
    }

    // Nút xóa console kết quả
    const btnClearConsole = document.getElementById("btn-clear-console");
    if (btnClearConsole) {
        btnClearConsole.addEventListener("click", () => {
            const consoleOutput = document.getElementById("console-output");
            consoleOutput.innerHTML = '<span class="console-placeholder">Chờ chạy chương trình... kết quả in ra sẽ xuất hiện ở đây.</span>';
        });
    }

    // Theo dõi sự kiện blur/focus tab để báo lỗi mất tập trung
    let blurTimeout = null;

    window.addEventListener("blur", () => {
        if (editor && !isFrozen) {
            // Đợi một khoảng ngắn xem có phải học sinh chuyển sang tab đề bài không hoặc đang tương tác với iframe nhúng
            blurTimeout = setTimeout(() => {
                if (document.hasFocus()) {
                    console.log("Tài liệu chính vẫn giữ focus (đang tương tác với iframe nhúng), bỏ qua.");
                    return;
                }
                const now = Date.now();
                // Nếu vừa nhận được heartbeat từ tab xem đề bài trong vòng 1200ms, bỏ qua cảnh báo
                if (now - lastAssignmentHeartbeatTime < 1200) {
                    console.log("Học sinh đang ở tab xem đề bài (nhận được heartbeat), bỏ qua.");
                    return;
                }
                triggerBlurWarning();
            }, 300);
        }
    });

    window.addEventListener("focus", () => {
        if (blurTimeout) {
            clearTimeout(blurTimeout);
            blurTimeout = null;
        }
    });

    // Định kỳ kiểm tra (Heartbeat check) để phát hiện khi học sinh thoát ra khỏi cả hai trang
    setInterval(() => {
        if (editor && !isFrozen) {
            // Chỉ kiểm tra khi trang làm bài chính không có focus
            if (!document.hasFocus()) {
                const now = Date.now();
                // Nếu lần cuối cùng nhận được heartbeat từ trang đề bài cách đây quá 1800ms
                if (now - lastAssignmentHeartbeatTime > 1800) {
                    triggerBlurWarning();
                }
            }
        }
    }, 500);

    // Nút quay lại làm bài
    const btnResumeWork = document.getElementById("btn-resume-work");
    if (btnResumeWork) {
        btnResumeWork.addEventListener("click", () => {
            const warningOverlay = document.getElementById("blur-warning-overlay");
            if (warningOverlay) {
                warningOverlay.classList.add("d-none");
                warningOverlay.style.display = "none";
            }
            
            // Mở khóa soạn thảo nếu giáo viên không khóa màn hình chính
            if (!isFrozen) {
                editor.setOption("readOnly", false);
            }
            
            // Tự động focus con trỏ vào ô soạn thảo
            editor.focus();
        });
    }

    // Nút mở/đóng và chuyển đổi Pane đề bài bên phải
    const btnToggleAssignment = document.getElementById("btn-toggle-assignment-pane");
    if (btnToggleAssignment) {
        btnToggleAssignment.addEventListener("click", () => {
            const rightPane = document.getElementById("right-pane");
            const resizer = document.getElementById("workspace-resizer");
            const workspaceMain = document.getElementById("student-workspace-main");
            if (!rightPane) return;
            
            if (rightPane.classList.contains("d-none")) {
                rightPane.classList.remove("d-none");
                if (resizer) resizer.classList.remove("d-none");
                if (workspaceMain) workspaceMain.classList.add("has-shared");
                switchRightPaneTab("assignment");
            } else {
                if (rightPaneActiveTab === "assignment") {
                    rightPane.classList.add("d-none");
                    if (resizer) resizer.classList.add("d-none");
                    if (workspaceMain) {
                        workspaceMain.classList.remove("has-shared");
                        workspaceMain.style.gridTemplateColumns = ""; // Reset grid columns inline CSS
                    }
                } else {
                    switchRightPaneTab("assignment");
                }
            }
        });
    }

    // Sự kiện chuyển đổi tab Pane bên phải
    const tabBtnAssignment = document.getElementById("pane-tab-assignment");
    if (tabBtnAssignment) {
        tabBtnAssignment.addEventListener("click", () => {
            switchRightPaneTab("assignment");
        });
    }

    const tabBtnShared = document.getElementById("pane-tab-shared");
    if (tabBtnShared) {
        tabBtnShared.addEventListener("click", () => {
            switchRightPaneTab("shared");
        });
    }
}

/* ==========================================================================
   KHỞI TẠO KHÔNG GIAN SOẠN THẢO (CODEMIRROR WORKSPACE)
   ========================================================================== */
function initWorkspace() {
    const textarea = document.getElementById("student-code-editor");
    if (!textarea || editor) return; // Nếu không có hoặc đã khởi tạo rồi thì bỏ qua
    
    // Cấu hình CodeMirror 5
    editor = CodeMirror.fromTextArea(textarea, {
        mode: "python",
        theme: "dracula",
        lineNumbers: true,
        indentUnit: 4,
        tabSize: 4,
        indentWithTabs: false,
        lineWrapping: true,
        inputStyle: "contenteditable", // Cấu hình bắt buộc để gõ tiếng Việt Telex/VNI và hỗ trợ các phím tắt ctrl+a, ctrl+c...
        extraKeys: { 
            "Tab": "defaultTab",
            "Ctrl-3": function(cm) { cm.toggleComment(); },
            "Cmd-3": function(cm) { cm.toggleComment(); },
            "Backspace": function(cm) {
                if (cm.somethingSelected()) {
                    cm.replaceSelection("");
                    return;
                }
                return CodeMirror.Pass;
            },
            "Delete": function(cm) {
                if (cm.somethingSelected()) {
                    cm.replaceSelection("");
                    return;
                }
                return CodeMirror.Pass;
            }
        }
    });
    
    // Nạp code ban đầu
    editor.setValue(currentCode);
    
    // Cơ chế Debounce gửi code đồng bộ lên server để giảm tải lưu lượng mạng
    let syncTimeout;
    editor.on("change", (instance, changeObj) => {
        if (isFrozen) return; // Nếu bị khóa thì không đồng bộ
        // Bỏ qua các thay đổi do chương trình đặt giá trị (setValue) để tránh vòng lặp đồng bộ vô hạn
        if (changeObj && changeObj.origin === "setValue") return;
        
        clearTimeout(syncTimeout);
        syncTimeout = setTimeout(() => {
            const code = editor.getValue();
            socket.emit("code_sync", { tab_id: activeTabId, code: code });
        }, 400); // Trì hoãn 400ms trước khi gửi
    });
}

/* ==========================================================================
   CÁC HÀM TRỢ GIÚP GIAO DIỆN (UI HELPER FUNCTIONS)
   ========================================================================== */

function updateConnectionStatus(isConnected) {
    const dot = document.getElementById("status-dot");
    const text = document.getElementById("status-text");
    
    if (!dot || !text) return;
    
    if (isConnected) {
        dot.className = "status-dot green";
        text.textContent = "Đang kết nối";
    } else {
        dot.className = "status-dot red";
        text.textContent = "Mất kết nối";
    }
}

function applyFreezeState(frozen) {
    const overlay = document.getElementById("freeze-overlay");
    if (!overlay) return;
    
    if (frozen) {
        overlay.classList.remove("d-none");
        if (editor) {
            editor.setOption("readOnly", "nocursor"); // Khóa hẳn cursor, không cho bôi đen/copy/soạn thảo
        }
    } else {
        overlay.classList.add("d-none");
        if (editor) {
            editor.setOption("readOnly", false); // Mở khóa soạn thảo
        }
    }
}

/* ==========================================================================
   QUẢN LÝ TAB SOẠN THẢO (EDITOR TABS MANAGEMENT)
   ========================================================================== */
function renderTabs() {
    const tabsBar = document.getElementById("editor-tabs-bar");
    if (!tabsBar) return;
    
    tabsBar.innerHTML = "";
    
    studentTabs.forEach(tab => {
        const tabEl = document.createElement("div");
        tabEl.className = `editor-tab ${tab.id === activeTabId ? 'active' : ''}`;
        tabEl.dataset.id = tab.id;
        
        tabEl.innerHTML = `
            <span class="tab-title" title="Nhấp đúp chuột để đổi tên">${tab.name}</span>
            ${studentTabs.length > 1 ? '<i class="fa-solid fa-xmark tab-close-btn" title="Đóng tab"></i>' : ''}
        `;
        
        // Sự kiện click chuyển tab hoặc đóng tab
        tabEl.addEventListener("click", (e) => {
            if (e.target.classList.contains("tab-close-btn")) {
                e.stopPropagation();
                closeTab(tab.id);
            } else {
                switchTab(tab.id);
            }
        });
        
        // Sự kiện double click đổi tên tab
        tabEl.addEventListener("dblclick", () => {
            if (isFrozen) return;
            renameTab(tab.id);
        });
        
        tabsBar.appendChild(tabEl);
    });
    
    // Nút thêm tab mới
    const addBtn = document.createElement("button");
    addBtn.className = "btn-add-tab";
    addBtn.id = "btn-add-editor-tab";
    addBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';
    addBtn.title = "Tạo tab mới";
    addBtn.onclick = createNewTab;
    tabsBar.appendChild(addBtn);
}

function switchTab(tabId) {
    if (tabId === activeTabId) return;
    
    // Lưu code tab hiện tại vào bộ nhớ cục bộ trước khi chuyển
    if (editor) {
        const activeTab = studentTabs.find(t => t.id === activeTabId);
        if (activeTab) {
            activeTab.code = editor.getValue();
        }
    }
    
    activeTabId = tabId;
    const nextTab = studentTabs.find(t => t.id === tabId);
    if (nextTab && editor) {
        editor.setValue(nextTab.code || "");
        editor.focus();
    }
    
    socket.emit("student_switch_tab", { tab_id: tabId });
    renderTabs();
}

function showCustomDialog({ title, message, showInput, defaultValue, placeholder, onOk, onCancel }) {
    const modal = document.getElementById("custom-dialog-modal");
    const titleEl = document.getElementById("custom-dialog-title");
    const messageEl = document.getElementById("custom-dialog-message");
    const inputContainer = document.getElementById("custom-dialog-input-container");
    const inputEl = document.getElementById("custom-dialog-input");
    const btnCancel = document.getElementById("btn-custom-dialog-cancel");
    const btnOk = document.getElementById("btn-custom-dialog-ok");

    if (!modal) return;

    titleEl.textContent = title || "Thông báo";
    messageEl.textContent = message || "";
    
    if (showInput) {
        inputContainer.style.display = "block";
        inputEl.value = defaultValue || "";
        inputEl.placeholder = placeholder || "";
    } else {
        inputContainer.style.display = "none";
    }

    modal.classList.remove("d-none");
    modal.style.display = "flex";
    
    if (showInput) {
        setTimeout(() => {
            inputEl.focus();
            inputEl.select();
        }, 50);
    }

    const escHandler = (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            btnCancel.click();
        }
    };
    window.addEventListener("keydown", escHandler);

    function cleanup() {
        modal.classList.add("d-none");
        modal.style.display = "none";
        inputEl.onkeydown = null;
        window.removeEventListener("keydown", escHandler);
        if (editor) {
            editor.focus();
        }
    }

    btnOk.onclick = () => {
        const val = showInput ? inputEl.value : true;
        cleanup();
        if (onOk) onOk(val);
    };

    btnCancel.onclick = () => {
        cleanup();
        if (onCancel) onCancel();
    };

    inputEl.onkeydown = (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            btnOk.click();
        }
    };
}

function createNewTab() {
    if (isFrozen) return;
    
    const tabNum = studentTabs.length + 1;
    showCustomDialog({
        title: "Tạo Tab Bài Làm Mới",
        message: "Vui lòng nhập tên cho tab bài làm mới của bạn:",
        showInput: true,
        defaultValue: `Bài ${tabNum}`,
        placeholder: "Ví dụ: Bài 2",
        onOk: (name) => {
            const cleanName = name.trim() || `Bài ${tabNum}`;
            const tabId = "tab_" + Date.now();
            
            // Lưu code tab hiện tại
            if (editor) {
                const activeTab = studentTabs.find(t => t.id === activeTabId);
                if (activeTab) {
                    activeTab.code = editor.getValue();
                }
            }
            
            const newTab = { id: tabId, name: cleanName, code: "" };
            studentTabs.push(newTab);
            activeTabId = tabId;
            
            if (editor) {
                editor.setValue("");
                editor.focus();
            }
            
            // Phải gửi cả sự kiện tạo tab và switch tab để đồng bộ tab active mới lên server ngay lập tức
            socket.emit("student_create_tab", { tab_id: tabId, name: cleanName });
            socket.emit("student_switch_tab", { tab_id: tabId });
            renderTabs();
        }
    });
}

function closeTab(tabId) {
    if (isFrozen) return;
    if (studentTabs.length <= 1) return;
    
    showCustomDialog({
        title: "Xác Nhận Đóng Tab",
        message: "Bạn có chắc chắn muốn đóng tab này? Mã nguồn trong tab này sẽ bị xóa hoàn toàn.",
        showInput: false,
        onOk: () => {
            const idx = studentTabs.findIndex(t => t.id === tabId);
            if (idx === -1) return;
            
            studentTabs.splice(idx, 1);
            socket.emit("student_delete_tab", { tab_id: tabId });
            
            if (activeTabId === tabId) {
                activeTabId = studentTabs[0].id;
                if (editor) {
                    editor.setValue(studentTabs[0].code || "");
                    editor.focus();
                }
                // Đồng bộ tab active mới sau khi xóa tab hiện tại
                socket.emit("student_switch_tab", { tab_id: activeTabId });
            }
            renderTabs();
        }
    });
}

function renameTab(tabId) {
    if (isFrozen) return;
    const tab = studentTabs.find(t => t.id === tabId);
    if (!tab) return;
    
    showCustomDialog({
        title: "Đổi Tên Tab Bài Làm",
        message: "Nhập tên mới cho tab bài làm của bạn:",
        showInput: true,
        defaultValue: tab.name,
        placeholder: "Ví dụ: Bài 1A",
        onOk: (newName) => {
            const cleanName = newName.trim();
            if (cleanName === "") return;
            
            tab.name = cleanName;
            socket.emit("student_rename_tab", { tab_id: tabId, name: cleanName });
            renderTabs();
        }
    });
}

/* ==========================================================================
   QUẢN LÝ RIGHT PANE & ĐỀ BÀI (RIGHT PANE & ASSIGNMENT MANAGEMENT)
   ========================================================================== */
function switchRightPaneTab(tab) {
    rightPaneActiveTab = tab;
    
    const btnAssignment = document.getElementById("pane-tab-assignment");
    const btnShared = document.getElementById("pane-tab-shared");
    const contentAssignment = document.getElementById("pane-content-assignment");
    const contentShared = document.getElementById("pane-content-shared");
    
    if (!btnAssignment || !btnShared || !contentAssignment || !contentShared) return;
    
    if (tab === "assignment") {
        btnAssignment.classList.add("active");
        btnShared.classList.remove("active");
        contentAssignment.classList.remove("d-none");
        contentShared.classList.add("d-none");
    } else {
        btnAssignment.classList.remove("active");
        btnShared.classList.add("active");
        contentAssignment.classList.add("d-none");
        contentShared.classList.remove("d-none");
        
        // Ẩn chấm đỏ thông báo
        const notiDot = document.getElementById("shared-noti-dot");
        if (notiDot) notiDot.classList.add("d-none");
        
        // Tự động refresh các editor chia sẻ để tránh lỗi vỡ dòng do CodeMirror ẩn trước đó
        setTimeout(() => {
            Object.values(sharedStudentEditors).forEach(cm => cm.refresh());
        }, 50);
    }
}

function checkRightPaneVisibility() {
    const rightPane = document.getElementById("right-pane");
    const workspaceMain = document.getElementById("student-workspace-main");
    const resizer = document.getElementById("workspace-resizer");
    if (!rightPane || !workspaceMain) return;
    
    const hasAssignment = currentAssignment && currentAssignment.type !== "none";
    const hasShared = Object.keys(currentSharedStudents).length > 0;
    
    if (!hasAssignment && !hasShared) {
        rightPane.classList.add("d-none");
        if (resizer) resizer.classList.add("d-none");
        workspaceMain.classList.remove("has-shared");
        workspaceMain.style.gridTemplateColumns = ""; // Reset custom grid sizing
    } else {
        rightPane.classList.remove("d-none");
        if (resizer) resizer.classList.remove("d-none");
        workspaceMain.classList.add("has-shared");
    }
}

function renderAssignment(assignment) {
    currentAssignment = assignment || { 
        type: "none", 
        content: "", 
        filename: "",
        description: "",
        file_url: "",
        file_type: "none",
        file_name: ""
    };
    const viewport = document.getElementById("assignment-viewport");
    if (!viewport) return;
    
    viewport.innerHTML = "";
    
    const hasDescription = currentAssignment.description && currentAssignment.description.trim() !== "";
    const hasFile = currentAssignment.file_url && currentAssignment.file_url.trim() !== "" && currentAssignment.file_type !== "none";
    
    if (!hasDescription && !hasFile) {
        viewport.innerHTML = '<div class="no-assignment">Chưa có đề bài từ Giáo viên.</div>';
        checkRightPaneVisibility();
        return;
    }
    
    // Tự động mở Pane bên phải và nhảy tới tab Đề bài khi giáo viên giao đề mới
    const rightPane = document.getElementById("right-pane");
    const workspaceMain = document.getElementById("student-workspace-main");
    const resizer = document.getElementById("workspace-resizer");
    if (rightPane && rightPane.classList.contains("d-none")) {
        rightPane.classList.remove("d-none");
        if (resizer) resizer.classList.remove("d-none");
        if (workspaceMain) workspaceMain.classList.add("has-shared");
    }
    switchRightPaneTab("assignment");
    
    // 1. Render mô tả văn bản/Markdown nếu có
    if (hasDescription) {
        const descDiv = document.createElement("div");
        descDiv.className = "assignment-description-view";
        descDiv.innerHTML = parseMarkdown(currentAssignment.description);
        viewport.appendChild(descDiv);
    }
    
    // 2. Render tệp đính kèm nếu có
    if (hasFile) {
        const attachContainer = document.createElement("div");
        attachContainer.className = "assignment-attachment-container";
        
        const label = document.createElement("div");
        label.className = "assignment-attachment-label";
        label.innerHTML = `<i class="fa-solid fa-paperclip"></i> Tệp đính kèm: <strong>${currentAssignment.file_name || "File"}</strong>`;
        attachContainer.appendChild(label);
        
        if (currentAssignment.file_type === "image") {
            const img = document.createElement("img");
            img.className = "assignment-image-view";
            img.src = currentAssignment.file_url;
            img.alt = currentAssignment.file_name || "Đề bài hình ảnh";
            img.title = "Click để xem kích thước đầy đủ";
            img.onclick = () => window.open(currentAssignment.file_url, "_blank");
            attachContainer.appendChild(img);
        } else if (currentAssignment.file_type === "pdf") {
            const iframe = document.createElement("iframe");
            iframe.className = "assignment-pdf-view";
            iframe.src = currentAssignment.file_url;
            attachContainer.appendChild(iframe);
        }
        viewport.appendChild(attachContainer);
    }
}

function parseMarkdown(text) {
    if (!text) return "";
    
    let html = text;
    
    // Escape HTML to prevent injection
    html = html
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
        
    // Headers
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
    
    // Bold
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    
    // Italic
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    
    // Bullet points
    html = html.replace(/^\- (.*$)/gim, '<ul><li>$1</li></ul>');
    html = html.replace(/<\/ul>\s*<ul>/g, '');
    
    // Images: ![alt](url)
    html = html.replace(/!\[(.*?)\]\((.*?)\)/g, '<img class="assignment-inline-image" src="$2" alt="$1" onclick="window.open(\'$2\', \'_blank\')" />');
    
    // Links: [text](url)
    html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank">$1</a>');
    
    // Newlines to br
    html = html.replace(/\n/g, '<br>');
    
    return html;
}

// Khởi tạo thanh kéo chia tỷ lệ màn hình (Drag Resizer Splitter)
function initResizer() {
    const resizer = document.getElementById("workspace-resizer");
    const workspaceMain = document.getElementById("student-workspace-main");
    const leftPane = document.querySelector(".workspace-left");
    const rightPane = document.getElementById("right-pane");
    
    if (!resizer || !workspaceMain || !leftPane || !rightPane) return;
    
    let isDragging = false;
    
    resizer.addEventListener("mousedown", (e) => {
        isDragging = true;
        document.body.style.cursor = "col-resize";
        resizer.classList.add("dragging");
        e.preventDefault(); // Tránh bôi đen văn bản khi kéo
    });
    
    document.addEventListener("mousemove", (e) => {
        if (!isDragging) return;
        
        const containerWidth = workspaceMain.clientWidth;
        const mouseX = e.clientX;
        const containerRect = workspaceMain.getBoundingClientRect();
        
        let rightWidth = containerRect.right - mouseX;
        
        // Giới hạn chiều rộng nhỏ nhất và lớn nhất của Pane đề bài
        const minRightWidth = 300;
        const maxRightWidth = containerWidth * 0.7; // Không cho phép đề bài chiếm quá 70% màn hình
        
        if (rightWidth < minRightWidth) {
            rightWidth = minRightWidth;
        } else if (rightWidth > maxRightWidth) {
            rightWidth = maxRightWidth;
        }
        
        // Thiết lập kích thước cột Grid động
        workspaceMain.style.gridTemplateColumns = `1fr 6px ${rightWidth}px`;
        
        // Refresh editor chính của học sinh để chỉnh lại kích thước dòng vẽ CodeMirror
        if (editor) editor.refresh();
        // Refresh các editor chia sẻ đang hiển thị để căn lề chuẩn
        Object.values(sharedStudentEditors).forEach(cm => cm.refresh());
    });
    
    document.addEventListener("mouseup", () => {
        if (isDragging) {
            isDragging = false;
            document.body.style.cursor = "default";
            resizer.classList.remove("dragging");
        }
    });
}
