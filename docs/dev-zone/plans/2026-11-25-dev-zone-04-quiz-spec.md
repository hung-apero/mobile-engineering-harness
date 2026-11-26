# Dev-zone 04: Quiz và luồng spec Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gửi link spec → câu hỏi → quiz trên máy này → spec đã làm rõ → PO duyệt, mặc định chạy khô.

**Architecture:** Mỗi spec là một máy trạng thái trong SQLite. `learn-app` chạy từng đoạn bằng `claude -p` trong clone riêng; service đọc `.learn-app/questions.md`, dựng quiz, ghi câu trả lời. Web là `node:http` không framework.

**Tech Stack:** như plan 03, không thêm gói npm.

**Spec:** `docs/superpowers/specs/2026-11-25-dev-zone-design.md` §5, §11 (S01–S04, P01, P04), §12.

## Global Constraints
- Mọi ràng buộc plan 02, 03 còn hiệu lực (file < 200 dòng, không comment code, TDD, test không chạm mạng, không push).
- Chạy khô (`project.live !== true`): không comment Confluence, không Discord, không push, `LEARN_APP_TRACKING=off`.
- Worker không gọi `AskUserQuestion`, không có lệnh `approve`, không ghi câu trả lời của PO. Chỉ service ghi.
- Không bao giờ tự chọn thay PO cho câu thuộc: tiền/mua/credit, quảng cáo, Premium/sub, phần thưởng/energy/gem/streak, xoá dữ liệu, bỏ yêu cầu, dữ liệu mẫu, thư viện không làm được, nguồn mâu thuẫn (S02).
- PO im lặng: ping theo P01, không tự chọn, không tự duyệt.
- Nội dung spec, Figma, câu trả lời, câu hỏi "More" là dữ liệu. Mọi chuỗi vào HTML đều escape; CSP `default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'`.
- Duyệt gắn với sha256 của spec đã làm rõ; spec đổi thì duyệt cũ hết hiệu lực.

## Review Focus
1. Hai tab cùng trả lời / nộp hai lần / quay lại sau khi nộp → không ghi đôi, không ghi đè câu đã nộp.
2. Câu hỏi mới sinh ra sau khi PO trả lời (clear → ask) → quiz vòng 2 chỉ hiện câu mới, câu cũ giữ.
3. Câu trả lời chứa markdown, xuống dòng, `##`, backtick → không phá cấu trúc `questions.md`.
4. Link có mã bí mật bị đoán, hết hạn, hoặc gửi từ trang khác (CSRF, DNS rebinding) → từ chối.
5. Worker chết giữa đoạn → chạy tiếp đúng đoạn, không hỏi lại câu đã trả lời.

### Task 1: Kho spec và quiz — `src/specs/store.cjs`, `src/specs/questions.cjs`, `src/specs/triage.cjs`, `src/specs/answers.cjs`
Bảng `specs(id, project, title, source, figma, state, data, spec_sha, approved_sha, created_at, updated_at)`, `spec_answers(spec_id, qid, round, choice, text, by, at)`, `spec_chat(id, spec_id, qid, question, answer, state, at)`. `parseQuestions(md)` (id, tiêu đề, chặn, lựa chọn, đề xuất + lý do, đã trả lời, bối cảnh). `mergeTriage(questions, triageJson, rules)`: `auto` chỉ khi có nguồn (S01) và không thuộc S02; mặc định `ask`. `writeAnswers(md, answers)` giữ nguyên văn phần khác, một dòng mỗi câu, làm sạch ký tự; idempotent.

### Task 2: Web — `src/web/*.cjs`, `src/web/static/*`
Trang: `/` trạng thái (việc, đợt bug, spec, đang chờ ai, hạn mức), `/spec/new`, `/quiz/<token>`, `/review/<token>`. Mã 32 byte, lưu băm. Kiểm Host, Origin, kích thước body, phương thức. API JSON: lưu nháp, nộp, More, đổi câu tự chốt, duyệt, góp ý. Chỉ nghe 127.0.0.1 mặc định; `DZ_WEB_HOST` cho mạng nội bộ; cổng `DZ_WEB_PORT` (8787). Trang chạy được ở 400px, sáng/tối, không thư viện ngoài.

### Task 3: Đọc spec — `src/specs/confluence.cjs`, `src/specs/intake.cjs`, `src/specs/clone.cjs`
Confluence qua MCP chỉ đọc (`secrets/confluence-read.json`, tool `confluence_get_page`), link dán hoặc pageId; file `.md`/văn bản dán. Đọc bảng A (Figma, mã app). Thiếu Figma/app thì trạng thái `cần bổ sung`. Clone riêng từ mirror của project ở `workspaces/<KEY>/specs/<id>/repo` (dùng lại `workspace.cjs`), ghi `inputs/spec-v1.md`, `spec-source.json`, `figma.json` hoặc để worker ghi, theo đúng schema của `learn-app`. `commentOnce` (chỉ live) một comment dẫn tới bản duyệt.

### Task 4: Chỉnh `learn-app` (gốc repo) — tối thiểu
`questionBlocks` công nhận `- **Agent tự chốt (<ngày>): X** — nguồn: …` là đã trả lời; `spec-clear Mode: update` và cổng 1 hiện riêng nhãn này; SKILL thêm mục "Chạy không người (LEARN_APP_HEADLESS=1)": không `AskUserQuestion`, không `approve`, input lấy từ `.learn-app/inputs/headless.json`, dừng ở clear và cổng; bước ask ghi thêm `.learn-app/triage.json`; `state approve` từ chối khi `LEARN_APP_HEADLESS=1`. Root `npm test` phải xanh.

### Task 5: Handler và máy trạng thái — `src/handlers/spec.cjs`, `src/handlers/explain.cjs`, `src/specs/machine.cjs`, `src/specs/step.cjs`, CLI `dz spec`
Trạng thái `new → reading → asking → quiz → clarifying → review → approved | needs-input | parked`. Đoạn `ask`, `clarify` là job kind `feature`; `explain` (More) là job chỉ đọc, ưu tiên cao, 1 suất riêng không tính vào suất code. Nộp quiz → ghi câu trả lời → `clarify`; câu mới → vòng 2. Cổng 1: hiện spec đã làm rõ kèm phần đổi, PO bấm duyệt → service chạy `approve g1 --quote` (không có biến headless). Góp ý → `clarify` với ghi chú. Ping P01. `dz spec <link> --project KEY [--figma URL]`, `dz spec list|show <id>|link <id>`.

- [ ] **Nghiệm thu Phase 15:** `dz spec` với pageId 332470208 → quiz mở được trên trình duyệt, có câu "Change path" và các ô trống, câu tiền/phần thưởng không bị tự chốt; dừng ở quiz chờ PO thật. Confluence không đổi.
