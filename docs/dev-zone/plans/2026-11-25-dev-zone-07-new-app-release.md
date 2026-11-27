# Dev-zone 07: App mới, E2E và release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nhận app mới từ một danh sách dev cung cấp; E2E thành điều kiện release số 6; báo "release được".

**Architecture:** App mới là một spec có `case: new`; service kiểm từng mục rồi tự tạo `projects/<KEY>.yaml`. E2E chạy `android-test-harness` bằng worker, kết quả gắn với sha của tree.

**Tech Stack:** như trước.

**Spec:** `docs/superpowers/specs/2026-11-25-dev-zone-design.md` §5 (App mới), §6 (E2E), §7 (release), §11 (S06, R01–R05), §12.

## Global Constraints
- Mọi ràng buộc plan 02–06. Không upload store. Bí mật đặt vào file theo đường dẫn service nêu, không qua chat/Discord/DB.
- Không tự tạo repo, Firebase, Jira project. Chỉ kiểm thứ dev đưa.
- E2E gắn với sha tree của bản build sẽ phát hành; tree khác thì hết hiệu lực.

## Review Focus
1. Danh sách thiếu một mục → nêu đúng mục, không tạo project dở.
2. `google-services.json` sai package → từ chối.
3. E2E đạt trên commit cũ → điều kiện 6 = chưa có.
4. Bug Highest mới sau khi báo release được → thu hồi (R02).
5. PO hoãn Medium/Low → điều kiện 4 đạt, ghi lại ai hoãn.

### Task 1: App mới — `src/newapp/*.cjs`: danh sách, kiểm từng mục, trang `/app/new`, tạo project
### Task 2: E2E — `src/handlers/e2e.cjs`, `src/e2e/*.cjs`, sửa `bugs/release.cjs` (điều kiện 6), S06
### Task 3: Release — hoãn Medium/Low qua quiz (R03), R04, R05 (`dz release done|cancel`), trang trạng thái release, F07/F08 còn thiếu, link Firebase trong comment Jira

- [ ] **Nghiệm thu:** danh sách giả lập tạo project khô; điều kiện 1–6 trên dữ liệu giả lập; AAP864 1.9.1 đọc thật cho ra bảng điều kiện.
