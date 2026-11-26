# dev-zone service

Dịch vụ Node chạy 24/7 trên Mac mini: nhận việc, giao cho worker Claude, theo dõi, báo Discord. Chỉ dùng built-in của Node >= 24 và `yaml`.

## Vận hành nhanh

1. Cài: làm theo mục "Cài" bên dưới, rồi `dz doctor` cho tới khi không còn dòng THIẾU. Đăng nhập Claude riêng và `gh auth login`.
2. Bật một project: đặt `~/.dev-zone/projects/<KEY>.yaml` với `enabled: true`, `live: false` (chạy khô: chỉ ghi `would`, không gửi gì ra ngoài). Chạy thử vài ngày rồi làm theo "Từ chạy khô sang live".
3. Gửi spec: `dz spec <link Confluence> --project <KEY>`, hoặc mở `dz web` rồi bấm "Gửi spec mới", hoặc nhắn vào kênh Discord của project (cần bàn điều phối, xem bước 6).
4. Quiz: PO nhận link ở Discord (tối đa 90 ngày), chọn đáp án rồi bấm nộp; hỏi thêm ngay trên trang. Spec viết lại xong, PO nhận link duyệt và duyệt đúng bản đó. Muốn bắt đầu code: `dz spec build <id> --version <v>`.
5. Bug: `dz bugs on <KEY> <version>` rồi để dịch vụ quét Jira. Xem bản ở `/release/<KEY>/<version>` trên trang web: 6 điều kiện, bug Medium/Low có thể hoãn (ghi tên người hoãn). Xong bản: `dz release done <KEY> <version>` (hoặc `cancel`); E2E của QA: `dz release e2e <KEY> <version> accept|continue --by <tên>`. E2E cần `~/.dev-zone/android-test-harness`, `maestro` trong PATH và `~/.dev-zone/e2e/<KEY>.json` (`dz doctor` báo thiếu).
6. Bot Discord: `dz desk setup` in từng bước (tạo bot, Message Content Intent, cất token vào `secrets/discord-bot-token`, khai `channel` trong project, đăng nhập và cài plugin). Xong thì `dz doctor`, `dz desk start`, xem bằng `dz desk status`; tắt bằng `dz desk stop`. Chỉ người khai trong `people` của project nhắn được cho bàn điều phối.
7. App mới: `dz newapp start <KEY> --name … --package … --application-id … --repo owner/tên --firebase-project … --tester-group … --jira-project … --discord-channel … --po … --qa … --dev …` in danh sách dev cần cung cấp; hoặc mở `/app/new` trên trang web để điền giá trị và bấm kiểm. File bí mật (`google-services.json`, keystore…) chép tay vào `~/.dev-zone/secrets/newapp/<KEY>/` quyền 600, trang web không nhận chúng. `dz newapp check <KEY>` tới khi đủ mục bắt buộc, rồi `dz newapp create <KEY>` ghi `projects/<KEY>.yaml` với `enabled: false`; dev tự bật sau khi xem lại. Cần `~/.dev-zone/harness` là bản checkout của harness (commit ghim lấy từ đó).

## Cài

Chạy dịch vụ từ một bản checkout riêng, không chạy từ bản đang dev và không đặt trong `~/Desktop`, `~/Documents`, `~/Downloads` (macOS chặn launchd đọc các thư mục này):

```
git clone <url repo này> ~/.dev-zone/app
cd ~/.dev-zone/app/service && npm install
node bin/dz.cjs doctor
node bin/dz.cjs install
```

`install` từ chối nếu mã nằm trong các thư mục trên (`doctor` chỉ cảnh báo); vẫn muốn cài thì thêm `--allow-protected`.

Cập nhật là việc chủ động: `git pull` và `npm install` trong `~/.dev-zone/app`, xem thay đổi, rồi khởi động lại dịch vụ. Sửa code ở bản dev không ảnh hưởng dịch vụ đang chạy.

