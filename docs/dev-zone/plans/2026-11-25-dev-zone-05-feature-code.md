# Dev-zone 05: Code tính năng → bản cài Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec đã duyệt → plan → code → chạy thử → so UI → cổng → PR nháp + bản cài → PO duyệt → gộp vào nhánh version. Mặc định chạy khô.

**Architecture:** Nối tiếp máy trạng thái spec của plan 04, dùng lại merge/gate/build/publish của plan 03. Đoạn `build` và `ship` của `learn-app` chạy bằng `claude -p`.

**Tech Stack:** như plan 03, 04.

**Spec:** `docs/superpowers/specs/2026-11-25-dev-zone-design.md` §5.8, §6, §8, §11 (S03–S05, F, Q), §12.

## Global Constraints
- Mọi ràng buộc plan 02–04. Chạy khô: không push, PR, Firebase, Discord, tracking.
- Code bắt đầu chỉ khi: spec duyệt đúng sha; điều kiện trước (`prerequisites` của spec: PR đã merge, nhánh SDK đã vào, đĩa trống ≥ 40 GB khi >1 plan song song) đều đạt. Thiếu thì trạng thái `waiting-prereq`, ping dev, tự kiểm lại mỗi 15 phút.
- Tối đa 3 agent code cả máy, chừa 1 suất bug; worker `learn-app` nhận `LEARN_APP_PARALLEL` = suất được cấp.
- Câu phát sinh khi code (S03) vào quiz vòng mới, trạng thái `tạm chọn`; PO phải xác nhận hết trước khi PR sẵn sàng.
- Thiết bị: khoá chung `devices.py` qua `BUG_FIX_STATE_DIR`; không dùng thiết bị trong `excludedDevices`.

## Review Focus
1. Spec đổi giữa lúc code (S04) → phần bị ảnh hưởng duyệt lại, phần khác chạy tiếp.
2. Bug và tính năng cùng gộp một nhánh version → chung khoá landing, không đè nhau.
3. PO duyệt bản cài của commit cũ → không tính cho commit mới.
4. Worker chết trong worktree con của `learn-app` → chạy tiếp đúng plan, không tạo worktree thứ hai.
5. Không có thiết bị → không chạy thử thì không gửi bản cài, gác và ping (S05/F05).

### Task 1: Điều kiện trước và đoạn build — `src/specs/prereq.cjs`, `src/specs/phase-build.cjs`, sửa `src/handlers/spec.cjs`, `src/specs/machine.cjs`
### Task 2: Câu tạm chọn — `src/specs/provisional.cjs` (đọc `auto-decisions.md`, `decisions` trong state của learn-app → câu quiz; đổi → `decide` + `back --to coding` do service chạy)
### Task 3: Thiết bị và chạy thử, so UI — `src/devices.cjs` (khoá, chọn máy), đoạn smoke của learn-app, bước so UI bằng `ui-diff` của harness ≤ 3 vòng, `src/handlers/uidiff.cjs`
### Task 4: Giao hàng — `src/specs/phase-ship.cjs`: review riêng, checkDiff, gộp (landing chung), gate, build, PR nháp, bản cài, trang review bản cài (PO duyệt đúng commit), rồi gộp vào nhánh version. Sửa `handoff-commands.cjs` ở gốc: chế độ headless chỉ chuẩn bị nhánh và nội dung PR, không push, không mở PR.

- [ ] **Nghiệm thu:** spec tổng hợp nhỏ trên repo mẫu cục bộ chạy trọn bằng worker giả lập (fake claude) tới `would: PR`; Phase 15 dừng ở `waiting-prereq` nêu đúng PR #272 và nhánh SDK.
