# Dev-zone v2 03: Quiz câu tạm chia PO / Dev / QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Câu phát sinh khi code/review (câu tạm, `prov`) có đủ bối cảnh và hướng A/B/C như quiz clear-spec, gộp câu trùng, chia ba
phần PO / Dev / QA trên cùng một link quiz (mỗi phần nộp riêng, xem được phần khác), gửi ngay khi build xong và gửi lại cùng bản
cài; dev gửi tay được khi pipeline kẹt; desk biết và trả lời theo dữ liệu mới.

**Architecture:** Giữ mô hình `spec.data.prov` (items + một `round` cố định cho khoá draft). Thêm `role` cho item và `sent[role]`
thay cho bảng `spec_rounds` (không migration). Reviewer trả `needsPo` dạng object; build dừng vì cần chốt thì `missing` thành
lựa chọn. Trang quiz câu tạm chia phần theo role, API nhận `role` khi nộp. Waits mỗi role một cái, link kèm `#role`.

**Tech Stack:** Node ≥ 21 (`node:test`, `node:sqlite`).

**Brainstorm:** `silverside/plans/reports/brainstorm-261127-1059-role-split-provisional-quiz.md`. Chốt:
- Một link, bấm chọn phần; câu không rõ role ⇒ `po`.
- Gửi lần 1 khi build xong (vào `smoking`), lần 2 cùng bản cài (`po-trial`); chưa nộp thì cập nhật chính link đó.
- `dz spec ask <id>` + desk tool `ask` gửi ngay.
- Ngoài phạm vi: file tổng hợp riêng, link riêng mỗi role, bước Claude biên tập câu.

## Global Constraints

- Như plan 01/02: file `service/` < 200 dòng, không comment trong code, TDD, test không chạm mạng, không adb thật.
- Test: `cd service && env -u DZ_HOME -u DZ_CLAUDE_CONFIG npm test`; một file thêm
  `node --disable-warning=ExperimentalWarning --require ./tests/helpers/no-discord.cjs --test tests/<file>`.
- Commit conventional tiếng Anh, không nhắc AI, chỉ local. Tối đa 2 subagent.
- Dữ liệu cũ đọc được: item không có `role` ⇒ `po`; item chỉ có option A vẫn hiện được; `needsPo` chuỗi vẫn parse được.

## Review Focus

1. Nộp phần Dev không chạm phần PO/QA; nộp thiếu câu của phần ⇒ `MISSING` chỉ liệt kê câu của phần đó (Task 2, 3).
2. HARD vẫn chặn bản cài; `approveTrial` vẫn đòi hết câu mở mọi phần (Task 2).
3. `same: "Tn"` chỉ cập nhật item còn `open`; Tn sai/không mở ⇒ thêm câu mới, không ném lỗi (Task 1).
4. Desk `ask` chỉ người có role dev/po trong project mới gọi được; không lộ link quiz sang kênh khác (Task 4).

---

### Task 1: Câu hỏi có cấu trúc + gộp trùng

**Files:**
- Modify: `service/src/specs/feature-review.cjs`, `service/src/specs/phase-code-review.cjs`, `service/src/specs/provisional.cjs`
- Test: `service/tests/specs-feature-review.test.cjs` (hoặc file test review hiện có), `service/tests/specs-build-provisional.test.cjs`

**Interfaces:**
- Schema `needsPo` item: `{ role: 'po'|'dev'|'qa', question, context, now, options: string[1..2], recommend: 'A'|'B'|'C', why, same }`
  (`same` chuỗi rỗng hoặc `T\d+`). `parseFeatureReview` nhận cả chuỗi (⇒ `{ role:'po', question, now:'', options:[], recommend:'A', why:'', same:'' }`).
- Prompt bước 3: phân loại role (PO: hành vi/phạm vi/nội dung; Dev: kỹ thuật, SDK, cờ build; QA: cách kiểm, dữ liệu/thiết bị test;
  không chắc ⇒ po); `now` = code đang làm gì (thành lựa chọn A); `options` 1–2 hướng khác (B, C); trùng ý câu đang mở ⇒ ghi `same`.
- Payload review thêm `asked: [{ qid, role, title }]` (câu `open`), `readPayload` lọc (≤ 40 mục, chuỗi cắt 200), in bằng `dataBlock('asked', ...)`.
- `provisional.addQuestions(run, items, kind)` nhận object: item = `{ key, qid, role, title: question, body: context, options:[A=now|kind.option, B, C], value:'A', picked:'A', recommend, why, hard }`.
  `same` trỏ item `open` ⇒ ghi đè `role,title,body,options,recommend,why`, giữ `qid,key`.

- [x] Test parse: object hợp lệ, chuỗi cũ, role lạ ⇒ lỗi; `same` ⇒ cập nhật T5 thay vì thêm T14.
- [x] Sửa schema/prompt/parse, payload `asked`, `addQuestions`.
- [x] `npm test` xanh, commit `feat(service): structured provisional questions with roles and merged duplicates`.

### Task 2: Mô hình role + thời điểm gửi

**Files:**
- Modify: `service/src/specs/provisional.cjs`, `service/src/specs/facade-provisional.cjs`, `service/src/specs/phase-build.cjs`,
  `service/src/specs/phase-trial.cjs`
- Test: `service/tests/specs-build-provisional.test.cjs`, `service/tests/specs-build-flow.test.cjs`

**Interfaces:**
- `prov = { items, next, round, sent: { po?, dev?, qa? }: { by, at, ids } }`. `round` gán một lần (`spec.round + 1`) khi mở lần đầu,
  không tăng nữa. Không dùng `spec_rounds` cho câu tạm.
