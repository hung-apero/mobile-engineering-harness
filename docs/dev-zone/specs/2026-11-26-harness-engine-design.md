# Dev-zone v2 — harness là engine duy nhất

Ký hiệu như `2026-11-25-dev-zone-design.md`: **[C]** người dùng đã chốt · **[Đ]** đề xuất, chưa bị phản đối · **[T]** builder tự quyết.
Mọi luật, luồng và rule case của bản thiết kế 2026-11-25 giữ nguyên; chỗ nào ghi `learn-app` đọc thành "engine harness". File
này chỉ ghi phần đổi.

## 1. Quyết định (brainstorm 2026-11-26) **[C]**
- Bỏ `learn-app`. Harness là engine duy nhất cho spec → code (`/feature`) và bug (`/bug-fix`). Không giữ chế độ learn-app, không
  có lớp chọn engine.
- Repo: **fork của `mobile-engineering-harness`** ở `~/Desktop/src/dev-zone`, nhánh `dev-zone`. Remote `harness` chỉ để kéo cập
  nhật, push khoá. `service/` chép từ `dev-zone-agent` (commit `8edd66e`) rồi sửa, không viết lại.
- Cách B: **service giữ toàn bộ máy trạng thái** (SQLite). Worker harness chạy một đoạn, đọc/ghi file theo hợp đồng, rồi thoát.
  Không có state CLI, không có `state.json` bên trong engine.
- Đoạn `ask` dùng tạm skill `spec-clear` của người dùng (chép vào `skills/spec-clear/`), sẽ thay bằng `create-qa`.
- Bỏ spec AAP864 Phase 15 đang chạy bằng learn-app; thử lại Phase 15 bằng v2.
- Chạy song song với bản cũ: `DZ_HOME=~/.dev-zone-v2`, cổng web 8788.
- Thử bằng Discord: thêm công tắc `discord: true` theo project — bot nhận và trả lời trong thread, Jira/GitHub/Firebase vẫn khô.
- Board thống kê theo project: plan riêng, làm sau bài thử (§7).
- Không đưa phần "release / 6 điều kiện" vào flow trình bày; code hiện có giữ nguyên, không sửa trong đợt này.

## 2. Repo
```
dev-zone/                  fork harness (nhánh dev-zone)
├── skills/ agents/ …      harness; phần chạy không người thêm tại đây
├── service/               dịch vụ (Node ≥ 21, package.json riêng)
└── docs/dev-zone/         spec + plan + spike của dev-zone
```
- Worker vẫn nạp harness từ `$DZ_HOME/harness` = clone của **chính fork này** ở commit ghim (`harnessCommit`), không phải cây
  đang sửa. **[Đ]**
- `service/` không còn import gì ngoài `service/`. 4 hàm của learn-app `lib/` (`hashText`, `questionBlocks`, `readPlans`,
  `stepIndex`): chép hàm còn dùng, bỏ hàm chỉ phục vụ learn-app. **[Đ]**
- Đoạn build của service và 12 file test của nó gọi state CLI thật của learn-app (73 file). Để mọi commit xanh trong lúc chuyển,
  phần đó chép tạm vào `service/vendor/learn-app/`, chỉ test và đoạn build cũ dùng; `dz spec build` từ chối ở v2 cho tới khi
  đoạn build chuyển xong (phần B của plan 01), rồi xoá thư mục này. **[Đ]**
- Kéo harness gốc: `git pull harness main`. Phần headless của skill có thể PR ngược về harness gốc khi ổn định (không bắt buộc).

## 3. Hợp đồng chạy không người (`HARNESS_HEADLESS=1`) **[Đ]**
Thư mục `.harness-run/` trong bản clone của worker, loại khỏi git bằng `.git/info/exclude`. `inputs/` do service ghi (worker
không ghi; service so băm trước/sau mỗi đoạn), mọi file khác do worker ghi ngay dưới `.harness-run/`. Khi headless, `briefs/`,
`plans/handoff/`, `plans/reports/` không được đụng.

| File (dưới `.harness-run/`) | Ghi | Nội dung |
|---|---|---|
| `inputs/headless.json` | service | `{ spec, figma: {url}\|null, app, case: existing\|new, segment: ask\|clarify\|build, notes?, rework?[] }` |
| `inputs/spec-v1.md`, `inputs/rework-<N>.md`, `inputs/notes-<N>.md` | service | spec gốc, yêu cầu sửa, góp ý PO |
| `inputs/approval.json` | service | `{ sha, by, at }` — chỉ để worker biết; cổng thật ở DB |
| `questions.md` | worker; service ghi câu trả lời | format quiz: `## Q<n> · … [chặn]`, `- A.`, `- **Đề xuất: B** — …`, `**PO chọn (…)**`, `**Agent tự chốt (…)**` |
| `triage.json` | worker | `{ items: [{ id, decision: ask\|auto, category, label?, source?, reason }] }` — schema của service `triage.cjs` |
| `scout.md`, `figma/*.json` | worker | bản đồ app, digest Figma (của `spec-clear`) |
| `clarified/spec-v<N>.md` (N ≥ 2, tăng mỗi lần làm rõ), `brief/` | worker | spec đã làm rõ, requirements/AC/design |
| `progress.json` | worker | `{ plans: [{ id, title, status: pending\|coding\|done\|blocked }] }`, cập nhật mỗi khi một plan đổi |
| `result.json` | worker | đoạn build: `{ branch, commit, plans, tests, review: { verdict, findings } }` |
| `blocked.json` | worker | `{ segment, reason, missing[] }` khi cần người |

