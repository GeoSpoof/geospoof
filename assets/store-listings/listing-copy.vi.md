# Store Listing Copy — Vietnamese

Vietnamese copy for the Chrome Web Store and AMO. It mirrors the English copy in
[`listing-copy.md`](listing-copy.md), section for section, with the same emoji. The
terms follow `_locales/vi/messages.json` (giả mạo, vị trí địa lý, múi giờ, Đồng bộ với
VPN, Trang web, Bộ lọc, Chế độ lọc, Mọi trang web／Cho phép／Chặn with the lists Danh
sách cho phép／Danh sách chặn, Vị trí theo trang web, Vị trí chính, Ngẫu nhiên hóa vị
trí, Nhóm trang web, Chỉ đúng địa chỉ này, Danh sách từ liên kết, Giả mạo cấp engine,
Bảo vệ múi giờ tức thì) and its "bạn". It was written from the English, not translated
through another language, and **still needs review by a native speaker**. When the
English copy changes, update this file in the same commit.

## Where each field comes from

| Store | Field                | Source                                               | What to do                                                                                       |
| ----- | -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| CWS   | Title                | `src/build/manifest.ts` (chromium override, English) | Nothing. The Chromium manifest uses a literal English title, so every listing language shows it. |
| CWS   | Short description    | `src/build/manifest.ts` (chromium override, English) | Nothing, for the same reason.                                                                    |
| CWS   | Detailed description | Section (a) below                                    | Paste it by hand under the Vietnamese listing language in the Developer Dashboard.               |
| AMO   | Name                 | `_locales/vi/messages.json` (`extensionName`)        | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Summary              | `_locales/vi/messages.json` (`extensionDescription`) | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Detailed description | Section (b) below                                    | Paste it by hand into the vi locale in the AMO Developer Hub.                                    |

---

## (a) Chrome Web Store detailed description (plain text)

🛡️ Giả mạo vị trí địa lý, múi giờ và mọi tín hiệu vị trí khác, chỉ với một cú nhấp.

GeoSpoof là tiện ích Chrome đặt quyền riêng tư lên hàng đầu, giúp giả mạo vị trí địa lý và đổi vị trí của bạn. Chỉ cần bật một công tắc, mọi trang web sẽ đọc vị trí giả mà bạn chọn, chứ không phải nơi bạn thật sự đang ở.

Một công cụ đổi vị trí thông thường chỉ dời chiếc ghim trên bản đồ. GeoSpoof làm nhiều hơn thế: nó chỉnh múi giờ cho khớp, chặn rò rỉ IP qua WebRTC và tự động đồng bộ với VPN của bạn, để mọi tín hiệu đều khớp với nơi bạn chọn.

Chọn một thành phố, nhập tọa độ chính xác hoặc để GeoSpoof tự khớp với VPN của bạn. Tắt bất cứ lúc nào và vị trí thật của bạn sẽ trở lại nguyên vẹn.

🆕 Mới trong bản 2.3.0: nhóm trang web, địa chỉ chính xác và danh sách từ liên kết, dùng được cả trong Bộ lọc lẫn Vị trí theo trang web; Ngẫu nhiên hóa vị trí; cùng thẻ Trang web và phần Cài đặt được thiết kế lại.

⭐ Vì sao mọi người chọn GeoSpoof thay vì một công cụ đổi vị trí thông thường

