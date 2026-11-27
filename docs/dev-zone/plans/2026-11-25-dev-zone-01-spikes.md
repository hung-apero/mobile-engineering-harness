# Dev-zone 01: Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trả lời các điểm chưa chắc mà vòng bug dựa vào, bằng kết quả chạy thật.

**Architecture:** Không sinh code sản phẩm. Mỗi spike có lệnh, điều kiện đạt, và hướng thay thế khi trượt. Kết quả ghi vào `docs/superpowers/spikes/2026-11-25-results.md`; spike trượt thì sửa spec trước khi làm plan 03 (vòng bug). Plan 02 (nền) chỉ phụ thuộc S1.

**Tech Stack:** Claude Code CLI ≥ 2.1.332, mcp-atlassian 0.21.1 (`uvx`), `gh`, Python 3 hệ thống.

**Spec:** `docs/superpowers/specs/2026-11-25-dev-zone-design.md` (§2, §4, §7, §9)

## Global Constraints

- Không in token, email, mật khẩu ra log hay tài liệu. Dữ liệu spike để ở `~/.dev-zone/spikes/`, ngoài git.
- Ghi Jira chỉ trên **một ticket test người dùng nêu mã**. Không có mã thì dừng S2.
- Không push, không mở PR lên GitHub công ty ở S3. Không chạm checkout hay worktree đang mở của người dùng.
- Không bao giờ gọi `jira_delete_issue`.
- Không commit/push nếu người dùng chưa yêu cầu.

## Đã biết, không thử lại

| Điểm | Kết quả 2026-11-25 |
|---|---|
| `claude -p` chờ agent nền | Đạt, 75 giây. **Luồng `stream-json` có nhiều sự kiện `result`** (mỗi lần leader tỉnh một cái): kết thúc phải tính theo lúc tiến trình thoát |
| Hạn mức tuần | `rate_limit_event.rate_limit_info.unifiedWindows.seven_day.utilization` |
| `CLAUDE_CONFIG_DIR` mới | `loggedIn: false`, cần đăng nhập riêng |
| mcp-atlassian 0.21.1 | Có `READ_ONLY_MODE`, `ENABLED_TOOLS`; toolset `jira_attachments` có `download_attachments` (trả base64), `jira_transitions` có `transition_issue` |
| `pr-discord-notify.yml` của AAP864 | Chỉ báo khi PR không phải draft. **PR lane và PR đợt phải luôn là draft** để không làm ồn kênh |

---

### Task 1 (S1): Cấu hình Claude tách riêng

**Cần người dùng:** đăng nhập một lần.

- [ ] **Step 1:** `mkdir -p ~/.dev-zone/claude && chmod 700 ~/.dev-zone`
- [ ] **Step 2 (người dùng chạy trong terminal):** `CLAUDE_CONFIG_DIR=~/.dev-zone/claude claude auth login`
- [ ] **Step 3: Kiểm không nạp cấu hình cá nhân.** Chạy `CLAUDE_CONFIG_DIR=~/.dev-zone/claude claude -p --output-format stream-json --verbose --strict-mcp-config -- "Trả lời: OK" < /dev/null`, đọc sự kiện `system/init`.

  Đạt khi: `plugins`, `mcp_servers` rỗng; không có skill `jira-bug-analyzer`; hỏi tiếp "CLAUDE.md nào đang được nạp?" trả lời không có file trong `~/.claude/`.
- [ ] **Step 4: Đăng nhập còn sau khi phiên cá nhân đăng xuất/đổi?** Không thử đăng xuất. Chỉ kiểm `claude auth status` ở cấu hình mặc định vẫn `loggedIn: true` sau Step 2.

**Trượt thì:** dùng `--setting-sources project --strict-mcp-config` với cấu hình mặc định (đã chạy được ở lần thử 75 giây), ghi vào spec §2.

### Task 2 (S2): Đọc và ghi Jira thật

**Cần người dùng:** mã một ticket test, đang mở, có một file đính kèm.

- [ ] **Step 1: Cấu hình MCP riêng** `~/.dev-zone/spikes/jira-write.json` (mode 600): `uvx mcp-atlassian==0.21.1`, lấy `JIRA_URL`, `JIRA_PERSONAL_TOKEN` từ cấu hình `jira` hiện có, `ENABLED_TOOLS=jira_get_issue,jira_search,jira_get_transitions,jira_transition_issue,jira_add_comment,jira_update_issue,jira_download_attachments`.
- [ ] **Step 2: Chụp trạng thái ban đầu** của ticket: `status`, `labels`, `assignee`, số comment → `before.json`.
- [ ] **Step 3: Ghi từng thứ rồi đọc lại.** Comment `[Claude] dev-zone spike`; thêm nhãn `claude-fixing`; transition sang In Progress (id lấy từ `jira_get_transitions`); tải đính kèm về đĩa.

  Đạt khi đọc lại thấy: đúng comment; nhãn mới có **và nhãn cũ còn đủ** (`labels` là ghi đè hay thêm?); `status` = In Progress; **`assignee` không đổi**; file tải về có sha256 ổn định qua hai lần tải và mở được.