```
launchctl kickstart -k gui/$(id -u)/com.devzone.service
```

`install` tạo `~/.dev-zone` (quyền 700), ghi `~/Library/LaunchAgents/com.devzone.service.plist` (quyền 600) rồi in lệnh `launchctl bootout ...` và `launchctl bootstrap ...`. Bạn tự chạy lần lượt: lệnh đầu gỡ bản đang nạp (lần cài đầu nó báo lỗi, bỏ qua), lệnh sau nạp bản mới; nếu lệnh sau báo lỗi vì bản cũ chưa dừng hẳn thì chờ vài giây rồi chạy lại. `DZ_HOME` tương đối được đổi thành tuyệt đối. Plist dùng đúng `node` đang chạy lệnh `install`, đường dẫn tuyệt đối của `claude`, `adb`, `gh`, `uvx`, `git`, cùng `JAVA_HOME`, `ANDROID_HOME`, `LANG` tại lúc cài, không chép biến môi trường nào khác (không có token hay webhook). Nếu đổi vị trí các công cụ này thì chạy lại `install`.

Chạy lại `install` sẽ ghi đè plist cũ do dz tạo; file plist không do dz tạo thì dz từ chối ghi đè.

launchd agent chỉ chạy sau khi đăng nhập. Sau khi khởi động lại máy, cần bật tự đăng nhập (System Settings > Users & Groups > Automatic login) hoặc đăng nhập tay. Bước người dùng tự làm để máy không ngủ và tự bật lại sau mất điện:

```
sudo pmset -a autorestart 1 sleep 0
```

Dịch vụ chạy dưới `caffeinate -i` nên không ngủ khi đang chạy.

## Chạy v2 song song

v2 là bản fork `~/Desktop/src/dev-zone` (nhánh `dev-zone`), dùng harness làm engine cho spec và bug. v1 ở `~/.dev-zone` giữ nguyên, không đụng.

- Thư mục và cổng riêng: `export DZ_HOME=~/.dev-zone-v2 DZ_WEB_PORT=8788`.
- Harness ghim: `git clone ~/Desktop/src/dev-zone $DZ_HOME/harness` rồi `git -C $DZ_HOME/harness checkout <harnessCommit>`; `harnessCommit` trong `$DZ_HOME/projects/<KEY>.yaml` phải trùng commit này.
- Overlay không cần làm tay. Bản clone spec dùng `.harness-overlay/overlay.yaml` repo app đã commit; không có thì dùng `$DZ_HOME/projects/<KEY>.overlay.yaml`; không có nữa thì service tự tạo bằng script `harness-init` (thương hiệu lấy từ hàm `<Tên>Theme(` duy nhất trong code), lưu vào `$DZ_HOME/projects/<KEY>.overlay.yaml` và mở chờ dev xem lại. Code có 0 hoặc nhiều hàm `*Theme(` thì spec chờ dev tự đặt file đó. `upstream` luôn trỏ vào harness ghim.
- Bài thử: `live: false`, `discord: true` — Discord chạy thật, Jira, git push, gh, Firebase, Confluence vẫn khô.
- Chạy bằng `cd service && node bin/dz.cjs run` trong terminal; không `dz install`, không launchd.
- Worker không nhận biến nào của shell có tên dạng token, key, secret, password (vd `GITHUB_PERSONAL_ACCESS_TOKEN`, `FIGMA_API_KEY`). Khoá Figma phải nằm trong `secrets/figma-read.json` (khối `env` của server), không dựa vào biến shell.
- Bot Discord chỉ một phiên nhận tin: tắt bàn điều phối của v1 (`DZ_HOME=~/.dev-zone node bin/dz.cjs desk stop` từ mã v1) trước khi `desk start` ở v2.
- `dz doctor` ở v2 kiểm thêm `python3` ≥ 3.9 và harness ghim có `skills/feature/scripts/headless_check.py`, `skills/spec-clear/SKILL.md`, `overlay.schema.yaml`, các script của `skills/harness-init/scripts/`.
- `dz spec build` bị chặn ở v2 tới khi có đoạn build mới; spec không cần nữa thì `dz spec cancel <id>`.

