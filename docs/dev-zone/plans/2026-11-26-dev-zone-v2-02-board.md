# Dev-zone v2 02: Board quan sát Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Một link chỉ xem, mở được trong mạng LAN, cho team thấy theo từng project: spec đang ở bước nào và chờ ai, tiến độ code,
bug theo trạng thái Jira thật của bản đang theo dõi, đợt bug, hoạt động 7 ngày, hạn mức. Trang không có thao tác.

**Architecture:** Bước nền `board-sync` trong tick đọc Jira (chỉ đọc) 15 phút một lần cho mỗi bản đang theo dõi, ghi bảng
`board_bugs`. Trang `/board/<token>` render phía server từ DB (và `progress.json` của bản clone spec), tự tải lại 60 giây, không
JS, không API. Token viewer riêng (băm trong bảng `viewer_tokens`, phạm vi project, hạn 90 ngày, thu hồi được) do
`dz web viewer` cấp.

**Tech Stack:** Node ≥ 21 (`node:test`, `node:sqlite`), Jira MCP adapter có sẵn (`bugs/jira.cjs`, `jira_search`).

**Spec:** `docs/dev-zone/specs/2026-11-26-harness-engine-design.md` §7. Brainstorm 2026-11-26 chốt thêm **[C]**:
- Người xem: team cùng mạng LAN (`DZ_WEB_HOST=0.0.0.0` như quiz/review), không tunnel.
- Link: token riêng, hạn 90 ngày (đổi bằng `--days`), thu hồi được; chỉ mở đúng trang board.
- Bug: phạm vi giống bug loop nhưng mọi trạng thái — `issuetype = Bug AND (fixVersion in (<tên Jira của bản>) OR (fixVersion is
  EMPTY AND created >= baseline))`, cho mỗi bản `open` đang bật theo dõi (`versions.polling = 1`).
- Trang: server render + `<meta http-equiv="refresh" content="60">`; không JS, không route API mới.
- Ngoài phạm vi: biểu đồ, lọc/tìm, xuất file, phân quyền theo người, truy cập ngoài mạng.

## Global Constraints

- Như plan 01: file mới trong `service/` < 200 dòng, không comment trong code, TDD, test không chạm mạng, không adb thật.
- Test service chỉ chạy bằng `cd service && env -u DZ_HOME -u DZ_CLAUDE_CONFIG npm test`. Một file:
  `cd service && env -u DZ_HOME -u DZ_CLAUDE_CONFIG node --disable-warning=ExperimentalWarning --require ./tests/helpers/no-discord.cjs --test tests/<file>`.
- Commit conventional, tiếng Anh, không nhắc AI; chỉ commit local. Không đụng `~/.dev-zone`, `~/.dev-zone-v2`. Tối đa 2 subagent.
- Board chỉ đọc: không ghi Jira, không ghi DB ngoài `board_bugs`, `viewer_tokens`, kv `board-sync:*`; trang không có form, nút
  hay route POST.
- Dữ liệu trên trang qua `html.cjs` (escape); không hiện secret, đường dẫn tuyệt đối, nội dung spec hay log.

## Review Focus

1. Token viewer không mở được trang operator, quiz, review hay bất kỳ API nào; token hết hạn / đã thu hồi → 404 như token sai,
   có giới hạn dò (`token-guard`) (Task 2, 3).
2. Token có phạm vi KEY chỉ thấy đúng project đó, kể cả waits, đợt bug, hoạt động (Task 3).
3. Jira lỗi hay thiếu `secrets/jira-mcp.json`: tick không vỡ, bug loop không bị ảnh hưởng, board hiện "chưa đồng bộ được" + giờ
   lần cuối thành công (Task 1).
4. `board-sync` không gọi tool ghi nào của Jira và chạy được khi `live: false` (Task 1).

---

### Task 1: Đồng bộ bug Jira chỉ đọc

**Files:**
- Create: `service/src/board/sync.cjs`, `service/src/board/store.cjs`, `service/tests/board-sync.test.cjs`
- Modify: `service/src/migrations-features.cjs` (bảng `board_bugs`, `viewer_tokens`), `service/src/tick.cjs` (gọi `boardStep`),
  `service/src/bugs/polling.cjs` (tách phần dựng điều kiện phạm vi để dùng chung, không đổi JQL của bug loop)

