# Board: chi tiết spec, log trực tiếp, điều khiển job — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Board cho PO và dev biết spec đang ở đâu, chờ ai, còn vấn đề gì, UI lệch màn nào, tốn bao nhiêu; xem log worker trực
tiếp; operator dừng / tạm dừng / chạy lại job ngay trên board.

**Architecture:** Service `~/Desktop/src/dev-zone/service`. Một model chỉ đọc (`board/spec-detail.cjs`) gom DB (`specs`,
`decisions`, `waits`, `jobs`) và `.harness-run/{progress,result}.json`; card và trang chi tiết dùng chung. Log đọc từ
`$DZ_HOME/logs/<job>.jsonl` theo offset, trình duyệt hỏi lại mỗi 2 giây qua `static/job-log.js`. Nút job là API operator
(cookie `dz_operator`) gọi `jobs`/`stopJob` sẵn có. Worker ghi `result.json.issues[]` theo hợp đồng mới, `headless_check.py` bắt.

**Tech Stack:** Node ≥ 21 (`node:test`, `node:sqlite`); Python 3 stdlib `unittest`; JS tĩnh không thư viện (CSP `script-src 'self'`).

**Spec:** `docs/dev-zone/specs/2026-11-27-board-spec-detail-design.md` + phần bổ sung trong plan này (log trực tiếp, nút job —
người dùng chốt 2026-11-27: "Xem trực tiếp + nút thao tác", "start / stop / pause job", cùng plan, phase sau).

## Global Constraints

- File mới trong `service/` < 200 dòng; không comment trong code; TDD (test đỏ trước); test không chạm mạng, không adb thật.
- Test service: `cd service && env -u DZ_HOME -u DZ_CLAUDE_CONFIG npm test`. Một file:
  `cd service && env -u DZ_HOME -u DZ_CLAUDE_CONFIG node --disable-warning=ExperimentalWarning --require ./tests/helpers/no-discord.cjs --test tests/<file>`.
- Test harness: `cd skills/feature/scripts && python3 -m unittest -v`.
- Commit conventional tiếng Anh, không nhắc AI, chỉ local; không push, PR, `live: true`, launchctl.
- Không đụng `~/.dev-zone` (v1). Chữ hiển thị qua `redact` + `esc`; không lộ token, secret, đường dẫn tuyệt đối của máy ngoài
  phần Kỹ thuật (đường dẫn rút gọn tương đối repo).
- Chữ trên trang: tiếng Việt PO đọc được; phần kỹ thuật trong `<details>`.
- Board viewer (token `/board/<token>`) chỉ xem. Mọi thao tác ghi cần cookie operator, POST, qua guard sẵn có (host check,
  same-origin); viewer không có cookie không thấy nút và API trả 403.

## Review Focus

1. Viewer token của project A mở `/board/<token>/B/spec/<id>` hoặc spec/job của project khác → 404, không lộ dữ liệu (Task 4, 5).
2. Log job chứa secret / token / env (ví dụ lệnh `cat secrets/...`, header Authorization) → dòng hiển thị đã `redact`; offset sai
   hoặc file bị cắt ngắn không làm hỏng trang (Task 5).
3. Bấm Pause/Stop khi job đã xong hoặc đang `starting`, bấm hai lần liên tiếp, hai tab cùng bấm → trả lỗi rõ, không đổi job đã
   xong, không chạy 2 worker cùng spec (Task 6).
4. Spec cũ không có `result.json`, `progress.json`, `issues[]`, hoặc file JSON hỏng → trang vẫn hiện, phần đó ghi "chưa có" /
   "không đọc được" (Task 2, 4).
5. Mã quyết định lạ hoặc vòng UI > 4 → không vỡ bảng; hiện mã gốc, chỉ 4 vòng gần nhất (Task 2).

---

### Task 1: Hợp đồng `issues[]` trong `result.json`

**Files:**
- Modify: `skills/feature/references/headless.md` (bảng file, dòng `result.json`)
- Modify: `skills/feature/scripts/headless_check.py` (`result_problems`)
- Test: `skills/feature/scripts/test_headless_check.py`