- `rolesOpen(spec)`: role có item `open` chưa nằm trong `sent[role].ids`.
- `openRound(run, tag)`: với mỗi role trong `rolesOpen`, `openOnce(run, 'prov-<role>-<tag>', role, 'Chốt N câu (<Role>) phát sinh khi code spec …', link + '#' + role)`;
  trước đó `closeWaits(..., 'prov-<role>')` khi tag đổi. Không còn role mở ⇒ đóng hết `prov`.
- Gọi: `toSmoke` ⇒ `openRound(run, 'build-<serial>')`; `poTrial` ⇒ `openRound(run, 'trial-<sha12>')`; HARD trong `addQuestions` ⇒ `'hard'`.
- `submitProvisional(ctx, spec, role, by, now)`: thiếu câu của role ⇒ `{ ok:false, missing }`; đủ ⇒ `sent[role] = { by, at, ids }`.
- `settleRound`: với mỗi `sent[role]`, áp draft của `ids` (logic status hiện có), xoá `sent[role]`, đóng `prov-<role>`.
- `assumeBlock`: options = A `Làm theo cách tạm agent đã chọn` + `missing` (≤ 2) làm B/C; role = `found.role` nếu hợp lệ, không thì `po`.
- `questionOf`: `body` = context, `proposal` = `{ label: recommend, reason: why }`, thêm `role`, `current: picked`.

- [x] Test: build xong có câu dev+po ⇒ 2 waits (role dev, po) link `#dev`/`#po`; po-trial ⇒ ping lại; nộp phần dev ⇒ chỉ câu dev được áp; HARD vẫn chặn.
- [x] Code, sửa test cũ dùng `spec_rounds` cho câu tạm.
- [x] `npm test` xanh, commit `feat(service): split provisional quiz by role and send it after the build and with the install`.

### Task 3: Trang quiz ba phần

**Files:**
- Modify: `service/src/web/page-quiz.cjs` (tách phần render câu tạm sang `service/src/web/page-quiz-roles.cjs` nếu vượt 200 dòng),
  `service/src/web/api-quiz.cjs`, `service/src/specs/facade-quiz.cjs`, `service/src/specs/facade.cjs`, `service/src/web/static/quiz.js`
- Test: `service/tests/web-quiz*.test.cjs` tương ứng

**Interfaces:**
- `provisionalQuiz` trả `ask` có `role`, `sections: [{ role, open, sent: {by,at}|null, count }]`.
- Trang câu tạm: tab/heading `PO · Dev · QA` (ẩn phần rỗng), `<section id="po|dev|qa">`, mỗi phần có nút `Gửi phần <Role>` (`data-role`);
  phần đã gửi hiện câu trả lời chỉ đọc; câu hiện bối cảnh, “Code đang làm: A”, nhãn Đề xuất ở `recommend`.
- API `submit` câu tạm đọc `body.role ∈ {po,dev,qa}`, `by` = role; quiz clear-spec giữ `BY='po'`. `draft` từ chối câu thuộc phần đã gửi.
- `quiz.js`: progress + nút theo phần; gửi `{ round, role }`.

- [x] Test render (3 phần, ẩn phần rỗng, anchor), API submit theo role, draft phần đã gửi ⇒ closed.
- [x] Code + test xanh, commit `feat(service): provisional quiz page with po, dev and qa sections`.

### Task 4: Gửi tay, status, desk

**Files:**
- Modify: `service/src/spec-commands.cjs` (sub `ask`), `service/src/specs/facade.cjs` (`askNow`), `service/src/specs/overview.cjs`,
  `service/src/mcp/tools.cjs`, `service/src/mcp/actions.cjs` (hoặc file mới `service/src/mcp/ask.cjs`), `service/src/mcp/desk.cjs`,
  `service/channels/CLAUDE.md`, `service/README.md`
- Test: `service/tests/spec-commands*.test.cjs`, `service/tests/mcp-desk*.test.cjs`

**Interfaces:**
- `dz spec ask <id>`: spec đang build và có câu mở ⇒ `openRound(run, 'ask-<now>')`, in “Đã gửi N câu: PO a · Dev b · QA c”; không có ⇒ báo rõ.
- Overview `specs[]` thêm `asks: { po, dev, qa }` (đếm câu `open`); desk `status` trả thêm `asks`.
- Desk tool `ask` (`message_id`, `channel_id`): đọc tin, chọn project như `status`, spec = số trong tin (`#3`, `spec 3`) hoặc spec duy
  nhất có câu mở; người gửi phải có role trong project (như `requirePo`, chấp nhận dev); gọi `askNow`; trả lời trong thread.
- `channels/CLAUDE.md`: mọi câu hỏi tình hình ⇒ gọi `status` lại, không dùng câu trả lời cũ; “gom/gửi câu hỏi cho PO/dev/QA” ⇒ `ask`.

- [x] Test CLI, overview `asks`, desk `ask` (đúng spec, từ chối khi không có câu mở / không có quyền).
- [x] Code + README + guide, test xanh, commit `feat(service): send provisional questions on demand and show them in status`.

### Task 5: Triển khai v2

- [x] `cd service && env -u DZ_HOME -u DZ_CLAUDE_CONFIG npm test` xanh.
- [x] `~/Desktop/src/dev-zone`: `git merge --ff-only hung-apero/dev-zone-v2-phase-b`.
- [x] `kill -TERM` pid trong `~/.dev-zone-v2/service.lock`; tạo lại tmux `-L dz-v2` `dz-run` (lệnh như cũ); `dz desk stop` + `dz desk start`.
- [x] `dz status`, `dz doctor`; spec #3: 13 câu cũ hiện ở phần PO; vòng review sau viết lại có cấu trúc.
