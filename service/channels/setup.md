Cài bàn điều phối Discord (làm một lần, trên máy chạy service)

1. Cài công cụ
   brew install tmux
   curl -fsSL https://bun.sh/install | bash

2. Tạo bot
   - Mở https://discord.com/developers/applications > New Application, đặt tên.
   - Mục Installation: đặt Install Link là None. Sau đó mục Bot: tắt Public Bot.
   - Mục Bot > Privileged Gateway Intents: bật Message Content Intent. Không bật hai intent còn lại.
   - Mục OAuth2 > URL Generator: scope bot; chỉ chọn các quyền
     View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History.
     Không cấp Administrator, Mention Everyone, Manage Messages, Attach Files.
   - Mở link vừa tạo để thêm bot vào server. Trong Discord, chỉ cho bot xem đúng các kênh của project.

3. Cất token (không dán vào Discord, không ghi vào lịch sử lệnh)
   - Mục Bot > Reset Token, chép token rồi chạy:
   (umask 077; printf 'Dán token rồi Enter: '; read -rs T && printf '%s' "$T" > "{{DZ_HOME}}/secrets/discord-bot-token"; unset T; echo)
   chmod 600 "{{DZ_HOME}}/secrets/discord-bot-token"

4. Khai kênh cho project
   - Discord > User Settings > Advanced > bật Developer Mode; chuột phải vào kênh > Copy Channel ID.
   - Thêm vào {{DZ_HOME}}/projects/<KEY>.yaml (mã đặt trong nháy):
     channel: '<mã kênh>'
     roles: { po: '<mã role PO>' }        (không bắt buộc; bỏ trống thì dùng people.po, people.poBackup)
   - Chỉ người có trong people (po, poBackup, qa, devOnCall) nhắn được cho bàn điều phối.

5. Đăng nhập và cài plugin (chỉ bật cho thư mục desk, worker không nạp)
   cd "{{DZ_HOME}}/desk"
   export CLAUDE_CONFIG_DIR="{{DZ_HOME}}/claude"
   claude auth login
   claude plugin marketplace add anthropics/claude-plugins-official
   claude plugin install discord@claude-plugins-official --scope project

6. Tin thư mục desk (một lần, không kèm --channels)
   claude --setting-sources project --strict-mcp-config
   Đồng ý hộp hỏi tin thư mục, rồi gõ /exit.
   Gói Team hoặc Enterprise: Owner phải bật Channels ở claude.ai > Organization settings > Claude Code > Channels.

7. Kiểm và chạy
   unset CLAUDE_CONFIG_DIR
   dz doctor
   dz desk start
   dz desk status
   Xem phiên: tmux -L dz-desk attach -t dz-desk (thoát bằng Ctrl-b rồi d, không bấm Ctrl-C).

Ghi chú
   - Không chạy /discord:configure và /discord:access: cấu hình do service sinh, lần mở phiên sau sẽ ghi đè.
   - Project chạy khô (live: false): bot chỉ đọc, không gửi tin. Discord vẫn hiện "đang nhập" khi phiên nhận tin.
   - Đổi token: làm lại bước 3 rồi dz desk stop, dz desk start.
