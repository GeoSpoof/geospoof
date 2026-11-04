# Store Listing Copy — Traditional Chinese (Taiwan)

Traditional Chinese (Taiwan) copy for the Chrome Web Store and AMO. It mirrors the
English copy in [`listing-copy.md`](listing-copy.md), section for section, with the
same emoji and the same keyword discipline. The terms follow
`_locales/zh_TW/messages.json` (偽造, 時區, 與 VPN 同步, 允許清單／封鎖清單, 擴充功能,
引擎層級偽造, 即時時區保護). It was written from the English, not converted from
Simplified Chinese, and still needs review by a native speaker. When the English copy
changes, update this file in the same commit.

## Where each field comes from

| Store | Field                | Source                                                  | What to do                                                                                       |
| ----- | -------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| CWS   | Title                | `src/build/manifest.ts` (chromium override, English)    | Nothing. The Chromium manifest uses a literal English title, so every listing language shows it. |
| CWS   | Short description    | `src/build/manifest.ts` (chromium override, English)    | Nothing, for the same reason.                                                                    |
| CWS   | Detailed description | Section (a) below                                       | Paste it by hand under the Chinese (Taiwan) listing language in the Developer Dashboard.         |
| AMO   | Name                 | `_locales/zh_TW/messages.json` (`extensionName`)        | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Summary              | `_locales/zh_TW/messages.json` (`extensionDescription`) | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Detailed description | Section (b) below                                       | Paste it by hand into the zh-TW locale in the AMO Developer Hub.                                 |

---

## (a) Chrome Web Store detailed description (plain text)

🛡️ 一鍵偽造地理位置、時區和所有位置訊號。

GeoSpoof 是一款重視隱私的 Chrome 擴充功能，可以偽造地理位置、變更你的位置。只要開啟一個開關，網站讀到的就是你選擇的偽造位置，而不是你真正所在的地方。

一般的位置變更工具只會移動地圖上的圖釘。GeoSpoof 更進一步：它會讓時區一致、阻擋 WebRTC IP 洩漏，並自動與你的 VPN 同步，讓每個訊號都符合你選擇的地點。

選擇城市、輸入確切座標，或讓 GeoSpoof 自動配合你的 VPN。隨時都能關閉，你的真實位置會原封不動地恢復。

⭐ 為什麼大家選擇 GeoSpoof，而不是一般的位置變更工具

1️⃣ 一鍵設定偽造的 GPS 位置：任何城市或確切座標都可以。
2️⃣ 與 VPN 同步：偵測 VPN 的出口地區，並將你的位置設為該地區。
3️⃣ 背景自動同步：切換 VPN 伺服器後，你的位置會自動跟著更新。
4️⃣ 時區也一致：時鐘和日期與你的位置相符，各項訊號不會互相矛盾。
5️⃣ 阻擋 WebRTC 洩漏：即使使用 VPN，也能隱藏你的真實 IP。
6️⃣ 引擎層級偽造：由瀏覽器引擎套用時區，涵蓋背景 Worker 和跨網站框架，並盡可能提早生效。
7️⃣ 反指紋辨識：各項訊號保持一致，讓你的位置經得起檢查。
8️⃣ 依網站控制：用允許清單或封鎖清單決定要偽造哪些網站，也能為特定網站設定專屬位置。
9️⃣ 儲存收藏：最多可釘選 50 個地點，點一下就能切換。
🔟 不需帳號、不追蹤、不做分析：所有資料都留在你的裝置上。

📍 用你喜歡的方式設定偽造位置

▸ 依城市或地址搜尋，直接找到確切地點。
▸ 手動輸入精確的緯度和經度，取得乾淨的 GPS 定位。
▸ 調整準確度，從「擬真」到自訂的公尺數值都可以。
▸ 儲存最常用的地點，隨時都能再次使用。

🌍 不論有沒有 VPN，都能偽造地理位置

VPN 會變更你的 IP。GeoSpoof 則會改寫瀏覽器透過地理位置 API 回報的座標，還能讓兩者同步。

可以單獨使用，也可以搭配 VPN，讓你的 IP、位置和時區彼此吻合。

🔒 隱私優先

🔹 所有處理都在你的裝置上進行，GeoSpoof 絕不會將你的真實位置傳送到伺服器。
🔹 不需帳號、不追蹤、不做分析。設定都儲存在本機。
🔹 開放原始碼：可以在 GitHub 上檢視它的實際運作方式。
🔹 關閉保護後，你的真實座標會原封不動地恢復。

💡 適合哪些人

◆ 注重隱私、不希望網站記錄自己所在位置的人。
◆ 測試位置、時區和地區功能的開發人員。
◆ 需要存取特定地區內容和服務的人。
◆ 希望瀏覽器位置與 VPN 出口節點一致的 VPN 使用者。

❓ 常見問題

📌 網站還會看到我的真實位置嗎？
💡 不會。保護開啟時，瀏覽器會回傳你選擇的地點。

📌 這是 VPN 嗎？
💡 不是。GeoSpoof 變更的是瀏覽器回報的座標，而不是你的 IP。它很適合搭配 VPN 使用，甚至能自動與 VPN 同步。

📌 可以設定確切的位置嗎？
💡 可以。輸入精確的緯度和經度，或搜尋城市，就能乾淨地偽造 GPS。

📌 它也會變更我的時區嗎？
💡 會。GeoSpoof 會同時偽造你的時區和位置，讓兩者始終相符；只變更位置的工具常常在這裡露出破綻。

📌 這只是位置變更工具嗎？
💡 不只如此。GeoSpoof 會設定偽造位置，同時讓時區一致並阻擋 WebRTC 洩漏，避免任何訊號與它矛盾。