1️⃣ Đặt vị trí GPS giả chỉ với một cú nhấp: bất kỳ thành phố nào hoặc tọa độ chính xác.
2️⃣ Đồng bộ với VPN: phát hiện vùng thoát của VPN và đặt vị trí của bạn theo vùng đó.
3️⃣ Tự động đồng bộ trong nền: đổi máy chủ VPN là vị trí của bạn tự đổi theo.
4️⃣ Cả múi giờ cũng khớp: giờ và ngày khớp với vị trí của bạn, nên hai thứ không mâu thuẫn nhau.
5️⃣ Chặn rò rỉ WebRTC: giấu IP thật của bạn, kể cả khi đang dùng VPN.
6️⃣ Giả mạo cấp engine: chính engine của trình duyệt áp dụng múi giờ của bạn, kể cả trong worker và khung của trang web khác, sớm nhất mà Chrome cho phép.
7️⃣ Chống lấy dấu vân tay: mọi tín hiệu luôn nhất quán và vượt qua các bước kiểm tra mà những đoạn mã lấy dấu vân tay thật sự thực hiện.
8️⃣ Vị trí theo trang web: cho một trang web vị trí riêng, trong khi các trang khác vẫn dùng vị trí chính của bạn.
9️⃣ Bộ lọc: chọn Mọi trang web, Cho phép hoặc Chặn để quyết định GeoSpoof hoạt động ở đâu.
🔟 Không cần tài khoản, không theo dõi, không phân tích: mọi thứ ở lại trên thiết bị của bạn.

📍 Đặt vị trí giả theo cách bạn muốn

▸ Tìm theo thành phố hoặc địa chỉ và đến đúng chỗ.
▸ Tự nhập vĩ độ và kinh độ chính xác để có vị trí GPS sạch.
▸ Chỉnh độ chính xác, từ mức chân thực đến một giá trị mét tùy chọn.
▸ Lưu tối đa 50 địa điểm yêu thích và chuyển đổi chỉ với một chạm.
▸ Cài đặt, ở biểu tượng bánh răng ⚙, giờ hiển thị trước những gì trang web thấy, bên dưới là Nâng cao và Chung.

🎲 Ngẫu nhiên hóa vị trí

Trang web có thể nhận một điểm ngẫu nhiên gần vị trí bạn chọn thay vì đúng chỗ đó: trong vòng 0,5 km, 2 km hoặc 10 km. Giữ nguyên một điểm, hoặc chọn điểm mới mỗi phiên trình duyệt, mỗi giờ hay mỗi ngày.

Điểm luôn được chọn quanh vị trí bạn đặt trong GeoSpoof, không bao giờ quanh vị trí thật của bạn, và múi giờ vẫn theo vị trí bạn chọn. Có một sự đánh đổi nên biết: điểm thay đổi khó bị nhận ra giữa các lần truy cập hơn, nhưng trang web thu thập được nhiều điểm có thể lấy trung bình chúng.

🧭 Quyết định nơi nó hoạt động, từng trang một

Thẻ Trang web được thiết kế lại cho thấy trang bạn đang mở và vị trí mà trang đó thấy, kèm một nút để thêm trang vào danh sách hoặc gỡ ra.

▸ Bộ lọc: trong Chế độ lọc, chọn Mọi trang web, Cho phép (chỉ các trang trong Danh sách cho phép) hoặc Chặn (mọi trang trừ các trang trong Danh sách chặn).
▸ Vị trí theo trang web: Twitch có thể thấy Thành phố Mexico và ChatGPT thấy Dublin, còn mọi trang khác thấy Tokyo. Khi nhiều mục cùng khớp, mục cụ thể nhất sẽ được dùng.
▸ Nhóm trang web: một mục bao gồm mọi tên miền mà một dịch vụ dùng, như Google, Netflix hay OpenAI, hoặc một khu vực như Trang web Trung Quốc. Khoảng 1.500 nhóm lấy từ danh sách tên miền v2fly, thứ mà các công cụ proxy gọi là geosite, và GeoSpoof cập nhật chúng khoảng mỗi tuần một lần.
▸ Chỉ đúng địa chỉ này: khớp với mail.example.com và không khớp tên miền con nào của nó.
▸ Danh sách từ liên kết: dán liên kết https:// tới một danh sách tên miền bạn đang dùng cho proxy. GeoSpoof sẽ tải về và cập nhật hằng tuần.

Nhóm trang web, địa chỉ chính xác và danh sách từ liên kết dùng được cả trong Bộ lọc lẫn Vị trí theo trang web.

🌍 Giả mạo vị trí địa lý dù có hay không có VPN

VPN đổi IP của bạn. GeoSpoof viết lại tọa độ mà trình duyệt báo qua API vị trí địa lý, và có thể đồng bộ hai thứ đó với nhau.

