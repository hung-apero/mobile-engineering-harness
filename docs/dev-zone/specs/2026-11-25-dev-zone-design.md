# Dev-zone — thiết kế bản đầu

Ký hiệu: **[C]** người dùng đã chốt · **[Đ]** đề xuất, chưa bị phản đối · **[T]** việc để builder tự quyết.

## 1. Mục đích

Các phòng ban (PO, QA, Design) làm việc qua Discord, Jira và một trang quiz; Claude tự làm từ spec tới bản cài và tự
sửa bug. Hạn chế tối đa việc dev phải tương tác, hệ thống không dừng vì thiếu người. **[C]**

### Mục tiêu
- Flow tự chạy, con người đưa ra rule cho từng case (§11). **[C]**
- Spec gửi vào Discord → app/tính năng có PR và bản cài Firebase, dev chỉ bấm merge. **[C]**
- Bug trên Jira được tự nhận, tự sửa, trả về QA kiểm. **[C]**
- Chỉ hỏi người khi thật sự cần; câu có bằng chứng hoặc hợp lý thì agent tự chốt. **[C]**

### Ngoài phạm vi bản đầu (TODO) **[C]**
- Video demo → spec (khởi điểm: skill `product-spec-creator`).
- Hermes học KB. Bản đầu chỉ dùng `lesson-miner` sẵn có, dev duyệt qua PR.

### Ngoài phạm vi **[C]**
- Đưa bản lên store. Dev-zone dừng ở báo "đủ điều kiện release" (§7); lên store theo cách team đang làm.

### Không được xảy ra
- Agent merge vào nhánh gốc (chỉ được gộp vào `dz/release-<version>`), force-push, xoá ticket Jira, ghi đè tài liệu gốc của PO.
- PR tính năng được báo sẵn sàng khi PO chưa duyệt hoặc E2E chưa đạt; PR bug được báo sẵn sàng khi agent chưa kiểm hoặc chưa
  review xong.
- Hai việc cùng điều khiển một thiết bị; một ticket chạy hai lần; một project lỗi làm dừng project khác.
- Nội dung ticket, spec, tin nhắn được hiểu là lệnh cho agent. Chúng luôn là dữ liệu.

## 2. Ràng buộc
- Chạy trên một Mac mini bật 24/7, có thiết bị Android, Android Studio, Artifactory. **[C]** Ít nhất 2 thiết bị. **[Đ]**
- Source mới clone từ `learn-app-plugin` tại `6d3a5b4`, nhánh `dev-zone`; remote `learn-app` chỉ để kéo cập nhật, push
  đã khoá. **[C]** Chưa có repo GitHub riêng.
- Jira tự cài tại công ty; quét bằng polling, không webhook; dùng Jira MCP với token của người dùng, không tài khoản
  bot. **[C]**
- Claude Code 2.1.330, Node ≥ 21, **Bun** (plugin Discord cần). Channels cần đăng nhập claude.ai hoặc Console API key; gói
  Team/Enterprise phải được Owner bật. Test chỉ chạy bằng `npm test` (đã tách webhook Discord thật).
- Tài khoản Claude: **tài khoản hiện tại của người dùng [C]**, dùng chung hạn mức với việc hằng ngày. Cấu hình của dev-zone
  tách bằng `CLAUDE_CONFIG_DIR` riêng (đăng nhập cùng tài khoản), để không nạp CLAUDE.md, plugin, hook cá nhân. Đặt ngưỡng:
  qua 80% hạn mức tuần thì không nhận việc mới, chỉ làm nốt. **[Đ]** Đọc được bằng máy (đã thử, 2.1.332): sự kiện
  `rate_limit_event` trong `--output-format stream-json` có `unifiedWindows.seven_day.utilization` và `resetsAt`. Dùng thêm ngoài hạn
  mức đang bị tổ chức tắt. `CLAUDE_CONFIG_DIR` riêng cần đăng nhập một lần (đã thử).
- Máy: **chính Mac mini M4 16GB đang dùng hằng ngày [C]**. Tối đa 2 agent code trong giờ làm việc (9–18h, thứ 2–6), 3 ngoài
  giờ, 1 lượt build. Worker làm trong bản clone riêng của dev-zone, không đụng checkout hay worktree đang mở của người dùng.
  Thiết bị người dùng đang cần thì ghi vào danh sách loại trừ. Máy không được ngủ. **[Đ]**

## 3. Phương án đã cân nhắc

| | Mô tả | Đánh đổi |
|---|---|---|
| **A [C, 2026-11-25]** | Claude Code Channels nhận tin Discord + service nền (quét Jira, hàng đợi, quiz, worker) | Không phải viết bot; nhưng phiên phải luôn mở, chỉ lọc user ID, không có nút duyệt, còn là research preview |
| B | Một service duy nhất, tự viết bot | Có role và nút, nhưng phải viết và nuôi bot. Từng được chọn, sau đó người dùng đổi sang A |
| C | Claude trên cloud | Không có thiết bị Android, Artifactory |