## Gỡ

```
launchctl bootout gui/$(id -u)/com.devzone.service
node bin/dz.cjs uninstall
```

`uninstall` chỉ xoá đúng plist do dz tạo. `~/.dev-zone` (DB, log, bí mật) được giữ nguyên, muốn bỏ thì xoá tay.

## Đặt bí mật

Mọi bí mật nằm trong `~/.dev-zone/secrets/` (thư mục quyền 700, file quyền 600), không bao giờ vào DB, log hay git. Ví dụ webhook Discord của project `ABC1`:

```
install -m 600 /dev/null ~/.dev-zone/secrets/ABC1.discord-webhook
pbpaste > ~/.dev-zone/secrets/ABC1.discord-webhook
```

`dz doctor` kiểm quyền của thư mục và file.

## Cấu hình project

Mỗi project một file `~/.dev-zone/projects/<KEY>.yaml`. Mẫu: `projects/example.yaml.sample`. KEY viết hoa, ví dụ `ABC1`. File lỗi bị bỏ qua và báo trong `dz status`.

`knowledge` (tuỳ chọn, tối đa 10 link Confluence): trang KB của project, ví dụ catalog feature của SDK. Mỗi spec, service đọc các trang này cùng các trang Confluence mà spec link tới (cùng host, tối đa 10, một cấp) vào `.harness-run/inputs/kb/` và `inputs/linked/` cho worker đọc như một phần của spec. Trang không đọc được không chặn spec, chỉ được ghi lại.

## Lệnh dz

