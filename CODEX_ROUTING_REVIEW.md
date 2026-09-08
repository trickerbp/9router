# Codex routing, quota và ngữ cảnh — 2026-09-08

Đối chiếu local `db4cc34c` với `decolua/9router` tại `eb712ca8`, sau đó sửa trên working tree local. Không thay đổi các sửa có sẵn ở `cli/cli.js`, `scripts/translate-readme.js`, `start.sh`.

## Cơ chế phù hợp

Giữ **fill-first theo priority, kèm giữ account theo session**. Một request gọi một account; chỉ thử account kế tiếp khi gặp lỗi phù hợp. Câu trả lời là stream/response của lần được chọn, không chia câu hỏi cho nhiều account rồi ghép câu trả lời. Nhiều agent vẫn có thể cùng gọi account đầu tiên đồng thời.

| Vấn đề | Upstream / local trước sửa | Bản sửa |
| --- | --- | --- |
| Chọn account | Upstream cho cấu hình fill-first hoặc round-robin; local ép fill-first cho Codex/OpenAI | Giữ fill-first, ưu tiên account đã gắn với session còn khả dụng |
| Account đầu hồi quota | Phiên có thể quay lại account đầu | Phiên tiếp tục dùng account thay thế; phiên mới dùng account ưu tiên |
| Input GPT-5.6 | Bộ chuẩn hóa riêng của local bỏ compaction, phase, ảnh/tệp, namespace | Giữ những dữ liệu này và output tool đa phương thức |
| Retry | Clone nông và nhiều tầng retry | Clone sâu từng attempt; giới hạn tổng lượt gọi |
| `/responses/compact` | JSON có thể đi nhầm qua SSE | Gửi/nhận JSON đúng endpoint, trả nguyên canonical output, ghi usage |
| Quota relay | Có thể bỏ sót lỗi trong HTTP 200 JSON/SSE | Đọc structured error trước output; không dò chữ quota trong câu trả lời model |
| Cooldown | Reset dài bị cắt còn 30 phút, 402 thử lại quá sớm | Tôn trọng reset/Retry-After; phân biệt lỗi cả account và lỗi model |
| Schema/context/hủy | Có thể thử hết pool dù đổi account không giải quyết được | Trả lỗi hoặc dừng ngay; không khóa account vì client hủy |
| Stream dở | Có thể ghi thành công trước terminal | Chỉ xác nhận thành công khi có completed terminal; không phát lại sau khi đã bắt đầu trả output/tool |

Session affinity dùng ID hội thoại rõ ràng (`session_id`, `session-id`, `x-session-id`, hoặc ID/cache key trong body), phân vùng theo client API key/provider/model. `x-client-request-id` không còn được dùng làm session vì nó thay đổi theo mỗi request. Affinity ở RAM, tối đa 5.000 entry, hết hạn sau 2 giờ không dùng; không lưu lịch sử hội thoại và không chia sẻ giữa các process.

Ngân sách Responses hiện đặt trong `open-sse/config/responsesRouting.js`: tối đa 8 lần gọi model upstream cho cả chuỗi, deadline 10 phút; BaseExecutor thử lại tối đa 1 lần cho một URL/account. Quota cạn không có reset dùng cooldown 1 giờ; rate limit ngắn vẫn theo backoff/Retry-After. Không thêm hàng đợi giới hạn concurrency per-account trong bản sửa này.

## API key + Base URL → OAuth có giữ ngữ cảnh không?

**Router giữ các dữ liệu lịch sử được gửi lên, nhưng không thể bảo đảm mọi Base URL hiểu cùng một loại ngữ cảnh.** Client phải gửi đủ instructions, lịch sử, tool call/output, ảnh/tệp và toàn bộ output compact. Cache key chỉ hỗ trợ cache, không thay thế lịch sử.

Nếu thêm key + Base URL ngay dưới **provider Codex**, relay và OAuth cùng pool; priority quyết định thứ tự. Khi relay hết credit/quota, router thử OAuth khả dụng tiếp theo với cùng model và một bản sao độc lập của request. Nếu tạo **provider OpenAI-compatible riêng**, hết quota chỉ chuyển giữa các connection trong provider đó; chuyển sang Codex OAuth cần combo/routing tương ứng.

Những thay đổi chủ động để tránh mất ngữ cảnh âm thầm:

- Request chỉ có `previous_response_id`, `conversation` hoặc `item_reference` bị từ chối bằng 400 `continuity_not_supported`; router không tự tái dựng được lịch sử lưu riêng ở upstream.
- Không chuyển opaque compaction/reasoning, phase, namespace hoặc native tool state sang Chat Completions khi không biểu diễn đầy đủ được.
- Khi bên nhận từ chối encrypted content/tài nguyên không tương thích, trả lỗi; không xóa blob rồi trả một câu trả lời thiếu lịch sử.
- Relay trả JSON hoàn chỉnh dù client yêu cầu SSE được chuyển thành Responses events, giữ toàn bộ terminal output, call IDs, phase và usage. HTML hoặc sai hợp đồng được báo lỗi.
- Sau khi output hoặc tool action bắt đầu được trả, không tự gọi lại request ở account khác. Lỗi giữa stream được ghi nhận để account có thể được bỏ qua ở lượt tiếp theo.

Không có bảo đảm cache hit khi đổi account/host. Cùng tên model cũng không chứng minh relay thật sự dùng cùng model. Các tài nguyên như `file_id` hoặc blob mã hóa có thể chỉ hợp lệ tại host/account tạo ra chúng; không có adapter chuyển các tài nguyên đó trong bản sửa.

## GPT mới

Kiểm thử payload/fallback cho GPT-5.5, GPT-5.6 Sol/Terra/Luna và GPT-6 Astra. Riêng Astra, theo OpenAI Docs:

- Mức reasoning: `low`, `medium`, `high`, `xhigh`, `max`; chuẩn hóa `none`/`minimal` thành `low`, giữ các mức hợp lệ.
- Tool calling cần Responses. Request tool gửi tới Chat Completions được từ chối trước khi tốn một lượt gọi.
- Giữ `async`, `strict`, `defer_loading`, tool `shell`/`apply_patch`, `configuration_update` và `prompt_cache_options`.
- Loại các tham số không được hỗ trợ: temperature/top_p/logprobs; giữ các include hợp lệ và yêu cầu `reasoning.encrypted_content` khi dùng reasoning.
- Khi có `prompt_cache_retention` cũ, chuyển sang `prompt_cache_options.ttl: "30m"` nếu chưa có cấu hình mới.

Đây là kiểm tra HTTP/Responses payload với upstream giả lập. Chưa xác nhận quyền truy cập model, khả năng cụ thể của relay/OAuth, tính năng WebSocket hoặc chất lượng câu trả lời thực tế. Giá hiển thị và context window của từng endpoint không phải phép đo quota thực của account.

Nguồn chính thức đã đọc:

- [GPT-6 Astra: model và reasoning](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [Hướng dẫn GPT-6 Astra](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra)
- [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- [Compaction](https://developers.openai.com/api/docs/guides/compaction)
- [Reasoning, phase và configuration_update](https://developers.openai.com/api/docs/guides/reasoning)
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

## Kiểm chứng

Hai file test mới bao phủ chuyển relay → OAuth, structured errors, reset dài, dữ liệu không bị mutation, session affinity, compact, JSON/SSE, cặp tool call/output, GPT mới, retry budget, hủy và lỗi transport. Các test dùng credential giả và upstream mock.

- **53/53 test mới đạt.**
- Toàn bộ unit suite, loại test live: **1.885 đạt, 48 lỗi có sẵn, 24 bỏ qua**. Checkout trước sửa có 1.832 đạt và cùng 48 lỗi; không có test lỗi mới trong so sánh.
- Lỗi có sẵn gồm test phụ thuộc Windows/macOS, file/dependency thiếu, DB cleanup trên Windows và các assertion cũ ngoài phạm vi routing này. Danh sách tên test nằm trong artifact validation.
- `npm.cmd run build` đã qua; các kiểm tra dùng mock không chứng minh chất lượng của model hay mức quota tiết kiệm thực tế.

Kết quả đầy đủ cùng so sánh với checkout trước sửa được lưu tại `docs/reviews/2026-09-08-routing-validation.json`; log build tại `docs/reviews/2026-09-08-routing-build.log`. Các artifact trong `docs/` bị gitignore; tài liệu này và test mới nằm ngoài vùng ignore.

Để đánh giá chất lượng, nên giữ cùng model/effort và dùng một task nhiều lượt có tiêu chí rõ ràng. Tạm tắt các bộ nén/thay prompt không cần thiết khi đối chiếu, rồi bật lại từng bộ. Không tăng effort hoặc đổi model tự động chỉ để che lỗi ngữ cảnh. Bản sửa giữ mặc định reasoning thấp hiện có nếu client không chỉ định.

Chưa restart/deploy dịch vụ đang chạy, chưa commit/push. Báo cáo điều tra trước sửa nằm ở `docs/reviews/2026-09-08-codex-routing-context.md`; mô tả hành vi hiện tại xem tài liệu này.