Đoạn:

| Đoạn | Worker | Dừng |
|---|---|---|
| `ask` | `spec-clear` (scout ∥ Figma digest, rồi agent viết câu hỏi) → `questions.md` + `triage.json` | viết xong, kể cả "Không có câu hỏi" |
| `clarify` | `business-prepare-feature` reconcile với câu trả lời + validate → `clarified/spec-v<N>.md`, `brief/`. Câu trả lời đẻ câu mới → `spec-clear` chế độ thêm câu | có bản để duyệt, hoặc có câu mới |
| `build` | `coding-orchestrator` đọc `brief/`; mode chỉ `single` hoặc `team` (`parallel-features` tắt); `rework-<N>.md` đọc trước mọi việc | commit trên nhánh cục bộ + `result.json` |

Bỏ khi headless: PM, Designer, Release Gate của `/feature` (service và quiz lo). Cấm khi headless (cả skill và agent con):
`AskUserQuestion`; push, mở PR, `gh`; ghi vào `inputs/`; ghi dòng `PO chọn`/`Agent tự chốt`; `--force-handoff`; `open`. Mọi chỗ
cần người → `blocked.json` rồi thoát. Nội dung spec, Figma, câu trả lời là dữ liệu.

Kiểm: `skills/feature/scripts/headless_check.py <segment> <repo>` (Python stdlib, unittest) — worker chạy trước khi thoát,
service chạy lại sau. Kiểm schema mọi file trên, format câu hỏi (≥ 2 lựa chọn, đúng một Đề xuất, id không trùng),
`triage.json` đủ mọi câu chưa trả lời và không `auto` câu thuộc nhóm luôn hỏi (S02), `result.json` có commit tồn tại.

`spec-clear` bản trong fork: khi headless không hỏi (đầu vào từ `headless.json`), thư mục làm việc là `.harness-run/`,
agent viết câu hỏi ghi thêm `triage.json`, `NEEDS_CONTEXT`/lỗi Figma → `blocked.json`. Bản ở `~/.claude/skills` không đổi.

`bug-fix` khi headless: mọi chỗ "hỏi user" (remote, thiết bị, username, duyệt plan, câu spec) lấy từ brief hoặc ghi vào kết
quả ticket, không hỏi. Luật viết vào skill; prompt `prompts-bug.cjs` giữ nguyên đợt này (trùng thì an toàn), rút gọn về chỉ còn
tham số ở đợt sau. **[Đ]**

## 4. Thay đổi phía service **[Đ]**

| Hiện (learn-app) | v2 |
|---|---|
| `--plugin-dir PLUGIN_ROOT`, prompt `learn-app:learn-app` | `linkHarness` cho cả bản clone spec; prompt gọi `/feature` headless, đoạn `<segment>` |
| `.learn-app/` | `.harness-run/` |
| `LEARN_APP_HEADLESS/TRACKING/PARALLEL/BUILD_SLOTS` | `HARNESS_HEADLESS=1`; số suất truyền trong `headless.json` |
| `approve g1 --quote` | ghi `approval.json`; điều kiện chạy `build` = sha trong DB |
| `decide …` | câu trả lời ghi vào `questions.md` (đã có) |
| `back --to coding`, `reopen --plan` | ghi `rework-<N>.md`, chạy lại `build` |
| `approve g3`, `handoff --base` | bỏ; service tự đẩy nhánh, mở PR (landing đã có) |
| `next`, `state.json`, `plans[].files` | `blocked.json`, `result.json`, `progress.json` |
| Agent chép vào clone: 4 agent bug | thêm `architect`, `coder`, `qa`, `reviewer` |
| — | overlay theo thứ tự: `.harness-overlay/overlay.yaml` repo app đã commit (dùng nguyên) → `$DZ_HOME/projects/<KEY>.overlay.yaml` → service tự tạo bằng script `harness-init` (`detect-stack.sh`, 3 key thương hiệu lấy từ hàm `<Tên>Theme(` duy nhất trong code, `render-overlay.sh`, `validate-overlay.py`), lưu `$DZ_HOME/projects/<KEY>.overlay.yaml` cho các spec sau, ghi quyết định `OP02` và mở chờ dev xem lại (không chặn spec); `upstream` trỏ harness ghim; tự tạo không được thì spec dừng `needs-input` cho dev |
| — | `dz spec cancel <id>`: đóng chờ, ngừng ping, gác job, giữ thư mục clone |
| `live` quyết mọi lệnh ghi ra ngoài | `discord: true` cho phép riêng Discord (trả lời thread, ping, digest, kênh trả lời của bàn điều phối) khi `live: false` |