| Lệnh | Việc |
|---|---|
| `dz run` | chạy dịch vụ (launchd gọi lệnh này) |
| `dz status` | tình trạng dịch vụ, project, việc, quota |
| `dz probe <KEY>` | thêm một việc thử cho project |
| `dz retry <job>` | đưa việc đang gác hoặc đã lỗi về hàng đợi với phiên mới; bị từ chối nếu có việc khác cùng khoá đang mở hoặc đợt bug của việc đó đã kết thúc |
| `dz pause <KEY>` / `dz resume <KEY>` | tạm dừng / chạy tiếp một project; `resume` cũng xoá bộ đếm build hỏng liên tiếp |
| `dz waits [KEY]` / `dz done <waitId>` | xem các việc đang chờ người / đóng tay một việc chờ; dịch vụ tự đóng khi ticket đã Resolved hoặc đã đóng, hoặc rời trạng thái lúc mở việc chờ (chuyển sang In Progress thì không đóng); khi nhánh gốc đã chứa bản ("Merge PR"); khi không còn ticket nào service đã giao của bản ở Resolved ("Kiểm bản cài"; ticket Jira không cho đọc thì không tự đóng) |
| `dz bugs on <KEY> <version> [--only KEY-1,KEY-2] [--base YYYY-MM-DD] [--fix-version A,B]` | bật theo dõi bug của một bản; `--fix-version` thêm tên version Jira cùng thuộc bản này (chỉ dùng tên có trên Jira); không có `--base` thì mốc là lúc bật; `--only` giới hạn vào vài ticket, `--base` đặt mốc tính bug (đầu ngày, giờ Việt Nam); bật lại không kèm `--only` thì bỏ giới hạn |
| `dz bugs off <KEY> <version>` | tắt theo dõi; đợt đang chạy vẫn đi tiếp |
| `dz bugs status [KEY]` | polling, đợt đang chạy, số ticket theo trạng thái, kết quả chấm release gần nhất |
| `dz bugs poll <KEY>` | quét Jira đúng một lần cho mọi bản đang mở, bất kể lịch |
| `dz bugs reset-dry <KEY> <version>` | dọn dấu vết chạy khô của một bản (chỉ khi project chưa live và không còn đợt mở) trước khi bật live, xem "Từ chạy khô sang live" |
| `dz batch park <id>` | yêu cầu gác một đợt; dịch vụ thực hiện ở nhịp tiếp theo, CLI không đụng tới tiến trình |
| `dz batch <id>` | xem một đợt: pha, ticket, các quyết định ghi tên đợt |
| `dz spec <link\|pageId\|file.md> --project KEY [--figma URL\|none]` | gửi một spec; `none` là spec không có design |
| `dz spec list [KEY]` / `dz spec show <id>` | xem các spec / một spec |
| `dz spec link <id>` | tạo link mới cho PO (quiz hoặc duyệt), hết hạn sau 90 ngày |
| `dz spec refresh <id>` | đọc lại nguồn; đổi thì làm lại trong bản clone mới kèm câu trả lời cũ, lời duyệt cũ hết hiệu lực; spec đang code thì chỉ phần đổi phải duyệt lại |
| `dz spec build <id> --version <v>` | bắt đầu code spec đã duyệt cho bản `<v>`; không chạy lệnh này thì spec ở nguyên `approved` |
| `dz spec prereq <id> [--pr [owner/repo#]N] [--branch owner/repo:nhánh] [--clear]` | đặt điều kiện trước (PR đã merge, nhánh đã có); không cờ thì xem điều kiện và gợi ý đọc từ spec (gợi ý không tự áp dụng) |
| `dz spec retry <id> [--figma URL\|none]` | chạy lại spec đang gác hoặc cần bổ sung |
| `dz spec cancel <id>` | huỷ spec: đóng mọi chờ, gác việc đang chạy của spec, máy bỏ qua spec này (mã `OP01`); gọi lại không ghi thêm |
| `dz release status <KEY> <version>` | 6 điều kiện release, đóng bản, E2E, bug đã hoãn |
| `dz release defer <KEY> <version> <TICKET…> --by <tên>` | hoãn bug Medium/Low đang mở của bản khỏi điều kiện 4 |
| `dz release e2e <KEY> <version> accept\|continue --by <tên>` | QA chấp nhận kết quả E2E trên cây hiện tại / để sửa tiếp |
| `dz release done\|cancel <KEY> <version>` | ghi nhận release / huỷ bản: tắt theo dõi bug, đóng việc chờ |
| `dz newapp start\|status\|check\|create <KEY> [cờ…]` | danh sách và kiểm điều kiện app mới, rồi sinh file project (`enabled: false`) |
| `dz desk start\|stop\|status\|setup` | bàn điều phối Discord: bật, tắt, xem, in hướng dẫn cài |
| `dz web` | in link trang trạng thái cho người vận hành (mã đổi mỗi lần dịch vụ khởi động) |
| `dz doctor` | kiểm môi trường |
| `dz install [--shared-login] [--allow-protected]` / `dz uninstall` | ghi / xoá plist |

Chỉ một `dz run` chạy một lúc; lần thứ hai thoát với lỗi nêu pid đang chạy. Dừng dịch vụ (SIGTERM) không giết worker, lần chạy sau nhận lại worker đó.

## Đọc log

- `~/.dev-zone/logs/service.jsonl`: nhật ký dịch vụ, mỗi dòng một JSON (`jq . ~/.dev-zone/logs/service.jsonl`).
- `~/.dev-zone/logs/<job>-<lần>-<8 ký tự đầu của phiên>.jsonl`: luồng stream-json của từng worker. Log quá 30 ngày của việc đã xong hoặc lỗi được dọn mỗi ngày một lần. Log này là bản thô, không che bí mật.
- `~/.dev-zone/logs/batches/<KEY>-<đợt>/`: log và kết quả các bước cổng, build của từng đợt bug, giữ 30 ngày.
- `~/.dev-zone/logs/launchd.out.log`, `launchd.err.log`: stdout/stderr do launchd bắt, dùng khi dịch vụ chết ngay lúc khởi động.

## Sửa rule