Tái dùng thay vì viết mới **[Đ]**:
- Discord: **không dùng `claudecode-discord` [C]**. Nhận tin bằng plugin `discord@claude-plugins-official` (0.0.6). Service
  gửi tin và kiểm người gửi bằng REST với cùng bot token, dựa trên `lib/discord-notify.cjs` và `discord-replies.cjs`.
- Luồng bug: **`bug-fix` của `mobile-engineering-harness`, mode batch [C]**. Không dùng `jira-bug-analyzer`, không chấm điểm
  độ chắc chắn. CLAUDE.md cá nhân đang ép dùng `jira-bug-analyzer` khi thấy mã ticket; máy Mac mini không được có luật và
  plugin đó, nếu không worker sẽ bị kéo sang skill cũ. **[Đ]**
- `learn-app` (chính source này), `android-test-harness`, `ui-diff`/`ui-fix-loop`, `tera-distribute`, graphify.

## 4. Kiến trúc

```
Discord ⇄ phiên điều phối (Channels, tmux, launchd)
              │ chỉ có tool `dz`
              ▼
        ┌──────── service/ (launchd) ────────┐
Jira  ⇄ │ quét Jira   quiz web   hàng đợi     │ → gửi tin Discord (REST)
        │ khoá: 3 agent code · 1 build · máy  │
        └────┬─────────────┬─────────────┬────┘
         claude -p     claude -p      claude -p
         learn-app   bug-fix (batch)   so UI / E2E
```

**Phiên điều phối (Channels) [C: dùng Channels; Đ: các luật dưới]**
- Chỉ hiểu tin nhắn, hỏi lại, và gọi MCP server `dz` của service: `submit`, `answer`, `approve`, `status`, `pending`,
  `ack`. Không có Bash, Edit, Jira, repo. Mọi tool khác bị từ chối sẵn, nên không có hộp hỏi quyền làm phiên treo.
- `approve` chỉ truyền `message_id`. **Service tự đọc lại tin đó từ Discord** để lấy người gửi và role; không tin ID do
  Claude truyền. Nhờ vậy vẫn phân quyền được theo role của project.
- `access.json`: mỗi kênh phải khai `allowFrom` (để trống là mọi người trong kênh đều gửi được); DM chỉ cho dev trực.
- Không có phiên thì sự kiện mất. Service đối chiếu lịch sử kênh với các tin đã `ack`; phiên mới gọi `pending` để làm bù.
  Quá 2 phút chưa `ack` thì service khởi động lại phiên.
- Mọi trạng thái nằm trong service, phiên tắt bật tuỳ ý; khởi động lại mỗi ngày lúc rảnh để context nhẹ.
- Worker không nạp Channels.

- `service/` là thư mục mới, có `package.json` riêng; phần plugin ở gốc giữ nguyên cấu trúc để còn kéo được cập nhật từ
  `learn-app`. **[Đ]**
- Plugin trong source này giữ tên `learn-app` (agent được gọi bằng tiền tố `learn-app:`). Mac mini nạp bản này thay cho
  bản cài từ marketplace. **[Đ]**
- Mỗi việc = một worker `claude -p`, một worktree, một thread Discord, một session id để chạy tiếp sau khi dừng. Worker
  có danh sách lệnh được phép duyệt sẵn; lệnh ngoài danh sách thì dừng và báo thread.
- Trạng thái của service nằm trong SQLite; khởi động lại thì đối chiếu với tiến trình, worktree và Jira rồi chạy tiếp.
- "3 agent code" đếm **agent viết code trên cả máy**, kể cả agent con bên trong một worker `learn-app`; service cấp suất,
  luôn chừa 1 suất cho bug. Không ngắt việc đang chạy; `Highest` chen trước việc chưa bắt đầu. `LEARN_APP_BUILD_SLOTS=1`
  (mặc định hiện tại là 2 ở máy 16GB). **[Đ]**
- Lệnh ngoài danh sách: không ai duyệt lệnh từ Discord. Dev sửa danh sách trong cấu hình rồi bấm "chạy lại". Worker chạy
  bằng `claude -p` hoặc Agent SDK đều được. **[Đ]**
- Một khoá thiết bị chung cả máy: `devices.py` của `bug-fix` với `BUG_FIX_STATE_DIR` trỏ về một thư mục chung (mặc định nó
  khoá riêng từng repo). `smoke-tester` (đang dùng mọi thiết bị cắm vào), so UI và `android-test-harness` phải dùng khoá
  này. **[Đ]**
- `claude -p` giữ phiên và đánh thức leader khi agent nền xong (đã thử với agent chạy 75 giây). Còn phải thử với việc dài hàng giờ
  và nhiều agent cùng lúc; không được thì dùng `claude --bg`. **[Đ]**
- Hết hạn mức Claude: dừng hàng đợi, báo Discord, tự chạy tiếp khi có lại.
- Discord: service kiểm **role** của từng project khi duyệt và nhận việc; dev trực là role riêng.

