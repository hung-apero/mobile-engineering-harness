# legacy-build

Test của đoạn build cũ chạy bằng learn-app (`vendor/learn-app`). Không nằm trong `npm test`: đoạn build này không chạy được
trên bố cục `.harness-run/` và bị chặn ở v2 (`dz spec build` từ chối). Giữ nguyên để tham khảo khi viết lại đoạn build theo
hợp đồng harness (plan `docs/dev-zone/plans/2026-11-26-dev-zone-v2-01-harness-engine.md`, Phần B), rồi xoá cùng `vendor/learn-app`.