Rule mặc định ở `service/rules/default.yaml` (slot, nhịp nhắc người, ngưỡng đĩa, ngưỡng quota...). Dịch vụ đọc lại file ở mỗi nhịp (10 giây), không cần khởi động lại; file sai thì bản đúng gần nhất được giữ và `dz status` báo lỗi. Giờ làm việc (9–18h, thứ Hai đến thứ Sáu, giờ Việt Nam) nằm trong code, không sửa được bằng rule. Việc chờ PO (quiz, duyệt, thử bản cài) được báo ngay khi mở, kể cả ngoài giờ, kèm link và tag PO; các lần nhắc sau theo `P01` và giờ làm việc. Chờ của QA và dev chỉ nhắc trong giờ làm việc.

Mỗi quyết định ghi kèm số phiên bản rule. Dùng `DZ_RULES_DIR` để trỏ sang thư mục rule khác.

## Đăng nhập Claude riêng

Worker dùng `CLAUDE_CONFIG_DIR=~/.dev-zone/claude`, tách khỏi tài khoản cá nhân. Đăng nhập một lần:

```
CLAUDE_CONFIG_DIR=~/.dev-zone/claude claude auth login
```

Worker không nhận token từ biến môi trường: mọi biến `CLAUDE_CODE_*` (kể cả `CLAUDE_CODE_OAUTH_TOKEN`), `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` đều bị bỏ. Claude phải đăng nhập như trên, `gh` phải đăng nhập bằng `gh auth login`.

Khi chưa có đăng nhập riêng, cài với `dz install --shared-login`: plist đặt `DZ_CLAUDE_CONFIG=shared` và worker dùng cấu hình Claude dùng chung của máy. Có đăng nhập riêng rồi thì chạy lại `dz install` không kèm cờ này.

## Sandbox của worker

Mọi worker (Claude, gate, build) chạy qua `/usr/bin/sandbox-exec` với profile riêng ở `$DZ_HOME/runs/<job>/profile.sb`, xoá khi việc kết thúc.

- Không đọc, ghi được: `secrets`, `dz.db*`, `service.lock`, `*.sock`, `desk`, `logs`, `runs` của việc khác; `~/.ssh`, `~/.config/gh`, `~/.netrc`, `~/.git-credentials`, `~/.aws`; `~/.claude*` khi dùng đăng nhập riêng.
- Trong `$DZ_HOME` chỉ ghi được clone và worktree của việc, `bug-fix-state`, thư mục Claude (trừ settings, plugin, hook). Worker bug ghi được `objects` và `refs/heads/fix` của mirror.
- Không nối được cổng web và socket desk; không gửi tín hiệu tới tiến trình ngoài sandbox; không dùng được launchd, `open`, Apple Events, tmux, ssh-agent.
- Gradle và Kotlin daemon riêng cho từng việc, không dùng chung daemon của người.
- Gate và build không dùng được keychain. Worker Claude vẫn dùng được vì Claude Code trên macOS lưu đăng nhập trong keychain (`Claude Code-credentials`, hoặc kèm hậu tố băm khi có `CLAUDE_CONFIG_DIR`); chặn keychain thì Claude báo chưa đăng nhập.

Rủi ro còn lại: worker Claude đọc được token Figma hoặc Jira chỉ đọc của chính việc đó (bản sao cấu hình MCP, quyền 600, MCP server chạy trong cùng sandbox) và các mục keychain mà lệnh `security` đọc được. Token `gh` trong keychain thuộc loại này: chạy `gh auth login --insecure-storage` để token nằm ở `~/.config/gh` (sandbox chặn đọc). `~/.gradle/gradle.properties` vẫn đọc được vì Gradle cần.

Thiếu `sandbox-exec`: `doctor` báo THIẾU, project live không mở việc, dev được ping. `DZ_SANDBOX=off` tắt sandbox, chỉ dùng khi người vận hành chủ động chọn; `dz status` và `doctor` hiện rõ.

## Giới hạn đã biết