### Cấu hình theo project **[C: tách theo project]**
`projects/<KEY>.yaml`: repo, nhánh gốc, flavor, package, tên trạng thái Jira, role PO/QA/Design/dev trực, kênh Discord,
link spec và Figma, thiết bị, `enabled`. Mốc polling nằm trong trạng thái của từng version, không phải cấu hình. Thêm app = thêm một file.

Riêng từng project: quét Jira, hàng đợi, worktree, graphify, KB app, kênh, PR, bản cài. Dùng chung: 3 agent code, 1
build, khoá thiết bị, KB chung. Lỗi 3 lần liên tiếp thì chỉ tạm dừng project đó. Bug `Highest` trước, còn lại xoay vòng
giữa các project; tối đa 2 bug cùng lúc mỗi project. **[Đ]**

## 5. Luồng spec

1. PO gửi vào kênh yêu cầu: link Confluence / Google Doc / file, link Figma, tên app. Thiếu thì hỏi lại trong thread.
2. Chạy `learn-app`: đọc spec, scout (thêm graphify bằng script của `bug-fix`), soạn câu hỏi.
3. **Luật hỏi [C: nguyên tắc; Đ: bảng]**

| Trường hợp | Làm |
|---|---|
| Spec, Figma, code, KB trả lời rõ, không mâu thuẫn | Tự chốt, ghi nguồn |
| Không có bằng chứng nhưng hợp lý và dễ sửa (cách vẽ, animation) | Tự chốt, ghi lý do |
| Nguồn mâu thuẫn | Hỏi |
| Tiền, quảng cáo, Premium, phần thưởng, xoá dữ liệu, bỏ yêu cầu, thư viện không làm được, mà chưa có bằng chứng | Hỏi |
| Dùng dữ liệu mẫu | Luôn hỏi |

4. **Quiz [C]:** thread chỉ gửi link. Mỗi câu có lý do hỏi, lựa chọn, đề xuất, ô "Khác". **More** để hỏi agent: agent chỉ
   có quyền đọc, trả lời ngay trên quiz, PO vẫn phải tự chọn. **More questions** liệt kê câu đã tự chốt kèm nguồn, đổi
   được. Đăng nhập bằng Discord; link cố định cần một domain **[Đ]**.
5. PO gửi → viết spec đã làm rõ → gửi **cả quiz lẫn Discord [C]** (tóm tắt + PDF + link; quiz tô phần đổi, nhãn
   `PO chọn` / `Agent tự chốt`).
6. Duyệt bằng nút trên quiz hoặc reply trên Discord; chung một trạng thái, gắn với đúng phiên bản, chỉ PO của app.
   "ok nhưng…" là góp ý. **PO im lặng thì ping lại trên Discord, không tự chọn, không tự duyệt [C]** (nhịp ở §11).
7. Khi duyệt: **một** comment dẫn tới bản duyệt trên Confluence/Google Doc, không sửa bản gốc. **[C]** File đính kèm không
   có bản gốc để comment.
8. Câu phát sinh khi code: **tạm chọn, code tiếp, thêm vào quiz, báo thread [C]**. Câu khó quay lại (xoá dữ liệu người
   dùng, giao dịch tiền thật) thì dừng riêng phần đó chờ PO. **[Đ]** Câu tạm chọn không làm mất hiệu lực lần duyệt spec, nhưng
   PO phải xác nhận hết trước khi PR sẵn sàng. **[Đ]**

### App mới tinh **[C: có trong bản đầu, xin dev đủ thứ một lần lúc đầu]**
Dựng bằng đường "App mới" sẵn có của `learn-app` (`AndroidTeraTemplate` nhánh `learn`, `init-product`,
`figma-design-system-android`). Ngay sau khi nhận spec, bot gửi **một** danh sách cho dev trực và kiểm từng mục bằng máy **[Đ]**:

| Dev cung cấp một lần | Kiểm |
|---|---|
| Repo GitHub trống, quyền ghi | `git ls-remote` |
| Mã app, package, tên app | Trùng định dạng `product.properties` |
| Firebase project, `google-services.json`, nhóm tester App Distribution | Package khớp, upload thử |
| Chữ ký release (hoặc đồng ý chỉ dùng bản dev) | Build được |
| Project Jira, kênh và role Discord | Đọc được |
| Khoá quảng cáo, license, API | Có thể để tạm theo `started-info.md`, ghi lại để thay trước khi lên store |

- Trong lúc chờ, agent vẫn làm spec, quiz, duyệt; chỉ bước code cần repo, bước gửi bản cài cần Firebase.
- Thứ bí mật đặt vào file trên máy theo đường dẫn bot nêu, **không gửi qua Discord**.
- Đủ thì service tự tạo `projects/<KEY>.yaml`. Project thử không phải app mới, nên đường này có một lần chạy nghiệm thu
  riêng trước khi mở cho PO.

## 6. Luồng code → bản cài