📌 可以在 Google 地圖上使用嗎？
💡 可以。GeoSpoof 適用於任何使用瀏覽器地理位置 API 的網站。

📌 我的資料安全嗎？
💡 安全。GeoSpoof 在本機執行、不收集任何資料，而且是開放原始碼。與你位置有關的資訊都不會離開你的裝置。

📌 需要註冊嗎？
💡 不需要帳號，也不用設定。安裝後就能立即變更你的位置。

📲 現在也支援 iPhone、iPad 和 Mac。

安裝 GeoSpoof，設定偽造位置，自己決定網路能看到你在哪裡。

連結：
— geospoof.com
— github.com/GeoSpoof/geospoof

---

## (b) AMO detailed description (Markdown)

Same rules as the English AMO copy: Markdown, bold lines instead of headings. Feature 6
describes Firefox's protection, not Chrome's Engine-level Spoofing.

**🛡️ 一鍵偽造地理位置、時區和所有位置訊號。**

GeoSpoof 是一款重視隱私的 Firefox 擴充功能，可以**偽造地理位置**、**變更你的位置**。只要開啟一個開關，網站讀到的就是你選擇的偽造位置，而不是你真正所在的地方。

一般的位置變更工具只會移動地圖上的圖釘。GeoSpoof 更進一步：它會讓**時區**一致、阻擋 **WebRTC IP 洩漏**，並自動與你的 **VPN** 同步，讓每個訊號都符合你選擇的地點。

選擇城市、輸入確切座標，或讓 GeoSpoof 自動配合你的 VPN。隨時都能關閉，你的真實位置會原封不動地恢復。

**⭐ 為什麼大家選擇 GeoSpoof，而不是一般的位置變更工具**

1. **一鍵設定偽造的 GPS 位置**：任何城市或確切座標都可以。
2. **與 VPN 同步**：偵測 VPN 的出口地區，並將你的位置設為該地區。
3. **背景自動同步**：切換 VPN 伺服器後，你的位置會自動跟著更新。
4. **時區也一致**：時鐘和日期與你的位置相符，各項訊號不會互相矛盾。
5. **阻擋 WebRTC 洩漏**：即使使用 VPN，也能隱藏你的真實 IP。
6. **Worker 層級時區保護**：填補 Worker 和冷啟動時的洩漏，並可選用「即時時區保護」，從頁面的第一個指令碼開始生效。
7. **反指紋辨識**：各項訊號保持一致，讓你的位置經得起檢查。
8. **依網站控制**：用允許清單或封鎖清單決定要偽造哪些網站，也能為特定網站設定專屬位置。
9. **儲存收藏**：最多可釘選 50 個地點，點一下就能切換。
10. **不需帳號、不追蹤、不做分析**：所有資料都留在你的裝置上。

**📍 用你喜歡的方式設定偽造位置**

- 依城市或地址搜尋，直接找到確切地點。
- 手動輸入精確的緯度和經度，取得乾淨的 GPS 定位。
- 調整準確度，從「擬真」到自訂的公尺數值都可以。
- 儲存最常用的地點，隨時都能再次使用。

**🌍 不論有沒有 VPN，都能偽造地理位置**

VPN 會變更你的 IP。GeoSpoof 則會改寫瀏覽器透過地理位置 API 回報的座標，還能讓兩者同步。

可以單獨使用，也可以搭配 VPN，讓你的 IP、位置和時區彼此吻合。

**🔒 隱私優先**

- 所有處理都在你的裝置上進行，GeoSpoof 絕不會將你的真實位置傳送到伺服器。
- 不需帳號、不追蹤、不做分析。設定都儲存在本機。
- _開放原始碼_：可以在 [GitHub](https://github.com/GeoSpoof/geospoof) 上檢視它的實際運作方式。
- 關閉保護後，你的真實座標會原封不動地恢復。

**💡 適合哪些人**

- 注重隱私、不希望網站記錄自己所在位置的人。
- 測試位置、時區和地區功能的開發人員。
- 需要存取特定地區內容和服務的人。
- 希望瀏覽器位置與 VPN 出口節點一致的 VPN 使用者。

**❓ 常見問題**

📌 **網站還會看到我的真實位置嗎？** 不會。保護開啟時，瀏覽器會回傳你選擇的地點。

📌 **這是 VPN 嗎？** 不是。GeoSpoof 變更的是瀏覽器回報的座標，而不是你的 IP。它很適合搭配 VPN 使用，甚至能自動與 VPN 同步。

📌 **可以設定確切的位置嗎？** 可以。輸入精確的緯度和經度，或搜尋城市，就能乾淨地偽造 GPS。

📌 **它也會變更我的時區嗎？** 會。GeoSpoof 會同時偽造你的時區和位置，讓兩者始終相符；只變更位置的工具常常在這裡露出破綻。

📌 **這只是位置變更工具嗎？** 不只如此。GeoSpoof 會設定偽造位置，同時讓時區一致並阻擋 WebRTC 洩漏，避免任何訊號與它矛盾。

📌 **可以在 Google 地圖上使用嗎？** 可以。GeoSpoof 適用於任何使用瀏覽器地理位置 API 的網站。

📌 **我的資料安全嗎？** 安全。GeoSpoof 在本機執行、不收集任何資料，而且是開放原始碼。與你位置有關的資訊都不會離開你的裝置。

📌 **需要註冊嗎？** 不需要帳號，也不用設定。安裝後就能立即變更你的位置。

**📲 現在也支援 iPhone、iPad 和 Mac。**

安裝 GeoSpoof，設定偽造位置，自己決定網路能看到你在哪裡。

連結：

- [geospoof.com](https://geospoof.com)
- [GitHub](https://github.com/GeoSpoof/geospoof)