**Interfaces:** Produces `result.json.issues: [{ title: str, status: "fixed"|"open", blocksMerge: bool, owner: "po"|"dev"|"sdk", detail: str }]`.

- [ ] **Step 1: Test đỏ** — `test_build_issues_required_with_findings`: result có `review.findings` không rỗng mà thiếu `issues`
  → problem chứa `issues`; `test_build_issue_fields_checked`: một issue thiếu `title`, `status: "done"`, `owner: "qa"`,
  `blocksMerge: "yes"` → mỗi lỗi một problem nêu đúng trường; issue hợp lệ + findings → `[]`; result không findings, không issues → `[]`.
- [ ] **Step 2:** `python3 -m unittest -v` → FAIL đúng 2 test mới.
- [ ] **Step 3:** `issue_problems(data)` trong `headless_check.py`, gọi từ `result_problems`. `headless.md`: thêm `issues[]`
  vào dòng `result.json`: "mỗi vấn đề review/ghi chú còn lại một mục; `title` tiếng Việt có dấu, PO đọc được, không mã code;
  `detail` kỹ thuật; `blocksMerge` true khi chưa được merge".
- [ ] **Step 4:** `python3 -m unittest -v` → OK.
- [ ] **Step 5:** `git commit -m "feat(feature): structured issues in headless result.json"`

### Task 2: Model chi tiết spec

**Files:**
- Create: `service/src/board/spec-detail.cjs`, `service/src/board/spec-steps.cjs` (map mã quyết định → bước), `service/src/board/spec-ui-rounds.cjs`
- Test: `service/tests/board-spec-detail.test.cjs`

**Interfaces:**
- Consumes: `store.getSpec`, `jobs.listJobs`, bảng `decisions` (`action`, `evidence` JSON có `specId`, `at`), `waits` qua kv `spec-wait:<id>`, `progressOf(repo)` (`specs/build-result.cjs`), `productsOf` (giữ).
- Produces: `specDetail(ctx, key, id, now) → null | { id, title, state, label, waiting: {role, subject, openedAt, pings, link?}|null, running: {jobId, kind, startedAt, costUsd?}|null, steps: [{ name, status: 'done'|'current'|'todo', at?, note? }], issues: { source: 'issues'|'findings'|'none', blocking:[], open:[], fixed:[], raw:[] }, provisional: [{ id, label, text }], ui: { rounds:[n], screens:[{ name, scores:[n|null], last: str }] }, plans: [{ id, title, status }], jobs: [{ id, kind, state, startedAt, finishedAt, costUsd, turns }], totalUsd, version, install, branch, commit, products }`; `specSummary(detail) → { stepLine, nowLine, issueLine }` cho card.

- [ ] **Step 1: Test đỏ** (fixture DB + repo tạm, theo kiểu `tests/specs-flow-fixtures.cjs`):
  - `steps follow the spec state and decision times`: spec `uidiff` có `spec-approved`, `spec-coded`, `spec-smoke-passed`,
    3 `spec-ui-round` → Đọc..Chạy thử `done`, "So giao diện" `current` với `note: '3 vòng'`, "Kiểm code".."Gộp" `todo`.
  - `waiting and running come from waits and jobs`: wait PO mở + job `running` kind `uidiff` → `waiting.role === 'PO'`, `running.kind === 'uidiff'`.
  - `issues prefer structured result.json issues`: `issues[]` 1 open blocksMerge + 1 fixed → `blocking.length 1`, `fixed.length 1`, `source 'issues'`; chỉ có `review.findings` → `source 'findings'`, `raw` = message; không file → `source 'none'`.
  - `provisional lists PO-skipped questions with their proposal`: câu không chặn đã hỏi, chưa trả lời → `{ id: 'Q14', label: 'A' }`.
  - `ui table keeps the last 4 rounds per screen`: 5 `spec-ui-round` với `left: ['p15-b0:35', ...]` → `rounds [2,3,4,5]`, màn không có vòng đó → `null`.
  - `jobs sum their cost`: 2 job xong `result.costUsd` 1.5 + 2 → `totalUsd 3.5`.
  - `bad json files do not throw`: `progress.json` = `"{"` → `plans: []`.
  - `another project's spec is null`.