Dùng riêng, hoặc kết hợp với VPN để IP, vị trí và múi giờ của bạn kể cùng một câu chuyện.

🔒 Quyền riêng tư là trên hết

🔹 Mọi thứ chạy trên thiết bị của bạn: GeoSpoof không bao giờ gửi vị trí thật của bạn lên máy chủ.
🔹 Không cần tài khoản, không theo dõi, không phân tích. Cài đặt được lưu cục bộ.
🔹 Bộ lọc và vị trí theo trang web của bạn không bao giờ rời khỏi thiết bị. Khi cập nhật nhóm trang web, GeoSpoof tải về toàn bộ danh mục, nên không yêu cầu nào tiết lộ bạn đã chọn những nhóm nào.
🔹 Danh sách từ liên kết được tải thẳng từ trang lưu trữ nó, và trang đó thấy địa chỉ IP của bạn, như mọi lượt tải xuống khác.
🔹 Mã nguồn mở: xem chính xác nó làm gì trên GitHub.
🔹 Tắt bảo vệ là tọa độ thật của bạn trở lại nguyên vẹn.

💡 Dành cho ai

◆ Người coi trọng quyền riêng tư, không muốn trang web ghi lại nơi mình ở.
◆ Nhà phát triển kiểm thử các tính năng về vị trí, múi giờ và khu vực.
◆ Bất kỳ ai muốn truy cập nội dung và dịch vụ theo khu vực.
◆ Người dùng VPN muốn vị trí trên trình duyệt khớp với nút thoát.

❓ Câu hỏi thường gặp

📌 Trang web có còn thấy vị trí thật của tôi không?
💡 Không. Khi bảo vệ đang bật, trình duyệt trả về nơi bạn đã chọn.

📌 Đây có phải VPN không?
💡 Không. GeoSpoof đổi tọa độ mà trình duyệt báo, không đổi IP của bạn. Nó kết hợp rất tốt với VPN và thậm chí có thể tự đồng bộ với VPN.

📌 Tôi có thể đặt một điểm chính xác không?
💡 Có. Nhập vĩ độ và kinh độ chính xác, hoặc tìm một thành phố, để giả mạo GPS gọn gàng.

📌 Nó có đổi cả múi giờ của tôi không?
💡 Có. GeoSpoof giả mạo múi giờ cùng với vị trí để hai thứ luôn khớp nhau, chi tiết mà các công cụ chỉ đổi vị trí thường để lộ.

📌 Đây chỉ là công cụ đổi vị trí thôi sao?
💡 Không chỉ vậy. GeoSpoof đặt vị trí giả, rồi chỉnh múi giờ cho khớp và chặn rò rỉ WebRTC để không gì mâu thuẫn với nó.

📌 Nó có dùng được trên Google Maps không?
💡 Có. GeoSpoof hoạt động trên mọi trang web dùng API vị trí địa lý của trình duyệt.

📌 Dữ liệu của tôi có an toàn không?
💡 Có. GeoSpoof chạy cục bộ, không thu thập gì và là mã nguồn mở. Không thông tin nào về vị trí của bạn rời khỏi thiết bị.

📌 Vị trí theo trang web có đổi IP hay khu vực tài khoản của tôi không?
💡 Không. Nó đổi những gì các trang của trang web đó đọc từ trình duyệt: vị trí, múi giờ, và ngôn ngữ nếu bạn đặt ngôn ngữ theo vị trí. IP và thông tin tài khoản của bạn vẫn giữ nguyên, nên để có kết quả nhất quán nhất, hãy kết hợp với một điểm thoát VPN ở cùng nơi.

📌 Trang web có biết tôi đang dùng GeoSpoof không?
💡 Không thể loại trừ. GeoSpoof vượt qua các bước kiểm tra mà những đoạn mã lấy dấu vân tay thật sự thực hiện và giữ mọi tín hiệu nhất quán, nhưng không tiện ích nào xóa được mọi dấu vết: cơ chế bên trong engine và kênh phụ dựa trên thời gian nằm ngoài tầm với của tiện ích. Tự kiểm tra tại geospoof.com/test.