**Interfaces:**
- Bảng `board_bugs (project, version, key, summary, status, priority, assignee, updated_at, synced_at, PRIMARY KEY (project, key))`.
- `polling.scopeJql(project, version, { baselineAt, fixVersions }): string` — phần `(... OR ...)` dùng chung với `jql()`; `jql()` của
  bug loop cho ra đúng chuỗi như trước (test hiện có giữ xanh).
- `boardJql(project, version, opts)` = `project = KEY AND issuetype = Bug AND <scope> ORDER BY priority DESC, updated DESC`.
- `boardStep(ctx, config, now)`: với mỗi project schedulable, mỗi bản `open` + `polling = 1`, nếu `kv board-sync:<KEY>:<bản>.at`
  cũ hơn 15 phút: lấy `jira = await ctx.bugs.jira(project)`, tên fixVersion bằng `fixVersionNames` (như `bugs/step.cjs`),
  `jira.search(jql, { limit: 200 })`, thay toàn bộ dòng của bản đó trong một transaction, ghi kv `{ at, ok: true, count, capped }`.
  Lỗi → kv `{ at, ok: false, error: firstLine, lastOkAt }`, không ném ra ngoài. Không chồng lượt (`ctx.boardStepPending` như
  `specStep`).
- `store.bugsOf(db, project) → [{ version, key, summary, status, priority, assignee, updatedAt }]`, `store.syncOf(db, project, version)`.

- [x] **Step 1: Test hỏng trước** (Jira giả qua `ctx.bugs.jira`):
  - `sync stores every bug of a tracked version with its real Jira status`
  - `sync replaces the rows of a version and drops bugs that left the scope`
  - `sync runs at most every 15 minutes per version and only for open tracked versions`
  - `a Jira error keeps the old rows, records the error and the last good time, and the tick goes on`
  - `sync only calls jira_search and works when the project is not live`
  - `the bug loop jql is unchanged` (so chuỗi `jql()` với bản chụp trước khi tách)
- [x] **Step 2:** Chạy, Expected: FAIL. **Step 3:** Viết. **Step 4:** Chạy toàn bộ, Expected: PASS.
- [x] **Step 5: Commit** `feat(service): read-only Jira bug sync for the board`

### Task 2: Token viewer và `dz web viewer`

**Files:**
- Create: `service/src/board/tokens.cjs`, `service/tests/board-tokens.test.cjs`
- Modify: `service/src/spec-commands.cjs` (`web` nhận `viewer`), `service/bin/dz.cjs` (USAGE + ARGUMENT), `service/src/web/links.cjs` (`boardUrl`)

**Interfaces:**
- Bảng `viewer_tokens (id INTEGER PRIMARY KEY, hash TEXT UNIQUE, keys TEXT NOT NULL DEFAULT '[]', expires_at, created_at, revoked_at)`.
- `issueViewer(db, { keys, days = 90 }, now) → { id, token }` (32 byte ngẫu nhiên base64url, lưu sha256); `resolveViewer(db, token, now)
  → { id, keys } | null` (sai, hết hạn, đã thu hồi → `null`); `listViewers(db, now)`; `revokeViewer(db, id, now)`.
- `dz web viewer [KEY…] [--days N]` (KEY phải là project đã khai; N 1–365) → in link `${webBase}/board/<token>`;
  `dz web viewer --list` → `#id  KEY…|mọi project  hết hạn YYYY-MM-DD  [đã thu hồi]`; `dz web viewer --revoke <id>`.
  `dz web` (không tham số) giữ nguyên link operator.

- [x] **Step 1: Test hỏng trước:** `viewer token is random, stored hashed and resolves to its keys`,
  `an expired or revoked token resolves to nothing`, `dz web viewer prints a board link and rejects unknown keys and bad days`,
  `dz web viewer --list and --revoke`, `dz web without arguments still prints the operator link`.
- [x] **Step 2:** Chạy, Expected: FAIL. **Step 3:** Viết. **Step 4:** Chạy toàn bộ, Expected: PASS.
- [x] **Step 5: Commit** `feat(service): revocable read-only viewer links`

### Task 3: Trang `/board/<token>`

**Files:**
- Create: `service/src/board/model.cjs` (gom dữ liệu), `service/src/web/page-board.cjs` (HTML), `service/tests/board-page.test.cjs`
- Modify: `service/src/web/routes.cjs` (route `board`, auth `viewer`, chỉ GET/HEAD), `service/src/web/server.cjs` (resolve `viewer` qua
  `token-guard` + `resolveViewer`), `service/src/web/static/*.css` (khối board, nếu cần)