Chia plan → code (≤ 3 plan) → review → gộp → chạy thử trên máy (≤ 2 vòng) → **so UI từng màn với Figma qua deep link,
≤ 3 vòng sửa** → PR nháp + bản cài Firebase → PO thử, **E2E chạy song song [C]** → PR sẵn sàng khi PO duyệt **và** E2E đạt
**[C]** → service gộp vào `dz/release-<version>` → **build cho QA ngay [C]** → dev merge PR luôn mở của nhánh version lúc nào cũng được
**[C]** (cách làm ở §7). Bản cài PO thử trước khi gộp vẫn giữ.

| Tình trạng | Làm **[Đ]** |
|---|---|
| Build đỏ, mở app crash, luồng chính không đi được | Không gửi bản cài, @ dev trực kèm log |
| Lệch UI, lỗi nhỏ, nợ review, câu tạm chọn | Vẫn gửi, liệt kê ở đầu tin |

E2E: test case tự sinh từ spec đã duyệt, QA có Sheet thì dùng Sheet; `android-test-harness` nhận sẵn input, không hỏi
tester. Lỗi E2E và góp ý của PO được agent tạo ticket Jira hộ rồi vào luồng bug, sửa trên cùng PR, gửi bản mới. Sau 2
vòng còn lỗi thì QA chọn sửa tiếp hoặc chấp nhận; QA chấp nhận được ghi lại trong PR và tính là E2E đạt. **[Đ]**

## 7. Luồng bug

**Gửi bản build cho QA xong thì bật polling của project, có bug là tự sửa [C].** Không có bản build thì không quét.

| Trạng thái polling **[Đ]** | Khi nào |
|---|---|
| Tắt | Mặc định; project chưa có bản build nào của bản đang làm tới QA |
| Bật, 3 phút/lần | Firebase báo gửi bản build thành công. Mốc tính bug = lúc gửi bản **đầu tiên** của version; các bản sau giữ mốc |
| Bật, 15 phút/lần | 24 giờ không có bug mới |
| Vẫn bật | Đã báo "release được"; bug Highest/High mới thì thu hồi lời báo đó |
| Tắt | PO xác nhận bản đã release hoặc huỷ; dev trực tạm dừng |

Bug E2E hoặc góp ý của PO trước khi merge không qua polling: vào thẳng hàng đợi, sửa trên PR tính năng. App chỉ cần sửa bug, không
có tính năng mới: dev trực hoặc PO gõ "bật fix bug <app> <version>".

Script gọi `jira_search` qua MCP, không qua Claude:

```
project = <KEY> AND issuetype = Bug AND status in (<chờ>)
AND (labels is EMPTY OR labels not in ("human-only")) AND created <= -2m
AND (created >= "<mốc>" OR fixVersion = "<version>" OR status changed to Reopened after "<mốc>" OR labels = "claude-fix")
ORDER BY priority DESC, created ASC
```
(đã chạy thử đọc trên AAP864 với mốc giả định; `fixVersion` chỉ thêm khi version có trên Jira)

- Nhận ticket ở `Request`, `To Do`, `Reopened`, **kể cả đã gán dev [C]**; đọc lại trạng thái ngay trước khi nhận, rồi chuyển
  `In Progress` và gắn nhãn `claude-fixing`. Dev muốn tự làm: `In Progress` hoặc `human-only`.
- Mỗi đợt: service giao các mã ticket cho `/bug-fix-orchestrator <KEY…> --repo … --spec … --figma … --yes` (luôn mode batch,
  kể cả một ticket, vì mode note hoãn test thiết bị). **[Đ]**
- **Quyết định sửa hay không theo spec, không theo điểm [C: bỏ chấm điểm]:** `bug-fix` so từng bug với spec/Figma và code.

| `bug-fix` kết luận | Dev-zone làm **[Đ]** |
|---|---|
| `confirmed`, có trích dẫn spec/Figma | Sửa |
| `needs-confirm`, `spec-gap`, `conflict` | Hỏi PO; bug khác vẫn chạy; trả lời xong vào đợt sau |
| `needs-info` | Comment hỏi QA đúng thứ thiếu |
| `not-a-bug`, `duplicate`, `already-fixed`, `external` | Comment căn cứ, QA quyết |
| Thanh toán, bảo mật, migration DB, contract chung; sửa 2 vòng vẫn trượt | Dừng riêng bug đó, @ dev trực |

  Bug không sửa vẫn ở trạng thái chờ, nên sổ ticket nhớ kết luận và chỉ nhận lại khi ticket có comment/ảnh mới, có câu trả
  lời, bị reopen, hoặc gắn `claude-fix`.
- **Kiểm chứng theo mức của `bug-fix`:** `none` / `unit` / `preview` / `device`, lấy mức thấp nhất đủ chứng minh. Chỉ bug mức
  `device` mới chạy trên thiết bị. Bản cài của đợt được cài và mở thử một lần. **[Đ]**