📌 Tôi có cần đăng ký không?
💡 Không cần tài khoản, không cần thiết lập. Cài đặt xong là đổi vị trí được ngay.

📲 Giờ đã có trên iPhone, iPad và Mac.

Vị trí theo trang web, nhóm trang web và Ngẫu nhiên hóa vị trí đều miễn phí trên Chrome. Trên Safari, Bộ lọc, Vị trí theo trang web và Ngẫu nhiên hóa vị trí thuộc GeoSpoof Pro, còn nhóm trang web, địa chỉ chính xác và danh sách từ liên kết thì chưa có.

Cài GeoSpoof, đặt vị trí giả và tự quyết định web được biết gì về nơi bạn đang ở.

Liên kết:
— geospoof.com
— github.com/GeoSpoof/geospoof

---

## (b) AMO detailed description (Markdown)

Same rules as the English AMO copy: Markdown, bold lines instead of headings. Feature 6
describes Firefox's protection, not Chrome's Engine-level Spoofing.

**🛡️ Giả mạo vị trí địa lý, múi giờ và mọi tín hiệu vị trí khác, chỉ với một cú nhấp.**

GeoSpoof là tiện ích Firefox đặt quyền riêng tư lên hàng đầu, giúp **giả mạo vị trí địa lý** và **đổi vị trí** của bạn. Chỉ cần bật một công tắc, mọi trang web sẽ đọc vị trí giả mà bạn chọn, chứ không phải nơi bạn thật sự đang ở.

Một công cụ đổi vị trí thông thường chỉ dời chiếc ghim trên bản đồ. GeoSpoof làm nhiều hơn thế: nó chỉnh **múi giờ** cho khớp, chặn **rò rỉ IP qua WebRTC** và tự động đồng bộ với **VPN** của bạn, để mọi tín hiệu đều khớp với nơi bạn chọn.

Chọn một thành phố, nhập tọa độ chính xác hoặc để GeoSpoof tự khớp với VPN của bạn. Tắt bất cứ lúc nào và vị trí thật của bạn sẽ trở lại nguyên vẹn.

**🆕 Mới trong bản 2.3.0:** nhóm trang web, địa chỉ chính xác và danh sách từ liên kết, dùng được cả trong Bộ lọc lẫn Vị trí theo trang web; Ngẫu nhiên hóa vị trí; cùng thẻ Trang web và phần Cài đặt được thiết kế lại.

**⭐ Vì sao mọi người chọn GeoSpoof thay vì một công cụ đổi vị trí thông thường**

1. **Đặt vị trí GPS giả chỉ với một cú nhấp**: bất kỳ thành phố nào hoặc tọa độ chính xác.
2. **Đồng bộ với VPN**: phát hiện vùng thoát của VPN và đặt vị trí của bạn theo vùng đó.
3. **Tự động đồng bộ trong nền**: đổi máy chủ VPN là vị trí của bạn tự đổi theo.
4. **Cả múi giờ cũng khớp**: giờ và ngày khớp với vị trí của bạn, nên hai thứ không mâu thuẫn nhau.
5. **Chặn rò rỉ WebRTC**: giấu IP thật của bạn, kể cả khi đang dùng VPN.
6. **Bảo vệ múi giờ trong worker**: bao phủ worker và lúc trang khởi động, kèm tùy chọn Bảo vệ múi giờ tức thì có hiệu lực từ đoạn mã đầu tiên của trang.
7. **Chống lấy dấu vân tay**: mọi tín hiệu luôn nhất quán và vượt qua các bước kiểm tra mà những đoạn mã lấy dấu vân tay thật sự thực hiện.
8. **Vị trí theo trang web**: cho một trang web vị trí riêng, trong khi các trang khác vẫn dùng vị trí chính của bạn.
9. **Bộ lọc**: chọn Mọi trang web, Cho phép hoặc Chặn để quyết định GeoSpoof hoạt động ở đâu.
10. **Không cần tài khoản, không theo dõi, không phân tích**: mọi thứ ở lại trên thiết bị của bạn.

**📍 Đặt vị trí giả theo cách bạn muốn**

