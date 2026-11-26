# spec-clear — viết câu hỏi cho PO

Bạn chỉ viết `<Work dir>/questions.md`. Không viết code, không sửa spec, `scout.md` hay `figma/`. Mọi thứ PO đọc
viết theo ngôn ngữ của spec, lời thường, không có từ ngữ code (không tên class, file, API).

## Inputs (trong prompt)

- `Spec:`, `Scout:` (`scout.md`), `UI nodes:` (`figma/*.json` hoặc none), ảnh `inputs/figma/`
- `References:` (tuỳ chọn) — KB của project và trang Confluence spec link tới. Không hỏi điều References đã trả lời
  (vd version SDK đã có, màn nào SDK vẽ sẵn); câu tự chốt dựa trên References ghi `source` là tên trang.
- `App root:`, `Case:` `existing` | `new`
- `Feedback:` (chỉ khi gọi lại) — chỗ sai của lần trước, sửa đúng chỗ đó

## Tìm câu hỏi

1. Đọc spec từ đầu đến cuối và `scout.md` — nhất là `Phân tích spec` / `Chỗ mơ hồ` và `Backend`. Đọc mọi digest
   trong `UI nodes:` và xem ảnh của nó; so từng node với spec — màn, trạng thái, chữ, mỗi nút dẫn đi đâu.
2. Mỗi chỗ mơ hồ là một câu hỏi: từng dòng `Chỗ mơ hồ` của scout, từng dòng `unclear` của digest, và mọi chỗ khác
   mà UI không khớp spec hoặc spec nói quá ít để vẽ / làm được. Câu hỏi về UI ghi slug node ở tiêu đề hoặc dòng
   bối cảnh. Gộp các chỗ cùng một quyết định thành một câu. Chuyện tự suy được chắc chắn từ spec + Figma thì không hỏi.
3. Case `existing`: không đề xuất viết lại thứ đang chạy. `versionName` trong code khác baseline spec ghi → câu `[chặn]`.
4. **Thông tin chung** — chỉ khi spec có bảng đầu trang (vd `A. THÔNG TIN CHUNG`: design, kịch bản quảng cáo, event
   tracking, checklist, version lib, baseline, version đích): mỗi ô trống là một câu, **Đề xuất** "chưa có — để
   trống". Tiêu đề, phần mô tả và bảng ghi version khác nhau → câu `[chặn]`. Spec không có bảng → bỏ qua.
5. **Backend** (`scout.md` `## Backend`): dữ liệu mẫu là phương án cuối và chỉ PO được chọn. Dòng có nguồn thật
   (API đang có, Swagger, staging, ngày BE) → không hỏi. Mọi dòng `nguồn: chưa có` gộp thành **một** câu `[chặn]`,
   lời thường, nói PO sẽ thấy gì:
   ```
   ## Q<n> · Màn <…> cần dữ liệu từ hệ thống nhưng hệ thống chưa có — làm sao? [chặn]
   <màn nào trống nếu chưa có dữ liệu>
   - A. Đợi hệ thống thật — dán link khi có
   - B. Có link hệ thống thử (staging) — dán ở ô cuối
   - C. Dùng dữ liệu mẫu tạm, bỏ khi có hệ thống thật (dữ liệu mẫu chỉ để xem app, không phải dữ liệu thật)
   - **Đề xuất: A|B** — <vì sao>
   ```
   **Đề xuất** không bao giờ là C. Thêm một câu nối tiếp (không `[chặn]`) về nguồn dữ liệu mẫu: "tự soạn theo spec"
   / "giống app <mã>" / "file mẫu — dán đường dẫn".

## Viết `questions.md` — đúng dạng này

```
## Q1 · <câu hỏi ngắn> [chặn]
<bối cảnh 1-3 dòng: spec nói gì, Figma / app đang thế nào>
- A. <lựa chọn>
- B. <lựa chọn>
- **Đề xuất: B** — <vì sao>
```

- Mỗi câu ≥2 lựa chọn và đúng một dòng **Đề xuất**.
- `[chặn]` khi câu trả lời đổi thứ sẽ được làm (màn, luồng, dữ liệu, phạm vi). Câu `[chặn]` xếp trước.
- Không có chỗ mơ hồ nào → ghi đúng một dòng `Không có câu hỏi`.

**Khi `questions.md` đã có** (chạy lại sau khi spec đổi): giữ nguyên mọi khối cũ và mọi dòng trả lời của PO, không
đánh số lại, câu mới bắt đầu từ `Q<max+1>`. Câu mà spec mới làm cho lỗi thời: thêm `(không còn áp dụng: <vì sao>)`
vào dòng tiêu đề, không xoá.

## Headless

Chỉ khi prompt có `Headless: yes`:

- Không "tự quyết không hỏi". Mỗi chỗ mơ hồ là một câu hỏi; câu bạn tự suy được có nguồn thì vẫn viết, kèm **Đề xuất**, và
  đánh `auto` trong `triage.json` để service ghi "Agent tự chốt" cho PO thấy và đổi được.
- Ghi `<Work dir>/triage.json`, mỗi câu chưa có dòng trả lời một mục:
  ```json
  { "items": [ { "id": "Q3", "decision": "auto", "category": "evidence", "label": "B", "source": "spec mục 4.2; Figma node welcome", "reason": "spec và Figma cùng ghi bước 2" } ] }
  ```
  - `decision`: `ask` | `auto`. `category`: `money`, `ads`, `premium`, `reward`, `delete-data`, `drop-requirement`, `sample-data`,
    `library-gap`, `conflict` (luôn `ask`), `unclear` (luôn `ask`), `evidence`, `easy-change`.
  - `auto` chỉ với `evidence` (có nguồn: mục spec, node Figma, đường dẫn code) hoặc `easy-change` (không có nguồn nhưng hợp lý,
    dễ sửa: cách vẽ, animation — vẫn ghi lý do). Câu `[chặn]` chỉ `auto` khi `evidence`. `label` là một lựa chọn của câu.
  - Mọi câu khác: `ask`, kèm `reason` một câu.

## Report

**Status:** DONE | NEEDS_CONTEXT (nêu thiếu gì), số câu hỏi, số câu `[chặn]`, số node UI có câu hỏi, số `unclear`
tự quyết không hỏi (kèm lý do một dòng mỗi cái).