- **Nhánh version + PR luôn mở [C, thay "dev merge từng PR rồi mới build QA"].** Mỗi version có `dz/release-<version>` tách từ nhánh gốc và
  **một** PR luôn mở vào nhánh gốc. Đợt bug của project: nhánh `dz/bugs-<project>-<ngày>` làm base của batch, PR từng lane vào đó sau khi
  `bug-reviewer` duyệt, đạt cổng (§11) thì service gộp cả đợt vào nhánh version. Mỗi bug một commit **[C]**; cùng nguyên nhân chung một
  commit. Chốt đợt khi hết bug, đủ 8 bug, hoặc quá 4 giờ; Crash/`Highest` đi đợt riêng. Bug chưa kiểm được sang đợt sau. Bug của tính năng
  chưa gộp thì sửa trên PR tính năng đó (nhãn `dz-<mã việc>`). **[Đ]**
- **Dev merge PR của nhánh version lúc nào cũng được, flow không chờ [C].** Càng merge thường PR càng nhỏ: 60 PR gần nhất của AAP864, PR
  ≤ 400 dòng chờ trung vị 0,6–0,8 giờ, PR > 400 dòng chờ 14,4 giờ, lâu nhất 64,9 giờ. Nên merge bằng merge commit (repo cho phép); nếu dev
  squash thì service mở nhánh version kế tiếp từ nhánh gốc, không force-push. **[Đ]**
- **Gộp xong là build cho QA [C].** Build từ đúng commit trên nhánh version, gửi Firebase, rồi comment Jira (PR, link bản cài, ảnh, bước
  kiểm) và chuyển `Resolved`; gộp trong 15 phút thì chung một bản. Ghi chú bản cài liệt kê ticket và mã commit. **[Đ]**
  - Build đỏ hoặc mở app crash: không gửi, `git revert` lần gộp vừa rồi, ticket giữ `In Progress`, sửa ở đợt sau.
- QA đóng ticket, hoặc mở lại → đợt mới. Reopen lần 3: giao dev.
- Comment mở đầu `[Claude]` vì mang tên chủ token.
- Jira lỗi: giãn nhịp tới 15 phút, quá 30 phút báo Discord.

### Khi nào fix bug xong và release được **[Đ]**
Mỗi bản (version) có một vòng fix riêng. Sau mỗi lần gộp vào nhánh version, dev merge, QA đổi trạng thái, hoặc E2E xong, service tự chấm 6 điều
kiện và cập nhật thread; đủ 2–6 trên nhánh version thì ping dev merge, đủ cả 6 thì báo "đủ điều kiện release". Cây mã sau merge trùng
cây đã test thì điều kiện 6 giữ nguyên, khác thì build và E2E lại.

| # | Điều kiện | Lấy từ đâu |
|---|---|---|
| 1 | Mọi thay đổi của bản đã vào nhánh version, và nhánh version đã được dev merge vào nhánh gốc | GitHub |
| 2 | Không còn bug `Highest`/`High` mở của bản | Jira |
| 3 | Mọi bug `Resolved` của bản đã được QA đóng, không còn `Reopened` | Jira |
| 4 | Bug `Medium`/`Low` còn lại: đã sửa, hoặc PO hoãn sang bản sau | Jira + quiz |
| 5 | Không còn câu hỏi PO chưa trả lời ảnh hưởng bản này | Sổ câu hỏi |
| 6 | E2E đầy đủ + nâng cấp từ bản store đạt trên **chính bản build sẽ phát hành** | harness |

- **Bug của bản** = `fixVersion` là bản đó, hoặc tạo từ lúc mở bản mà chưa có `fixVersion`; agent điền `fixVersion` khi nhận
  (AAP864: 64/129 bug từ 01/10 không có). Bug tồn cũ không tính: AAP864 có 9 bug Highest/High mở từ tháng 7–10, nếu tính thì
  không bao giờ release được; agent gửi PO danh sách này một lần để chọn đưa vào hay không.
- **Để vòng fix hội tụ:** khi mọi tính năng đã vào nhánh version và điều kiện 2 đạt thì đóng bản. Từ đó chỉ sửa `Highest`/`High` và lỗi do chính
  lần sửa gây ra; `Medium`/`Low` mới vào bản sau. Mỗi lần nhánh thay đổi thì build lại, điều kiện 6 chạy lại.
- QA không chặn việc gộp và merge, nên **QA chặn ở điều kiện 3**.
- Quá 3 bản build sau khi đóng mà chưa đủ: báo PO và dev trực kèm các điều kiện còn thiếu.