- Tìm theo thành phố hoặc địa chỉ và đến đúng chỗ.
- Tự nhập vĩ độ và kinh độ chính xác để có vị trí GPS sạch.
- Chỉnh độ chính xác, từ mức chân thực đến một giá trị mét tùy chọn.
- Lưu tối đa 50 địa điểm yêu thích và chuyển đổi chỉ với một chạm.
- **Cài đặt**, ở biểu tượng bánh răng ⚙, giờ hiển thị trước những gì trang web thấy, bên dưới là Nâng cao và Chung.

**🎲 Ngẫu nhiên hóa vị trí**

Trang web có thể nhận một điểm ngẫu nhiên gần vị trí bạn chọn thay vì đúng chỗ đó: trong vòng 0,5 km, 2 km hoặc 10 km. Giữ nguyên một điểm, hoặc chọn điểm mới mỗi phiên trình duyệt, mỗi giờ hay mỗi ngày.

Điểm luôn được chọn quanh vị trí bạn đặt trong GeoSpoof, không bao giờ quanh vị trí thật của bạn, và múi giờ vẫn theo vị trí bạn chọn. Có một sự đánh đổi nên biết: điểm thay đổi khó bị nhận ra giữa các lần truy cập hơn, nhưng trang web thu thập được nhiều điểm có thể lấy trung bình chúng.

**🧭 Quyết định nơi nó hoạt động, từng trang một**

Thẻ **Trang web** được thiết kế lại cho thấy trang bạn đang mở và vị trí mà trang đó thấy, kèm một nút để thêm trang vào danh sách hoặc gỡ ra.