- [ ] **Step 2:** chạy file test → FAIL (module chưa có).
- [ ] **Step 3:** cài 3 module. `spec-steps.cjs`: thứ tự bước `Đọc, Hỏi, PO trả lời, Làm rõ, Duyệt, Code, Chạy thử, So giao diện,
  Kiểm code, Bản cài, PO thử, Gộp`; bước hiện tại theo `spec.state` (bảng state → bước), giờ `at` = quyết định cuối của bước
  đó; mã lạ bỏ qua khi map, không throw. `spec-ui-rounds.cjs`: tách `left` dạng `<màn>:<điểm>`, nhận xét từ `data.build.notes.ui`.
  Đọc JSON qua try/catch trả mặc định.
- [ ] **Step 4:** test file → PASS; `npm test` → xanh.
- [ ] **Step 5:** `git commit -m "feat(board): spec detail model"`

### Task 3: Card gọn trên board

**Files:**
- Modify: `service/src/board/model.cjs` (`specsOf` thêm `summary`), `service/src/web/page-board.cjs` (`specRow`, `projectRow`)
- Test: `service/tests/board-page.test.cjs` (hoặc file test board hiện có — dùng file sẵn nếu có)

- [ ] **Step 1: Test đỏ** — `spec card shows steps, now line, issues and a detail link`: HTML có `✓Code`, `●So giao diện`,
  `Đang chờ PO` hoặc `Đang chạy`, `chặn merge`, `href="/board/<token>/AAP864/spec/3"`; không còn dòng `tài liệu tham chiếu` trên card.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** `specsOf` gọi `specDetail` + `specSummary`; `specRow` dùng 3 dòng summary + link "Chi tiết →".
- [ ] **Step 4:** PASS; `npm test` xanh.
- [ ] **Step 5:** `git commit -m "feat(board): compact spec card with progress and link"`

### Task 4: Trang chi tiết spec

**Files:**
- Create: `service/src/web/page-spec-detail.cjs`, `service/src/web/static/spec-detail.css` (nếu `home.css` không đủ)
- Modify: `service/src/web/routes.cjs` (route `board-spec`, viewer), `service/src/web/server.cjs` (truyền `operator: boolean` vào handler viewer — đọc cookie, không throw)
- Test: `service/tests/web-spec-detail.test.cjs`

**Interfaces:** route `GET /board/<token>/<KEY>/spec/<id>`; `specDetailPage(detail, { token, operator, now }) → html`.

- [ ] **Step 1: Test đỏ:**
  - `detail page renders the five sections`: có `Tóm tắt`, `Tiến trình`, `Vấn đề`, `Giao diện`, `<details>` `Kỹ thuật`; bảng UI có `35`, `90`.
  - `viewer of another project gets 404`; `unknown spec 404`.
  - `no operator cookie shows no job buttons`.
  - `text is redacted`: issue title chứa chuỗi dạng token Discord → không có trong HTML.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** cài trang (`page()` + `esc`/`redact`, `reload: 60`), route, cờ `operator` cho viewer.
- [ ] **Step 4:** PASS; `npm test` xanh.
- [ ] **Step 5:** `git commit -m "feat(board): spec detail page"`

### Task 5: Log job trực tiếp

**Files:**
- Create: `service/src/board/job-log.cjs`, `service/src/web/static/job-log.js`
- Modify: `routes.cjs` (route viewer `GET /board/<token>/<KEY>/job/<id>/log?offset=<n>`), `page-spec-detail.cjs` (khung log cho job đang chạy hoặc job cuối)
- Test: `service/tests/board-job-log.test.cjs`

**Interfaces:** `readJobLog(ctx, job, offset, { maxBytes = 65536, maxLines = 200 }) → { lines: [{ at, kind: 'say'|'tool'|'result'|'error', text }], offset, done }`.