### Chỗ phải chỉnh `bug-fix`
| Hiện tại | Cần |
|---|---|
| Mỗi lane một PR, không merge | Base là nhánh đợt; service gộp PR lane vào nhánh đợt, rồi đợt vào nhánh version |
| `Resolved` khi PR ready, `Reviewing` khi PR merge vào base | Service lo: `Resolved` sau khi bản build của nhánh version tới QA; gộp vào nhánh đợt không tính |
| Mỗi lần đổi trạng thái thì gán cho người chạy | Giữ người được gán |
| Không comment Jira nếu chưa được phép | Cho phép sẵn trong cấu hình project |
| Hỏi user: remote, máy, username, plan, câu spec | Lấy từ cấu hình project; câu spec → thread (sau này là quiz) |
| Khoá thiết bị riêng từng repo | `BUG_FIX_STATE_DIR` dùng chung |
| Cần agent `artemis-android`, không có trong harness lẫn `~/.claude/agents` | Viết agent này, dùng ARTEMIS MCP |
| Jira MCP | `comment`, `transition`, `attachments` mới thấy trong schema, **chưa thử ghi thật**; tải đính kèm chưa bật. Thử trên một ticket test rồi đọc lại. Chặn `jira_delete_issue` |
| Video chỉ có link ngoài thì thành `needs-info` | Giữ |
| PR của lane và của đợt | Luôn để draft: `pr-discord-notify.yml` của AAP864 báo Discord khi PR không phải draft |
| Worker ghi được Jira | MCP của worker chạy `READ_ONLY_MODE=true`; chỉ service có tool ghi, giới hạn bằng `ENABLED_TOOLS` |
| Harness là repo riêng | Ghim commit (hiện `b4f5855`), không sửa thẳng; phần chỉnh truyền qua brief/cấu hình, chỗ không truyền được thì PR vào harness |

## 8. Chỗ phải chỉnh `learn-app`
- `clear` chỉ công nhận `**PO trả lời` / `**PO chọn`: thêm "agent tự chốt" kèm nguồn; hỏi qua quiz thay `AskUserQuestion`.
- Sau cổng 1 không hỏi: giữ, nhưng quyết định nghiệp vụ tạm chọn phải đẩy lên quiz và thread.
- Mở PR sau cổng 3 (`handoff-commands.cjs`): đổi thành PR nháp + bản cài trước, duyệt sau. PR catalog vẫn chỉ mở sau duyệt.
- Không so UI bằng ảnh: thêm bước sau smoke. Cờ chạy headless ở mọi chỗ đang chờ terminal.

## 9. Project thử và thứ tự làm

**Project thử: AAP864 Phase 15 [C]** — Confluence pageId `332470208` (bản 25 lúc đọc), repo `AperoVN/AAP864_AILearn`, nhánh gốc
`develop`. Đây là một **spec tính năng**: tiêu chí đạt của bản đầu là PO gửi link này và nhận được quiz, spec đã làm rõ, PR
nháp và bản cài, dev không can thiệp giữa chừng.

Điều đã biết về project thử:
- Spec ghi `Customize-Learning-Path` "đề xuất, chưa build", nhưng module đã có trong Tera-Learn-SDK: `1.0.0-alpha02` phát hành
  2026-11-23 trên `develop`; `1.0.0-alpha03` (thêm host hook) ở nhánh `feat/clp-host-hooks`, chưa merge. Spec đòi `1.0.0`.
- Catalog kèm source clone cũ hơn catalog của SDK (thiếu feature này); bước 1 của plan là đồng bộ catalog.
- Spec cần team SDK thêm hook (vòng ôn câu sai, fallback AI).
- Phase 15 dùng hiệu ứng Phase 14; PR #272 (Phase 14) còn mở vào `develop`.
- Spec trống: LIB ad, LIB FO, version baseline, version.
- Spec mâu thuẫn: "Change path" vào khảo sát bước 2→4 (Luồng tổng) nhưng Màn chào lại ghi "vào từ … Change path".
- Jira AAP864: 17 bug mở, mới nhất 2026-10-22, chưa có bug Phase 15.

Thứ tự **[C: vòng bug trước; Đ: chia bước]**:
1. Thử nốt: ghi Jira thật trên một ticket test, tải đính kèm, worker `bug-fix` chạy headless trọn một bug.
2. Nền tối thiểu: service, SQLite, cấu hình project, rule, hàng đợi, khoá, worker, gửi tin Discord một chiều. Chưa có Channels, quiz, domain.
3. **Vòng bug trên AAP864**: bật tay (`dz bugs on AAP864 <version>`) → polling → `bug-fix` → cổng → nhánh version → build QA → Jira. PO và
   QA trả lời bằng comment trên ticket; Discord chỉ để ping.