- **Bộ lọc**: trong Chế độ lọc, chọn Mọi trang web, **Cho phép** (chỉ các trang trong Danh sách cho phép) hoặc **Chặn** (mọi trang trừ các trang trong Danh sách chặn).
- **Vị trí theo trang web**: Twitch có thể thấy Thành phố Mexico và ChatGPT thấy Dublin, còn mọi trang khác thấy Tokyo. Khi nhiều mục cùng khớp, mục cụ thể nhất sẽ được dùng.
- **Nhóm trang web**: một mục bao gồm mọi tên miền mà một dịch vụ dùng, như Google, Netflix hay OpenAI, hoặc một khu vực như Trang web Trung Quốc. Khoảng 1.500 nhóm lấy từ [danh sách tên miền v2fly](https://github.com/v2fly/domain-list-community), thứ mà các công cụ proxy gọi là `geosite`, và GeoSpoof cập nhật chúng khoảng mỗi tuần một lần.
- **Chỉ đúng địa chỉ này**: khớp với `mail.example.com` và không khớp tên miền con nào của nó.
- **Danh sách từ liên kết**: dán liên kết `https://` tới một danh sách tên miền bạn đang dùng cho proxy. GeoSpoof sẽ tải về và cập nhật hằng tuần.

Nhóm trang web, địa chỉ chính xác và danh sách từ liên kết dùng được cả trong Bộ lọc lẫn Vị trí theo trang web.

**🌍 Giả mạo vị trí địa lý dù có hay không có VPN**

VPN đổi IP của bạn. GeoSpoof viết lại tọa độ mà trình duyệt báo qua API vị trí địa lý, và có thể đồng bộ hai thứ đó với nhau.

Dùng riêng, hoặc kết hợp với VPN để IP, vị trí và múi giờ của bạn kể cùng một câu chuyện.

**🔒 Quyền riêng tư là trên hết**

- Mọi thứ chạy trên thiết bị của bạn: GeoSpoof không bao giờ gửi vị trí thật của bạn lên máy chủ.
- Không cần tài khoản, không theo dõi, không phân tích. Cài đặt được lưu cục bộ.
- Bộ lọc và vị trí theo trang web của bạn không bao giờ rời khỏi thiết bị. Khi cập nhật nhóm trang web, GeoSpoof tải về toàn bộ danh mục, nên không yêu cầu nào tiết lộ bạn đã chọn những nhóm nào.
- Danh sách từ liên kết được tải thẳng từ trang lưu trữ nó, và trang đó thấy địa chỉ IP của bạn, như mọi lượt tải xuống khác.
- _Mã nguồn mở_: xem chính xác nó làm gì trên [GitHub](https://github.com/GeoSpoof/geospoof).
- Tắt bảo vệ là tọa độ thật của bạn trở lại nguyên vẹn.

**💡 Dành cho ai**

- Người coi trọng quyền riêng tư, không muốn trang web ghi lại nơi mình ở.
- Nhà phát triển kiểm thử các tính năng về vị trí, múi giờ và khu vực.
- Bất kỳ ai muốn truy cập nội dung và dịch vụ theo khu vực.
- Người dùng VPN muốn vị trí trên trình duyệt khớp với nút thoát.

**❓ Câu hỏi thường gặp**

📌 **Trang web có còn thấy vị trí thật của tôi không?** Không. Khi bảo vệ đang bật, trình duyệt trả về nơi bạn đã chọn.

📌 **Đây có phải VPN không?** Không. GeoSpoof đổi tọa độ mà trình duyệt báo, không đổi IP của bạn. Nó kết hợp rất tốt với VPN và thậm chí có thể tự đồng bộ với VPN.

📌 **Tôi có thể đặt một điểm chính xác không?** Có. Nhập vĩ độ và kinh độ chính xác, hoặc tìm một thành phố, để giả mạo GPS gọn gàng.

📌 **Nó có đổi cả múi giờ của tôi không?** Có. GeoSpoof giả mạo múi giờ cùng với vị trí để hai thứ luôn khớp nhau, chi tiết mà các công cụ chỉ đổi vị trí thường để lộ.

📌 **Đây chỉ là công cụ đổi vị trí thôi sao?** Không chỉ vậy. GeoSpoof đặt vị trí giả, rồi chỉnh múi giờ cho khớp và chặn rò rỉ WebRTC để không gì mâu thuẫn với nó.

📌 **Nó có dùng được trên Google Maps không?** Có. GeoSpoof hoạt động trên mọi trang web dùng API vị trí địa lý của trình duyệt.

📌 **Dữ liệu của tôi có an toàn không?** Có. GeoSpoof chạy cục bộ, không thu thập gì và là mã nguồn mở. Không thông tin nào về vị trí của bạn rời khỏi thiết bị.

📌 **Vị trí theo trang web có đổi IP hay khu vực tài khoản của tôi không?** Không. Nó đổi những gì các trang của trang web đó đọc từ trình duyệt: vị trí, múi giờ, và ngôn ngữ nếu bạn đặt ngôn ngữ theo vị trí. IP và thông tin tài khoản của bạn vẫn giữ nguyên, nên để có kết quả nhất quán nhất, hãy kết hợp với một điểm thoát VPN ở cùng nơi.

📌 **Trang web có biết tôi đang dùng GeoSpoof không?** Không thể loại trừ. GeoSpoof vượt qua các bước kiểm tra mà những đoạn mã lấy dấu vân tay thật sự thực hiện và giữ mọi tín hiệu nhất quán, nhưng không tiện ích nào xóa được mọi dấu vết: cơ chế bên trong engine và kênh phụ dựa trên thời gian nằm ngoài tầm với của tiện ích. Tự kiểm tra tại [geospoof.com/test](https://geospoof.com/test).

📌 **Tôi có cần đăng ký không?** Không cần tài khoản, không cần thiết lập. Cài đặt xong là đổi vị trí được ngay.

**📲 Giờ đã có trên iPhone, iPad và Mac.**

Vị trí theo trang web, nhóm trang web và Ngẫu nhiên hóa vị trí đều miễn phí trên Firefox. Trên Safari, Bộ lọc, Vị trí theo trang web và Ngẫu nhiên hóa vị trí thuộc GeoSpoof Pro, còn nhóm trang web, địa chỉ chính xác và danh sách từ liên kết thì chưa có.

Cài GeoSpoof, đặt vị trí giả và tự quyết định web được biết gì về nơi bạn đang ở.

Liên kết:

- [geospoof.com](https://geospoof.com)
- [GitHub](https://github.com/GeoSpoof/geospoof)