- [ ] **Step 1: Test đỏ:**
  - `stream-json lines become readable rows`: dòng assistant text → `say`; tool_use Bash `{command}` → `tool` "Bash: <lệnh rút gọn 200 ký tự>"; tool_result lỗi → `error`; `result` → `result` kèm USD.
  - `offset resumes after the last full line`: file ghi nửa dòng cuối → offset dừng trước nửa dòng; gọi lại sau khi ghi tiếp → trả đúng dòng đó.
  - `offset past the end or a truncated file restarts at 0`.
  - `secrets are redacted`: dòng chứa giá trị secret đã nạp → `[ẩn]`.
  - `job of another project is 404` (qua route).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** cài; route trả JSON; `job-log.js` hỏi mỗi 2 giây khi job chưa `done`, nối dòng, tự cuộn khi đang ở đáy, dừng khi `done`.
- [ ] **Step 4:** PASS; `npm test` xanh.
- [ ] **Step 5:** `git commit -m "feat(board): live job log on spec detail"`

### Task 6: Nút Start / Pause / Stop job (operator)

**Files:**
- Create: `service/src/board/job-control.cjs`, `service/src/web/api-job.cjs`
- Modify: `routes.cjs` (`call('job-control', 'operator', /^\/api\/job\/(\d+)\/(start|pause|stop)$/, ...)`), `page-spec-detail.cjs` (nút khi `operator`), `static/job-log.js` (POST, hiện kết quả)
- Test: `service/tests/board-job-control.test.cjs`

**Interfaces:** `controlJob(ctx, id, action, now) → { ok: true, message } | throws ExpectedError`.
- `pause`: job `running` → `stopJob(job)`, state `parked`, `resume: true`, giữ `session_id`, `park_reason: 'tạm dừng từ board'`; trả thêm `takeover: 'cd <repo> && CLAUDE_CONFIG_DIR=<dz>/claude claude --resume <session>'` (đường dẫn rút gọn `~`).
- `stop`: job `running`/`queued` → dừng nếu chạy, `parked`, `resume: false`, `session_id` null, `park_reason: 'dừng từ board'`.
- `start`: job `parked`/`failed` → dùng `commands.retry` (giữ kiểm tra đợt), về `queued`; job paused chạy lại có `--resume`.

- [ ] **Step 1: Test đỏ:**
  - `pause keeps the session and parks`: job running giả (stopJob tiêm) → `parked`, `resume 1`, `session_id` giữ, có `takeover`.
  - `stop drops the session`: `session_id` null.
  - `start requeues a paused job with resume`.
  - `actions on a finished job are refused`: job `done` → ExpectedError, DB không đổi.
  - `starting job is refused`; `double pause refused`.
  - `api needs operator`: không cookie → 403; viewer token → 403.
  - `scheduler does not restart a paused job by itself` (tick sau pause, job vẫn `parked`).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** cài; transaction đổi state có điều kiện `WHERE id = ? AND state = ?` để hai tab không cùng thắng.
- [ ] **Step 4:** PASS; `npm test` xanh.
- [ ] **Step 5:** `git commit -m "feat(board): start, pause and stop jobs from the spec page"`

### Task 7: Đưa lên v2 và kiểm bằng mắt (cần người dùng)

- [ ] **Step 1:** `harnessCommit` AAP864 → commit Task 1; `git -C ~/.dev-zone-v2/harness checkout <sha>`; khởi động lại `dz run`
  v2 (tmux `-L dz-v2`, session `dz-run`), không đụng v1 pid khác.
- [ ] **Step 2:** mở board spec #3: card đúng bước, trang chi tiết đủ 5 phần, log job đang chạy tự chạy dòng; với cookie operator
  thử Pause → Start trên job thật (chỉ khi người dùng đồng ý), xác nhận job chạy tiếp bằng `--resume`.
- [ ] **Step 3:** ghi kết quả ngắn vào cuối spec thiết kế (mục "Kết quả thử"); `git commit -m "docs(dev-zone): board spec detail trial"`.