**Interfaces:**
- `boardModel(ctx, { keys }, now) → { quota, slots, projects: [{ key, specs, bugs, batches, activity, sync }] }`:
  - `specs`: spec chưa `done`/`cancelled` + spec xong trong 7 ngày: `{ id, title, state, label, waitingFor: 'PO'|'dev'|'QA'|null,
    progress: { done, total } | null }` — `label` dùng chung bảng nhãn với `page-home` (tách ra `web/spec-labels.cjs`), `waitingFor` từ
    wait đang mở của spec, `progress` từ `.harness-run/progress.json` (`build-result.progressOf`) khi spec ở bước build trở đi.
  - `bugs`: theo bản → nhóm theo `status` Jira, trong nhóm sắp `priority` rồi `updatedAt`; mỗi bug có `loop: true` khi khớp `tickets`
    của bug loop.
  - `batches`: đợt `open`/`running` (`{ id, version, state, phase, keys }`).
  - `activity`: 7 ngày theo giờ Việt Nam — spec duyệt (`decisions` `spec-approved`), code xong (`spec-coded`), bản cài gửi PO
    (`spec-trial-sent`), bug loop xong (`tickets.state = 'done'` theo `updated_at`), đợt gộp xong (`batches.state = 'done'` theo
    `updated_at`).
  - `sync`: dòng "đồng bộ Jira lúc HH:mm" hoặc "chưa đồng bộ được: <lỗi>, lần cuối HH:mm".
  - `quota`, `slots`: như `overview` (`quotaLine`, số suất đang chạy / sức chứa).
- Route `view('board', 'viewer', /^\/board\/([\w-]{1,200})$/, …)`; token sai/hết hạn/thu hồi → 404; viewer không có cookie
  operator, không qua `checkOrigin` vì chỉ GET.
- HTML: `<meta http-equiv="refresh" content="60">`, không `<form>`, không `<button>`, không `<script>`; mỗi project một khối;
  link quiz/review **không** hiện (chỉ chữ "chờ PO duyệt").

- [x] **Step 1: Test hỏng trước:**
  - `the board shows each spec step and who it waits for`
  - `a building spec shows done over total plans from progress.json`
  - `bugs are grouped by Jira status, sorted by priority, and loop bugs are marked`
  - `a key-scoped token sees only its projects, including waits, batches and activity`
  - `activity counts the last 7 days by Vietnam day`
  - `the page refreshes every 60 seconds and has no form, button, script or quiz link`
  - `a sync error shows on the board with the last good time`
  - `a viewer token cannot open home, quiz, review or any api route, and a bad token is 404 and rate limited`
- [x] **Step 2:** Chạy, Expected: FAIL. **Step 3:** Viết. **Step 4:** Chạy toàn bộ, Expected: PASS.
- [x] **Step 5: Commit** `feat(service): read-only project board page`

### Task 4: Vận hành

**Files:**
- Modify: `service/README.md` (mục "Board": lệnh, LAN, hạn token, nguồn dữ liệu, độ trễ ≤ 15 phút), `service/src/doctor.cjs`
  (dòng `board`: có `secrets/jira-mcp.json`, lần đồng bộ cuối của từng bản đang theo dõi, số viewer còn hạn),
  `docs/dev-zone/specs/2026-11-26-harness-engine-design.md` §7 (ghi các điểm **[C]** ở đầu plan này)
- Test: `service/tests/doctor.test.cjs`

- [x] **Step 1: Test hỏng trước:** `doctor reports the board sync of tracked versions and live viewer links`.
- [x] **Step 2:** Chạy, Expected: FAIL. **Step 3:** Viết. **Step 4:** Chạy toàn bộ, Expected: PASS.
- [x] **Step 5: Commit** `docs(service): board operation and doctor check`

## Rủi ro

- Bind `0.0.0.0` mở mọi trang cho máy trong LAN; quiz, review, operator vẫn cần token như hiện nay — không thêm rủi ro mới, nhưng
  link board lộ ra là lộ tên spec/bug tới khi thu hồi hoặc hết hạn.
- Jira > 200 bug một bản: chỉ lưu 200 bug ưu tiên cao nhất, trang ghi "còn nữa" (`capped`).
- Tên fixVersion trên Jira khác tên bản của dev-zone: dùng `fixVersionNames` như bug loop; sai ánh xạ thì board thiếu bug giống bug loop.
- Thêm một nguồn gọi Jira mỗi 15 phút mỗi bản; dùng chung adapter MCP với bug loop (không mở thêm tiến trình).