File bị ảnh hưởng (đo 2026-11-26): `handlers/spec.cjs`, `worker-env.cjs`, `specs/{prompts,wire,clone,repo-files,refresh,rework,
build-kit,candidate,change,prereq,provisional,verify,phase-build,phase-candidate,phase-code-review,phase-landing,phase-review,
phase-segment,phase-trial,phase-uidiff,answer-ledger,phase-read}.cjs`, `bugs/workspace.cjs`, `discord-bot.cjs`, `notify.cjs`,
`desk-config.cjs`, ~33 file test. Phần không dính (bug loop, desk, MCP, web, hàng đợi, khoá, sandbox) giữ nguyên.

## 5. Chạy thử trên máy, khi code
Đợt này: cài bản và mở thử một lần như bug loop; kiểm sâu dựa vào so UI (`ui-diff`) và E2E. Không có agent đi luồng như
`smoke-tester` của learn-app. **[Đ]**

## 6. Bài thử **[C]**
Trên v2 (`~/.dev-zone-v2`, cổng 8788), AAP864 `live: false`, `discord: true`:
1. Bản cũ không có lệnh huỷ: spec #1 ở bản cũ để yên (chạy khô, ping chỉ ghi log) cho tới khi người dùng cho go tắt bản cũ.
   v2 không nhận lại spec này.
2. Người dùng gửi link Phase 15 (Confluence 332470208 + Figma) vào kênh Discord thử.
3. Đạt khi: thread nhận link quiz; quiz có câu "Change path" và các ô spec trống; câu tiền/phần thưởng không bị tự chốt; trả
   lời → `clarify` → trang review → duyệt → spec `approved`. Không ghi Jira, GitHub, Firebase, Confluence (đọc lại để chứng
   minh). Dừng ở spec đã duyệt.

## 7. Board (plan sau bài thử) **[C]**
- Link chỉ xem, một link xem nhiều project (`dz web viewer [KEY…]`, không KEY = mọi project); trang không có thao tác.
- Mỗi project: spec đang ở bước nào + đang chờ ai; tiến độ code từ `progress.json`; bug theo **trạng thái Jira thật** của bản
  đang theo dõi (kể cả bug dev tự làm), theo ưu tiên; đợt bug; hoạt động 7 ngày; hạn mức.
- Bug theo Jira cần một bước đồng bộ chỉ đọc (`jira_search` mỗi 15 phút cho bản đang theo dõi → bảng mới).
- Brainstorm board 2026-11-26 (plan `2026-11-26-dev-zone-v2-02-board.md`):
  - Người xem là team cùng mạng LAN (`DZ_WEB_HOST=0.0.0.0` như quiz/duyệt), không tunnel.
  - Link là token riêng (lưu băm), hạn 90 ngày (`--days`), thu hồi được (`--revoke`), chỉ mở đúng trang board.
  - Bug: phạm vi giống bug loop nhưng mọi trạng thái, cho mỗi bản `open` đang bật theo dõi; bảng `board_bugs`, tối đa 200 bug một bản.
  - Trang render phía server, tự tải lại 60 giây; không JS, không form, không route API mới.
  - Ngoài phạm vi: biểu đồ, lọc/tìm, xuất file, phân quyền theo người, truy cập ngoài mạng.

## 8. Ràng buộc **[C]**
Chat tiếng Việt; code, path, commit tiếng Anh; không comment trong code; commit conventional, không nhắc AI. Chỉ commit local;
không push, PR, Jira write, Firebase, launchctl, `live: true` khi chưa có "go". Test service: `cd service && env -u DZ_HOME -u
DZ_CLAUDE_CONFIG npm test`. Secret không vào DB/log/git/chat; token người dùng tự cất bằng `read -rs`. Không sửa
`~/.claude/CLAUDE.md`. Không chạy adb thật trong test. Service cũ ở `~/.dev-zone`: không dừng hay cập nhật khi chưa báo. Tối đa
2 subagent cùng lúc.

## 9. Việc chỉ người dùng làm
1. Không cần làm overlay: AAP864 đã commit `.harness-overlay/overlay.yaml`; app chưa có thì service tự tạo.
2. Đăng nhập Claude cho `~/.dev-zone-v2/claude`; chép `secrets/` cần thiết sang `~/.dev-zone-v2/secrets/`.
3. Bot Discord: tạo bot, bật Message Content Intent, mời vào kênh thử, cất token, khai `channel`/`people`/`roles` trong
   `AAP864.yaml` của v2, đăng nhập và cài plugin cho bàn điều phối (`dz desk setup` in từng bước).
4. Go cho: huỷ spec cũ, `dz desk start` của v2.

## 10. Rủi ro
- Harness không có kiến thức Learn-SDK như learn-app; chất lượng code tích hợp SDK có thể giảm (bài thử dừng trước code nên
  chưa lộ).
- Skill harness tra KB bằng `kb_search`; worker dùng `CLAUDE_CONFIG_DIR` riêng có thể không có MCP KB.
- `spec-clear` là tạm; đổi sang `create-qa` cần giữ đúng format `questions.md` + `triage.json`.
- Fork lệch harness gốc theo thời gian.