- [ ] **Step 4: Trả ticket về như cũ** theo `before.json`, đọc lại so khớp. Comment để lại, ghi rõ là thử.
- [ ] **Step 5: Kiểm đường chỉ đọc cho worker.** Cùng cấu hình với `READ_ONLY_MODE=true`: liệt kê tool, đạt khi không có tool ghi nào.

**Trượt thì:** comment/transition gọi thẳng REST v2 của Jira bằng cùng token trong service; ghi vào spec §7.

### Task 3 (S3): `bug-fix` mode batch chạy không người

**Cần người dùng:** mã một ticket AAP864 đã `confirmed` được với spec và sửa ở mức `unit` hoặc `preview` (không cần thiết bị).

- [ ] **Step 1: Bản clone cách ly.** `git clone --bare` AAP864 vào `~/.dev-zone/spikes/aap864.git`, clone làm việc từ đó vào `~/.dev-zone/spikes/aap864`; chỉ copy `local.properties`. Kiểm `git remote -v` chỉ trỏ bản bare cục bộ.
- [ ] **Step 2: Chạy leader.**

  `cd ~/.dev-zone/spikes/aap864 && BUG_FIX_STATE_DIR=~/.dev-zone/spikes/state LEARN_APP_BUILD_SLOTS=1 CLAUDE_CONFIG_DIR=~/.dev-zone/claude claude -p --output-format stream-json --verbose --strict-mcp-config --mcp-config ~/.dev-zone/spikes/jira-read.json --plugin-dir <harness> --disallowedTools "Bash(gh pr create:*)" "Bash(gh pr ready:*)" "Bash(gh pr merge:*)" …`

  Prompt: `/bug-fix-orchestrator <KEY> --repo . --spec <spec> --figma <figma> --yes` cộng brief: không hỏi; không ghi Jira; `--max-lanes 1`; giữ draft; tới bước mở PR thì ghi nội dung PR vào `B/pr-body.md` rồi coi lane là xong.

  Nếu `--plugin-dir` không nạp được harness: cài skill/agent bằng `scripts/activate-claude-agents.sh` vào `~/.dev-zone/claude`, ghi lại cách đã dùng.
- [ ] **Step 3: Đánh giá.** Đạt khi: tiến trình tự thoát mã 0; có commit trên nhánh lane ở bản bare; `bug-reviewer` có kết luận; không có lần ghi Jira nào; không treo chờ câu hỏi. Ghi: thời gian, số agent nền, RAM đỉnh, `seven_day.utilization` trước/sau, danh sách `permission_denials`.
- [ ] **Step 4: Tiếp tục sau khi bị giết.** Chạy lại với ticket khác, `kill` giữa lane, chạy `claude -p --resume <session-id> -- "resume <batch-id>"`.

  Đạt khi không làm lại phase đã xong và không tạo worktree/nhánh thứ hai cho cùng lane.
- [ ] **Step 5: Danh sách lệnh cho phép.** Từ `permission_denials` và transcript, viết `~/.dev-zone/spikes/allowed-tools.txt`; đây là đầu vào cho plan 03.

**Trượt thì:** leader chạy bằng `claude --bg`; vẫn trượt thì service tự điều phối lane và chỉ gọi `bug-fixer`, `bug-reviewer` (đổi spec §7).

### Task 4 (S4): Khoá thiết bị chung cả máy

- [ ] **Step 1:** Từ hai repo khác nhau, cùng `BUG_FIX_STATE_DIR`, gọi hàm `acquire` của `devices.py` trên serial giả `SPIKE-1`.

  Đạt khi lần thứ hai bị từ chối, và `devices.py list` ở cả hai repo thấy cùng holder; `release` xong thì lấy được.
- [ ] **Step 2:** Lặp 20 lần song song 8 tiến trình; đạt khi không lúc nào có hai holder.

### Task 5: Ghi kết quả

- [ ] **Step 1:** Viết `docs/superpowers/spikes/2026-11-25-results.md`: mỗi spike một bảng (đạt/trượt, số đo, bằng chứng), không chứa bí mật.
- [ ] **Step 2:** Sửa spec ở chỗ kết quả khác giả định; báo người dùng phần đổi.