4. Channels + tool `dz` + quiz.
5. Luồng spec trên AAP864 Phase 15 (khi PR #272 đã merge và SDK đủ hook).
6. App mới. 7. Phase 15 đạt 6 điều kiện release, rồi mở rộng project.

Điều kiện qua bước 3: 5 bug thật đi hết vòng tới `Resolved` và QA kiểm, không ai can thiệp ngoài QA test, PO trả lời và dev merge; chạy 48 giờ
liền, có ít nhất một lần khởi động lại máy giữa chừng mà không mất việc, không sửa trùng ticket.

Mỗi bước một plan riêng.

## 10. Để builder quyết **[T]**
Chia module trong `service/`, schema SQLite, framework web của quiz, cách dựng PDF, cách script gọi MCP, định dạng log.

## 11. Rule cho từng case

**Flow tự chạy; con người đưa ra rule cho từng case [C].** Danh sách case và số liệu dưới đây là **[Đ]**, người dùng sửa.

- Mỗi case một dòng có mã cố định trong `rules/default.yaml`; `rules/<KEY>.yaml` ghi đè số liệu theo project. Không có ngôn ngữ rule tự
  do: muốn case mới thì thêm mã và code kiểm. Hướng dẫn cần suy xét (phân loại bug, viết comment) là file `.md` agent đọc, không dùng để
  quyết định gộp hay vùng cấm.
- Service kiểm rule bằng code, Claude chỉ đưa dữ kiện có nguồn. Rule chỉ đổi qua PR; agent và Discord không ghi được file rule.
- Mỗi quyết định lưu mã case, phiên bản rule, bằng chứng.
- **Người im lặng thì ping, không làm thay [C cho PO; Đ cho QA, dev].** Việc đang chờ nhả chỗ cho việc khác, không giữ worker.
- "Giờ làm việc" = 9–18h, thứ 2–6. Ping gộp: mỗi người một tin mỗi nhịp, liệt kê mọi việc đang chờ.

### Nhận bug
| Mã | Case | Rule |
|---|---|---|
| B01 | Ticket `Request`/`To Do`/`Reopened`, đúng bản | Nhận, kể cả đã gán dev |
| B02 | `In Progress` hoặc `human-only` | Bỏ qua; dev nhả ra thì nhận lại |
| B03 | Crash hoặc `Highest` | Đợt riêng, chen trước việc chưa bắt đầu |
| B04 | `confirmed`, có trích dẫn spec/Figma | Sửa |
| B05 | `needs-confirm`, `spec-gap`, `conflict` | Hỏi PO, bug khác chạy tiếp; ping theo P01 |
| B06 | `needs-info` | Comment hỏi QA đúng thứ thiếu; ping theo P02 |
| B07 | `not-a-bug`, `duplicate`, `already-fixed`, `external` | Comment căn cứ, QA quyết; ping theo P02 |
| B08 | Ticket đã có kết luận, không có gì mới | Không nhận lại |
| B09 | Reopened lần 1–2 / lần 3 | Đợt mới / giao dev trực |

### Sửa và gộp
| Mã | Case | Rule |
|---|---|---|
| F01 | Kiểm hoặc review trượt | Sửa lại tối đa 2 vòng, rồi gác bug, ghi vào tóm tắt |
| F02 | Chạm vùng cấm | Không gộp phần đó; PR nháp riêng, ping dev trực |
| F03 | Đạt cổng | Service gộp vào nhánh version |
| F04 | Xung đột khi gộp, hoặc nhánh gốc có thay đổi mới | Kéo nhánh gốc vào, agent gỡ một lần, kiểm và review lại; vẫn xung đột thì sang đợt sau |
| F05 | Thiếu thiết bị để kiểm | Bug đó sang đợt sau, bug khác vẫn gộp |
| F06 | Dev comment hoặc yêu cầu sửa trên PR | Người có quyền ghi: coi như lỗi review, sửa rồi trả lời; người khác: chỉ ghi nhận |
| F07 | PR luôn mở > 400 dòng hoặc commit cũ nhất > 1 ngày làm việc | Ping dev merge mỗi ngày một lần |
| F08 | Dev squash | Mở nhánh version kế tiếp từ nhánh gốc |

**Cổng gộp:** build xanh, unit test đạt, reviewer độc lập `APPROVE`, đạt mức kiểm của bug, mở app không crash, không bí mật trong diff, không
chạm vùng cấm, đã kéo nhánh gốc. Thêm cho tính năng: PO duyệt bản cài **[C]** và E2E đạt **[C]**.

### Build và QA
| Mã | Case | Rule |
|---|---|---|
| Q01 | Gộp xong | Build trong 15 phút, gửi Firebase, comment Jira, `Resolved`, bật polling |
| Q02 | Build đỏ hoặc crash khi mở | Thử build lại một lần; vẫn hỏng thì revert lần gộp, không gửi QA |
| Q03 | 4 lần build hỏng liên tiếp | Dừng project, ping dev trực |
| Q04 | Gửi Firebase lỗi | Thử lại 3 lần; ticket chưa `Resolved` cho tới khi gửi được |
| Q05 | `Resolved` chưa ai kiểm | Ping QA theo P02; không đổi trạng thái hộ |
| Q06 | 24 giờ không có bug mới | Polling giãn 15 phút |

### Ping người
| Mã | Case | Rule |
|---|---|---|
| P01 | PO chưa trả lời quiz, câu hỏi, duyệt spec, thử bản cài, hoãn bug | **Ping Discord mỗi 4 giờ làm việc [C: ping]**; từ lần 3 ping thêm PO dự phòng trong cấu hình; tiếp tục mỗi ngày một lần. Không tự chọn |
| P02 | QA chưa trả lời hoặc chưa kiểm | Ping mỗi ngày làm việc |
| P03 | Dev chưa merge | Theo F07 |
| P04 | Người trả lời mơ hồ ("ok nhưng…") | Coi là góp ý, hỏi lại đúng điểm đó |

### Spec và code tính năng
| Mã | Case | Rule |
|---|---|---|
| S01 | Có bằng chứng, hoặc hợp lý và dễ sửa | Tự chốt, ghi nguồn **[C]** |
| S02 | Mâu thuẫn; tiền, quảng cáo, Premium, phần thưởng, xoá dữ liệu, dữ liệu mẫu chưa có bằng chứng | Hỏi qua quiz |
| S03 | Câu phát sinh khi code | Tạm chọn, code tiếp, thêm vào quiz, ping **[C]**; khó quay lại thì gác phần đó |
| S04 | Spec đổi sau khi duyệt | Tính lại phần bị ảnh hưởng, hỏi PO duyệt phần đổi; phần khác chạy tiếp |
| S05 | Smoke 2 vòng, so UI 3 vòng vẫn lệch | Gửi kèm danh sách lệch ở đầu tin |
| S06 | E2E còn lỗi sau 2 vòng | QA chọn sửa tiếp hoặc chấp nhận; ping theo P02 |

### Release
| Mã | Case | Rule |
|---|---|---|
| R01 | Đủ 2–6 / đủ 6 điều kiện | Ping dev merge / báo "release được" |
| R02 | Highest/High mới sau khi báo | Thu hồi lời báo, polling về 3 phút |
| R03 | Medium/Low mới sau khi đóng bản | Đưa PO danh sách hoãn; ping theo P01 |
| R04 | 3 bản build sau khi đóng mà chưa đủ | Báo PO và dev trực các điều kiện thiếu |
| R05 | PO xác nhận đã release hoặc huỷ | Tắt polling, đóng bản |

### Sự cố
| Mã | Case | Rule |
|---|---|---|
| X01 | Hạn mức tuần ≥ 80% / hết | Không nhận việc mới / dừng tới `resetsAt` |
| X02 | Worker không có tín hiệu 30 phút | Dừng, chạy tiếp session một lần, rồi gác |
| X03 | Lệnh ngoài danh sách | Từ chối, tìm cách khác, rồi gác |
| X04 | Máy hoặc service khởi động lại | Đối chiếu tiến trình, worktree, Jira, nhánh rồi chạy tiếp |
| X05 | Ổ đĩa < 15 GB | Dọn worktree và cache **của dev-zone**; vẫn thiếu thì không nhận việc mới |
| X06 | Jira, GitHub, Firebase lỗi | Giãn nhịp tới 15 phút; quá 30 phút báo Discord |
| X07 | Một project lỗi 3 lần liên tiếp | Dừng riêng project đó |
| X08 | Case chưa có rule | Chọn cách dễ quay lại, không có thì gác; ghi vào danh sách "thiếu rule" hằng tuần kèm rule đề xuất |

### Vùng cấm (project không nới được)
Giao dịch tiền thật, xoá hoặc chuyển đổi dữ liệu người dùng, chữ ký/khoá, quyền nhạy cảm, CI, file rule, merge vào nhánh gốc, force-push, xoá
ticket, lên store.

### Con người còn làm
Viết rule · gửi spec, trả lời và duyệt · QA test · dev merge · cấp tài khoản, khoá, thiết bị. Ngoài ra chỉ nhận một bản tóm tắt mỗi ngày.

### Giới hạn chấp nhận
- Vì không làm thay người: **luồng bug không đứng** (chỉ ticket cần hỏi phải chờ), **luồng spec đứng** khi PO không trả lời hoặc không duyệt.
- Gộp và build tự động dựa vào test và reviewer cùng họ model; QA là lớp kiểm độc lập duy nhất trước khi release.
- AAP864: `develop` được bảo vệ, 40/40 PR gần nhất có người khác duyệt, tài khoản `gh` không phải admin. Không thấy ruleset nào áp lên nhánh `dz/…`.

## 12. Phần còn lại: duyệt ở /ck:brainstorm 2026-11-25 **[C]**
- Cách A: quiz + luồng spec trước, Channels nối sau. Plan 04 quiz + spec, 05 code tính năng, 06 Channels, 07 app mới + release. Chạy khô mặc định.
- Quiz chỉ trên máy/mạng nội bộ, link có mã bí mật; domain và đăng nhập Discord để sau.
- Bot Discord: người dùng tạo, token lưu thẳng vào file.
- Bài thử: Phase 15 (Confluence 332470208) **dừng ở spec đã duyệt**; phần code chờ PR #272 và hook SDK.
- `learn-app` chạy theo **đoạn**, mỗi đoạn một `claude -p`, trạng thái ở `.learn-app/`: đoạn `ask` (spec → scout → ask), đoạn `clarify` (clear → update-spec, dừng ở cổng 1), đoạn `build` (planning → smoke → dừng ở cổng 3), đoạn `ship`. Service giữ mọi chỗ chờ người; worker không được gọi `AskUserQuestion`.
- Chỉ service ghi câu trả lời của PO và lệnh `approve`; worker không có quyền gọi `approve`.
- Chạy khô: `LEARN_APP_TRACKING=off`, không comment Confluence, không push, không PR.