- launchd agent chỉ chạy sau đăng nhập; không có tự đăng nhập thì sau khởi động lại dịch vụ chờ đến khi có người đăng nhập.
- `dz install` không nạp launchd và không chạy `pmset`; cả hai là việc của người dùng.
- Plist cố định đường dẫn công cụ lúc cài; đổi `node`, `claude`, `adb` thì chạy lại `install`. Với node của Homebrew, đường dẫn có số phiên bản nên nâng cấp node xong phải chạy lại `install`.
- Test live (`DZ_LIVE=1 npm test`) gọi claude thật (haiku) và mất khoảng 2 phút; test thường không gọi mạng.
- Chưa có nghiệm thu khởi động lại máy tự động; làm tay theo kế hoạch.

## Bug

Mỗi nhịp, bước bug chạy nền (không chặn giám sát worker): quét Jira khi tới hạn (3 phút, 15 phút sau 24 giờ không có bug mới), rồi đẩy mỗi đợt đang mở một pha (tối đa 5 pha mỗi nhịp). Project tạm dừng không quét và không lập đợt mới nhưng đợt đang chạy vẫn được đẩy; project dừng vì X07 (chỉ đếm việc probe, bug, feature, review) thì bước bug bỏ qua. Jira lỗi: giãn nhịp 3, 6, 12, 15 phút, quá 30 phút mở việc chờ dev (X06). Sau mỗi lần giao bản và tối đa 15 phút một lần, `release.cjs` chấm 6 điều kiện của bản (điều kiện 6 là "chưa có" tới khi có E2E) và ghi R01, R02.

`live: false` (mặc định) là chạy khô: Jira ghi, `git push`, `gh`, Firebase và Discord chỉ ghi dòng `would` (sổ quyết định; Discord ghi vào log dịch vụ một lần mỗi ngày làm việc mỗi project). Cần `~/.dev-zone/secrets/jira-mcp.json` (quyền 600); `dz doctor` kiểm file này, `jira-read.json` và commit ghim của harness mà không in giá trị.

### Từ chạy khô sang live

Đợt live đầu tiên bị từ chối khi bản còn dấu vết chạy khô; trong lúc đó các việc chờ mở lúc chạy khô không bị nhắc. Làm đúng thứ tự:

1. `dz pause <KEY>`
2. sửa project thành `live: false`
3. `dz batch park <id>` cho từng đợt còn mở (`dz bugs status <KEY>` liệt kê), chờ tới khi không còn đợt nào
4. `dz bugs reset-dry <KEY> <version>` (chỉ xoá ticket của đúng bản đó)
5. sửa project thành `live: true`
6. `dz resume <KEY>`

## Spec

`new → reading → asking → quiz → clarifying → review → approved`, rẽ sang `needs-input` (thiếu thông tin) hoặc `parked` (worker dừng giữa chừng hai lần). Mỗi nhịp, bước spec chạy nền: đọc nguồn (`secrets/confluence-read.json`), tạo bản clone riêng ở `workspaces/<KEY>/specs/<id>/repo`, chạy `learn-app` không người từng đoạn (`ask`, `clarify`) bằng việc loại `spec` (một suất code như `feature`). Dịch vụ chỉ tin file trong `.learn-app`, không tin lời worker. Câu hỏi thêm của PO là việc loại `explain`: chỉ đọc, có một suất riêng ngoài suất code, tối đa 20 lần mỗi câu.

- Chỉ dịch vụ ghi câu trả lời vào `questions.md`. Trước khi viết lại và trước khi duyệt, các dòng trả lời được so với DB; lệch thì ghi lại từ DB, ghi quyết định `spec-answers-restored` và viết lại spec trước khi cho duyệt.
- Câu về tiền, quảng cáo, Premium, phần thưởng, xoá dữ liệu, bỏ yêu cầu, dữ liệu mẫu, thư viện không làm được, nguồn mâu thuẫn luôn hỏi PO.
- Duyệt gắn với sha256 của bản spec cao nhất; bản đổi thì PO phải duyệt lại.
- Spec có link Figma cần `secrets/figma-read.json` (đúng một server `framelink-figma`, quyền 600).
- `live: false`: không comment Confluence, không Discord, không push. Comment Confluence khi live cần token được phép comment trong `confluence-read.json`.
- `.learn-app` của bản clone nằm trong commit duyệt cổng 1 và không được đẩy đi đâu: commit gửi đi được dựng lại từ cây đã bỏ `.learn-app`, và cửa kiểm diff cấm mọi đường dẫn `.learn-app`.

