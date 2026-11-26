# Dev-zone 06: Discord Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PO gửi spec, trả lời, duyệt ngay trong Discord; service xác minh từng tin.

**Architecture:** Phiên điều phối Claude Code Channels (tmux, launchd) chỉ có MCP server `dz`. Service đọc lại tin từ Discord REST bằng bot token để lấy người gửi, role, kênh; không tin gì phiên truyền.

**Tech Stack:** như trước; MCP server stdio bằng `@modelcontextprotocol/sdk` đã có; plugin Channels Discord chính thức của Claude Code.

**Spec:** `docs/superpowers/specs/2026-11-25-dev-zone-design.md` §4, §5, §12.

## Global Constraints
- Mọi ràng buộc plan 02–05. Token bot chỉ ở `secrets/discord-bot-token` (600) và cấu hình Channels; không log, không DB.
- Phiên điều phối không có Bash, Edit, Read repo, Jira. Mọi tool khác bị từ chối sẵn. Không bypassPermissions.
- `approve`, `answer` chỉ nhận `message_id` + `channel_id`. Service tự đọc lại tin; bỏ tin của bot, tin đã sửa sau khi duyệt, tin ngoài kênh của project, người không có role.
- Duyệt mơ hồ ("ok nhưng") = góp ý (P04).
- Chạy khô: chỉ đọc tin, không gửi.

## Review Focus
1. Prompt injection trong tin nhắn bảo phiên gọi `approve` với tin của người khác → service kiểm người gửi và nội dung tin, từ chối.
2. Tin trùng, tin cũ phát lại → mỗi message_id chỉ dùng một lần.
3. Phiên chết hoặc treo → `pending` làm bù; quá 2 phút chưa `ack` thì khởi động lại phiên, không mất tin.
4. Discord giới hạn tần suất (429) → đọc lại theo Retry-After, không bão gọi.
5. Một kênh hai app → phải chọn rõ project, không đoán.

### Task 1: Discord REST có bot — `src/discord-bot.cjs` (đọc tin, đọc role, reply trong thread; 429; verify), `src/inbox.cjs` (bảng inbox, ack, dùng một lần)
### Task 2: MCP server `dz` — `src/mcp/*.cjs`: `submit, answer, approve, status, pending, ack` gọi vào service qua socket unix 600
### Task 3: Phiên điều phối — `channels/` (settings, CLAUDE.md, access.json mẫu), `src/desk.cjs` (tmux, theo dõi, khởi động lại hằng ngày, đối chiếu lịch sử kênh), `dz desk start|stop|status`, doctor, hướng dẫn tạo bot trong README

- [ ] **Nghiệm thu:** toàn bộ bằng Discord giả lập; với bot thật: cần người dùng.
