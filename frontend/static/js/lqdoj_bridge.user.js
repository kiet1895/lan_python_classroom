// ==UserScript==
// @name         LQDOJ Bridge
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Cầu nối tự động gửi và chấm bài LQDOJ cho lớp học Python
// @author       Antigravity
// @match        *://lqdoj.edu.vn/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.6.1/socket.io.min.js
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    console.log("[LQDOJ Bridge] Đang khởi động cầu nối...");

    // Kết nối tới server Socket.IO lớp học ở localhost
    const socket = io("http://localhost:5001");

    socket.on("connect", () => {
        console.log("[LQDOJ Bridge] 🟢 Đã kết nối với server lớp học!");
        socket.emit("register_lqdoj_bridge");
    });

    socket.on("disconnect", () => {
        console.log("[LQDOJ Bridge] 🔴 Mất kết nối với server lớp học.");
    });

    // Nhận yêu cầu nộp bài từ server
    socket.on("lqdoj_submit_request", async (data) => {
        const { submission_id, student_ip, student_name, problem_id, problem_name, submit_url, code } = data;
        console.log(`[LQDOJ Bridge] Nhận yêu cầu nộp bài: ${problem_name} cho học sinh ${student_name} (${student_ip})`);

        try {
            // Bước 1: GET trang nộp bài để trích xuất CSRF Token và Lang
            updateStatus(submission_id, student_ip, "submitting", "Đang lấy mã xác thực CSRF từ LQDOJ...");
            
            const getResp = await fetch(submit_url);
            if (!getResp.ok) throw new Error("Không thể truy cập trang nộp bài LQDOJ. Kiểm tra lại kết nối mạng.");
            
            const htmlText = await getResp.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlText, "text/html");
            
            // Tìm CSRF Token
            const csrfInput = doc.querySelector("input[name='csrfmiddlewaretoken']");
            if (!csrfInput) throw new Error("Không tìm thấy CSRF Token. Hãy chắc chắn bạn đã đăng nhập tài khoản Giáo viên trên lqdoj.edu.vn.");
            const csrfToken = csrfInput.value;

            // Xác định ngôn ngữ lập trình Python 3
            let languageVal = "py3"; // mặc định
            const langSelect = doc.querySelector("select[name='language']");
            if (langSelect) {
                const options = Array.from(langSelect.options);
                const py3Opt = options.find(opt => 
                    opt.text.toLowerCase().includes("python 3") || 
                    opt.value.toLowerCase().includes("py3") || 
                    opt.value.toLowerCase().includes("python3")
                );
                if (py3Opt) {
                    languageVal = py3Opt.value;
                }
            }

            // Bước 2: Submit code qua POST request
            updateStatus(submission_id, student_ip, "submitting", "Đang gửi mã nguồn của học sinh lên LQDOJ...");
            
            const formData = new FormData();
            formData.append("csrfmiddlewaretoken", csrfToken);
            formData.append("language", languageVal);
            formData.append("source", code);

            let actionUrl = submit_url;
            const submitForm = doc.querySelector("form");
            if (submitForm && submitForm.getAttribute("action")) {
                actionUrl = new URL(submitForm.getAttribute("action"), submit_url).href;
            }

            const postResp = await fetch(actionUrl, {
                method: "POST",
                body: formData,
                redirect: "follow"
            });

            // Lấy URL chuyển hướng (chính là trang xem kết quả chấm)
            const redirectUrl = postResp.url;
            if (!redirectUrl.includes("/submission/")) {
                const respText = await postResp.text();
                if (respText.includes("Vui lòng đăng nhập") || respText.includes("Đăng nhập")) {
                    throw new Error("Phiên đăng nhập LQDOJ đã hết hạn. Vui lòng đăng nhập lại tài khoản Giáo viên.");
                }
                throw new Error("Không thể chuyển hướng đến trang kết quả chấm bài. Có thể do nộp bài quá nhanh hoặc lỗi hệ thống LQDOJ.");
            }

            const subIdMatch = redirectUrl.match(/\/submission\/(\d+)/);
            const lqdojSubId = subIdMatch ? subIdMatch[1] : "Không rõ ID";

            console.log(`[LQDOJ Bridge] Nộp bài thành công! ID Bài nộp: ${lqdojSubId}`);
            updateStatus(submission_id, student_ip, "judging", `Đang chờ hệ thống LQDOJ chấm bài (ID: ${lqdojSubId})...`);

            // Bước 3: Polling trang submission để parse kết quả chấm
            pollResult(submission_id, student_ip, problem_id, problem_name, redirectUrl);

        } catch (error) {
            console.error("[LQDOJ Bridge] Lỗi nộp bài:", error);
            updateStatus(submission_id, student_ip, "error", `Lỗi: ${error.message}`);
        }
    });

    function updateStatus(submission_id, student_ip, status, message) {
        socket.emit("lqdoj_submit_status_update", {
            submission_id,
            student_ip,
            status,
            message
        });
    }

    async function pollResult(submission_id, student_ip, problem_id, problem_name, submissionUrl) {
        let attempts = 0;
        const maxAttempts = 60; // 90 giây
        const delay = 1500;

        const interval = setInterval(async () => {
            attempts++;
            if (attempts > maxAttempts) {
                clearInterval(interval);
                updateStatus(submission_id, student_ip, "error", "Hết thời gian chờ chấm bài (Timeout 90s).");
                return;
            }

            try {
                const resp = await fetch(submissionUrl);
                if (!resp.ok) throw new Error("Không thể lấy dữ liệu trang chấm bài.");

                const htmlText = await resp.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(htmlText, "text/html");

                // Tìm verdict tổng quát
                const statusElt = doc.querySelector(".submission-status, .verdict, #submission-verdict, .submission-verdict");
                let statusText = statusElt ? statusElt.textContent.trim() : "Đang chấm...";

                // Kiểm tra xem đã chấm xong chưa
                const isJudging = statusText.toLowerCase().includes("judging") || 
                                  statusText.toLowerCase().includes("queued") || 
                                  statusText.toLowerCase().includes("compiling") ||
                                  statusText.toLowerCase().includes("đang chấm") ||
                                  statusText.toLowerCase().includes("đang đợi") ||
                                  statusText === "Đang chấm..." ||
                                  doc.querySelector(".state-judging, .state-queued, .state-compiling") !== null;

                if (isJudging) {
                    updateStatus(submission_id, student_ip, "judging", `Hệ thống đang chấm bài... (${statusText})`);
                    return;
                }

                // Chấm xong! Dừng interval
                clearInterval(interval);

                // Scrape điểm
                const scoreElt = doc.querySelector(".submission-score, .score, #submission-score, .submission-score-total");
                let score = "0.0";
                if (scoreElt) {
                    score = scoreElt.textContent.trim().replace(/Score:\s*/i, "").replace(/Điểm:\s*/i, "");
                } else if (statusText) {
                    // Trích xuất điểm nếu có dạng 50/100
                    const match = statusText.match(/(\d+(\.\d+)?)\s*\/\s*(\d+)/);
                    if (match) {
                        score = match[0];
                    }
                }

                // Chuẩn hóa kết quả tổng quát
                let finalStatus = statusText;
                if (finalStatus.includes("Wrong Answer") || finalStatus.includes("Kết quả sai")) finalStatus = "Wrong Answer";
                else if (finalStatus.includes("Accepted") || finalStatus.includes("Khớp đáp án")) finalStatus = "Accepted";
                else if (finalStatus.includes("Time Limit") || finalStatus.includes("Quá thời gian")) finalStatus = "Time Limit Exceeded";
                else if (finalStatus.includes("Memory Limit") || finalStatus.includes("Quá bộ nhớ")) finalStatus = "Memory Limit Exceeded";
                else if (finalStatus.includes("Runtime Error") || finalStatus.includes("Lỗi thời gian chạy")) finalStatus = "Runtime Error";
                else if (finalStatus.includes("Compile Error") || finalStatus.includes("Lỗi biên dịch")) finalStatus = "Compile Error";

                // Scrape chi tiết các testcases từ table
                const testcases = [];
                const rows = doc.querySelectorAll("table tr");
                rows.forEach((row, idx) => {
                    const cells = Array.from(row.querySelectorAll("td"));
                    if (cells.length >= 4) {
                        const firstCellText = cells[0].textContent.trim();
                        // Nhận diện dòng chứa kết quả testcase (ví dụ "Test #1:", "Subtask ...")
                        if (firstCellText.toLowerCase().includes("test #") || firstCellText.toLowerCase().includes("testcase")) {
                            const name = firstCellText.replace(":", "").trim();
                            let tcStatus = cells[1].textContent.trim();
                            if (tcStatus.includes("AC") || tcStatus.includes("Accepted")) tcStatus = "Accepted";
                            else if (tcStatus.includes("WA") || tcStatus.includes("Wrong Answer")) tcStatus = "Wrong Answer";
                            else if (tcStatus.includes("TLE") || tcStatus.includes("Time Limit")) tcStatus = "Time Limit Exceeded";
                            else if (tcStatus.includes("MLE") || tcStatus.includes("Memory Limit")) tcStatus = "Memory Limit Exceeded";
                            else if (tcStatus.includes("RTE") || tcStatus.includes("Runtime Error")) tcStatus = "Runtime Error";

                            const tcScore = cells[2].textContent.trim();
                            const tcTime = cells[3].textContent.trim();
                            const tcMem = cells[4] ? cells[4].textContent.trim() : "---";

                            testcases.push({
                                id: name,
                                status: tcStatus,
                                score: tcScore,
                                time: tcTime,
                                memory: tcMem
                            });
                        }
                    }
                });

                // Gửi kết quả chấm chi tiết về cho server
                console.log(`[LQDOJ Bridge] Hoàn tất chấm! Điểm: ${score}, Kết quả: ${finalStatus}`);
                socket.emit("lqdoj_submit_result_sync", {
                    submission_id,
                    student_ip,
                    problem_id,
                    problem_name,
                    status: finalStatus,
                    score,
                    testcases
                });

            } catch (err) {
                console.error("[LQDOJ Bridge] Lỗi trong vòng lặp polling:", err);
            }
        }, delay);
    }
})();