### Code tính năng

`approved → waiting-prereq → building → (provisional) → smoking → uidiff → reviewing → candidate → po-trial → landing → done`. Chạy khô thì kết thúc ở `landed-dry`; `dz bugs reset-dry` đưa spec đó về `po-trial`. `needs-input` và `parked` rẽ ra từ mọi bước; `dz spec retry` quay lại đúng bước đó. `dz spec cancel` đưa spec về `cancelled` từ bất kỳ bước nào, không quay lại được.

- Điều kiện trước kiểm bằng `gh` chỉ đọc, 15 phút một lần; chưa đủ thì mở việc chờ dev.
- Worker code chạy `learn-app` tới hết gộp plan, `LEARN_APP_PARALLEL` bằng số suất được cấp, không có adb, không push. Đĩa còn dưới 40 GB thì chỉ xin một suất. Worker chết giữa plan thì lượt sau làm tiếp trong đúng worktree của plan đó.
- Quyết định chưa có trong spec thì tạm chọn và gửi PO xác nhận ở link câu hỏi; quyết định đụng tiền thật hay xoá dữ liệu người dùng thì plan đó chờ PO.
- Chạy thử cần một thiết bị được khoá cho spec (`spec:<id>:run`). Không có thiết bị thì chờ, báo dev (F05) và không gửi bản cài. Lỗi nặng thì gác; lỗi nhỏ còn lại và lệch giao diện sau 3 vòng được ghi ở đầu trang thử và đầu PR (S05).
- Review độc lập chỉ đọc, tối đa 2 vòng sửa. Chạm vùng cấm hoặc lộ bí mật thì gác ngay (F02).
- Candidate là một commit trên nhánh `dz/feature-<KEY>-<id>` với PR nháp vào nhánh gốc. PO duyệt đúng commit đó trên trang thử; có commit mới thì lời duyệt cũ hết hiệu lực.
- Gộp vào `dz/release-<bản>` dùng chung khoá gộp với đợt bug; mỗi lúc một đợt, có cổng và build lại trước khi đẩy. Xung đột thì trả về code một lần, lần sau gác.
- Spec gốc đổi lúc đang code (S04): PO duyệt phần đổi, chỉ plan liên quan làm lại, phần khác chạy tiếp; chưa duyệt thì chưa gửi bản cài.
- Project chưa `live`: không push, không PR, không gửi bản cài; các việc đó ghi thành quyết định `would`. Bật `live` khi đang chờ PO thử thì gửi lại thật và hỏi PO lại.
- `discord: true` (mặc định `false`) bật riêng phần Discord khi project chưa `live`: bot trả lời thật, ping qua webhook, kênh được phép trả lời. Jira, git push, gh, Firebase, Confluence vẫn theo `live`.

## Trang web

Trang người vận hành (cần cookie từ `dz web`): trạng thái `/`, gửi spec `/spec/new`, bản `/release/<KEY>/<version>` (kết quả đã lưu; `?fresh=1` hỏi lại Jira và git), app mới `/app/new`.

`dz run` mở trang ở `127.0.0.1:8787`; `DZ_WEB_HOST`, `DZ_WEB_PORT` đổi địa chỉ (đặt trước khi chạy `dz install`, link trong mạng nội bộ không mã hoá). Không mở được cổng thì dịch vụ vẫn chạy, xem `web-error` trong log và dòng `Web` của `dz status`.
