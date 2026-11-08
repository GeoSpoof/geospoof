# Store Listing Copy — Indonesian

Indonesian copy for the Chrome Web Store and AMO. It mirrors the English copy in
[`listing-copy.md`](listing-copy.md), section for section, with the same emoji. The
terms follow `_locales/id/messages.json` (palsukan, geolokasi, zona waktu, Sinkronkan
dengan VPN, Situs, Filter, Mode filter, Daftar izin／Daftar blokir, Lokasi per situs,
Lokasi utama, Acak lokasi, Grup situs, Hanya alamat persis, Daftar dari tautan,
Pemalsuan tingkat mesin, Perlindungan zona waktu instan) and its formal "Anda". It was
written from the English, not translated through another language, and **still needs
review by a native speaker**. When the English copy changes, update this file in the
same commit.

## Where each field comes from

| Store | Field                | Source                                               | What to do                                                                                       |
| ----- | -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| CWS   | Title                | `src/build/manifest.ts` (chromium override, English) | Nothing. The Chromium manifest uses a literal English title, so every listing language shows it. |
| CWS   | Short description    | `src/build/manifest.ts` (chromium override, English) | Nothing, for the same reason.                                                                    |
| CWS   | Detailed description | Section (a) below                                    | Paste it by hand under the Indonesian listing language in the Developer Dashboard.               |
| AMO   | Name                 | `_locales/id/messages.json` (`extensionName`)        | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Summary              | `_locales/id/messages.json` (`extensionDescription`) | Nothing. AMO reads it from the next uploaded version.                                            |
| AMO   | Detailed description | Section (b) below                                    | Paste it by hand into the id locale in the AMO Developer Hub.                                    |

---

## (a) Chrome Web Store detailed description (plain text)

🛡️ Palsukan geolokasi, zona waktu, dan semua sinyal lokasi lainnya, cukup dengan satu klik.

GeoSpoof adalah ekstensi Chrome yang mengutamakan privasi untuk memalsukan geolokasi dan mengubah lokasi Anda. Nyalakan satu sakelar, dan setiap situs membaca lokasi palsu yang Anda pilih, bukan tempat Anda sebenarnya berada.

Pengubah lokasi biasa hanya memindahkan pin di peta. GeoSpoof bekerja lebih jauh: menyelaraskan zona waktu, memblokir kebocoran IP WebRTC, dan menyinkronkan diri otomatis dengan VPN Anda, sehingga setiap sinyal cocok dengan tempat pilihan Anda.

Pilih kota, ketik koordinat yang tepat, atau biarkan GeoSpoof menyesuaikan dengan VPN Anda secara otomatis. Matikan kapan saja, dan lokasi asli Anda kembali tanpa perubahan.

🆕 Baru di 2.3.0: grup situs, alamat persis, dan daftar dari tautan, baik di Filter maupun di Lokasi per situs; Acak lokasi; serta tab Situs dan Pengaturan yang didesain ulang.

⭐ Mengapa memilih GeoSpoof, bukan pengubah lokasi biasa

1️⃣ Atur lokasi GPS palsu dengan satu klik: kota mana pun atau koordinat yang tepat.
2️⃣ Sinkronkan dengan VPN: mendeteksi wilayah keluar VPN Anda dan menyesuaikan lokasi Anda dengannya.
3️⃣ Sinkronisasi otomatis di latar belakang: ganti server VPN, dan lokasi Anda ikut berubah sendiri.
4️⃣ Zona waktu juga: jam dan tanggal sesuai dengan lokasi Anda, sehingga keduanya tidak saling bertentangan.
5️⃣ Blokir kebocoran WebRTC: IP asli Anda tetap tersembunyi, bahkan di balik VPN.
6️⃣ Pemalsuan tingkat mesin: mesin peramban sendiri yang menerapkan zona waktu Anda, termasuk di worker dan bingkai lintas situs, sedini yang diizinkan Chrome.
7️⃣ Anti-sidik jari: semua sinyal tetap konsisten dan lolos dari pemeriksaan yang dijalankan skrip sidik jari sungguhan.
8️⃣ Lokasi per situs: beri sebuah situs lokasinya sendiri, sementara situs lain tetap memakai lokasi utama Anda.
9️⃣ Filter: pilih Semua situs, Daftar izin, atau Daftar blokir untuk menentukan di mana GeoSpoof bekerja.
🔟 Tanpa akun, tanpa pelacakan, tanpa analitik: semuanya tetap di perangkat Anda.

📍 Atur lokasi palsu sesuai keinginan Anda

▸ Cari berdasarkan kota atau alamat dan langsung tiba di titik yang tepat.
▸ Masukkan lintang dan bujur secara manual untuk posisi GPS yang bersih.
▸ Atur akurasi, dari yang realistis hingga nilai meter khusus.
▸ Simpan hingga 50 tempat favorit dan beralih di antaranya dengan sekali ketuk.
▸ Pengaturan, di ikon roda gigi ⚙, kini menampilkan dulu apa yang dilihat situs, dengan opsi Lanjutan dan Umum di bawahnya.

🎲 Acak lokasi

Situs bisa menerima titik acak di dekat lokasi yang Anda pilih, bukan titik persisnya: dalam radius 0,5 km, 2 km, atau 10 km. Pertahankan titik yang sama, atau pilih titik baru setiap sesi peramban, setiap jam, atau setiap hari.

Titik tersebut selalu diambil di sekitar lokasi yang Anda pilih di GeoSpoof, tidak pernah di sekitar lokasi asli Anda, dan zona waktu tetap mengikuti lokasi pilihan Anda. Satu hal yang perlu diketahui: titik yang berubah-ubah lebih sulit dikenali dari kunjungan ke kunjungan, tetapi situs yang mengumpulkan beberapa titik bisa merata-ratakannya.

🧭 Tentukan di mana GeoSpoof bekerja, situs demi situs

Tab Situs yang didesain ulang menampilkan situs yang sedang Anda buka dan lokasi yang dilihatnya, dengan satu tombol untuk menambahkannya ke daftar atau menghapusnya.

▸ Filter: di Mode filter, pilih Semua situs, Daftar izin (hanya situs di daftar Anda), atau Daftar blokir (semua situs kecuali yang ada di daftar Anda).
▸ Lokasi per situs: Twitch bisa melihat Mexico City dan ChatGPT melihat Dublin, sementara semua situs lain melihat Tokyo. Jika beberapa entri cocok, entri yang paling spesifik yang dipakai.
▸ Grup situs: satu entri mencakup semua domain yang dipakai sebuah layanan, seperti Google, Netflix, atau OpenAI, atau sebuah wilayah seperti Situs Tiongkok. Sekitar 1.500 grup berasal dari daftar domain v2fly yang oleh alat proxy disebut geosite, dan GeoSpoof memperbaruinya kira-kira seminggu sekali.
▸ Hanya alamat persis: cocok dengan mail.example.com dan tidak dengan subdomainnya.
▸ Daftar dari tautan: tempelkan tautan https:// ke daftar domain yang sudah Anda pakai untuk proxy. GeoSpoof mengunduhnya dan memperbaruinya setiap minggu.

Grup situs, alamat persis, dan daftar dari tautan berfungsi baik di Filter maupun di Lokasi per situs.

🌍 Palsukan geolokasi dengan atau tanpa VPN

VPN mengubah IP Anda. GeoSpoof menulis ulang koordinat yang dilaporkan peramban melalui API geolokasi, dan bisa menyinkronkan keduanya.

Gunakan sendiri, atau padukan dengan VPN agar IP, lokasi, dan zona waktu Anda menceritakan hal yang sama.

🔒 Privasi nomor satu

🔹 Semuanya berjalan di perangkat Anda: GeoSpoof tidak pernah mengirim lokasi asli Anda ke server.
🔹 Tanpa akun, tanpa pelacakan, tanpa analitik. Pengaturan disimpan secara lokal.
🔹 Filter dan lokasi per situs Anda tidak pernah meninggalkan perangkat. Pembaruan grup situs mengunduh seluruh katalog, jadi tidak ada permintaan yang mengungkap grup mana yang Anda pilih.
🔹 Daftar dari tautan diunduh langsung dari situs yang menyimpannya, dan situs itu melihat alamat IP Anda, sama seperti unduhan lainnya.
🔹 Sumber terbuka: periksa sendiri di GitHub apa saja yang dilakukannya.
🔹 Matikan perlindungan, dan koordinat asli Anda kembali tanpa perubahan.

💡 Untuk siapa

◆ Orang yang peduli privasi dan tidak ingin situs mencatat di mana mereka berada.
◆ Pengembang yang menguji fitur lokasi, zona waktu, dan wilayah.
◆ Siapa saja yang ingin mengakses konten dan layanan khusus wilayah tertentu.
◆ Pengguna VPN yang ingin lokasi peramban sesuai dengan node keluarnya.

❓ Tanya jawab

📌 Apakah situs masih akan melihat lokasi asli saya?
💡 Tidak. Selama perlindungan aktif, peramban mengembalikan tempat yang Anda pilih.

📌 Apakah ini VPN?
💡 Bukan. GeoSpoof mengubah koordinat yang dilaporkan peramban, bukan IP Anda. Ekstensi ini sangat cocok dipadukan dengan VPN dan bahkan bisa tersinkron otomatis dengannya.

📌 Bisakah saya menetapkan titik yang tepat?
💡 Bisa. Masukkan lintang dan bujur yang tepat, atau cari sebuah kota, untuk memalsukan GPS dengan bersih.

📌 Apakah zona waktu saya juga berubah?
💡 Ya. GeoSpoof memalsukan zona waktu bersama lokasi Anda sehingga keduanya selalu cocok, celah yang sering terlewat oleh alat yang hanya mengubah lokasi.

📌 Apakah ini hanya pengubah lokasi?
💡 Ini pengubah lokasi dan lebih dari itu. GeoSpoof menetapkan lokasi palsu, lalu juga menyesuaikan zona waktu dan memblokir kebocoran WebRTC agar tidak ada yang bertentangan dengannya.

📌 Apakah berfungsi di Google Maps?
💡 Ya. GeoSpoof berfungsi di situs mana pun yang memakai API geolokasi peramban.

📌 Apakah data saya aman?
💡 Ya. GeoSpoof berjalan secara lokal, tidak mengumpulkan apa pun, dan bersumber terbuka. Tidak ada informasi tentang lokasi Anda yang meninggalkan perangkat.

📌 Apakah lokasi per situs mengubah IP atau wilayah akun saya?
💡 Tidak. Fitur ini mengubah apa yang dibaca halaman situs itu dari peramban Anda: lokasi, zona waktu, dan bahasa jika Anda mengaturnya agar mengikuti lokasi. IP dan data akun Anda tetap sama, jadi untuk hasil yang paling konsisten, padukan dengan titik keluar VPN di tempat yang sama.

📌 Bisakah situs tahu bahwa saya memakai GeoSpoof?
💡 Kemungkinan itu tidak bisa dihilangkan sepenuhnya. GeoSpoof lolos dari pemeriksaan yang dijalankan skrip sidik jari sungguhan dan menjaga semua sinyal tetap konsisten, tetapi tidak ada ekstensi yang bisa menghapus semua jejak: mekanisme internal mesin dan saluran samping berbasis waktu berada di luar jangkauannya. Periksa sendiri di geospoof.com/test.

📌 Apakah saya perlu mendaftar?
💡 Tanpa akun dan tanpa pengaturan awal. Pasang dan langsung ubah lokasi Anda.

📲 Kini juga tersedia di iPhone, iPad, dan Mac.

Lokasi per situs, grup situs, dan Acak lokasi gratis di Chrome. Di Safari, Filter, Lokasi per situs, dan Acak lokasi termasuk GeoSpoof Pro, sedangkan grup situs, alamat persis, dan daftar dari tautan belum tersedia.

Pasang GeoSpoof, atur lokasi palsu, dan tentukan sendiri apa yang dilihat web tentang keberadaan Anda.

Tautan:
— geospoof.com
— github.com/GeoSpoof/geospoof

---

## (b) AMO detailed description (Markdown)

Same rules as the English AMO copy: Markdown, bold lines instead of headings. Feature 6
describes Firefox's protection, not Chrome's Engine-level Spoofing.

**🛡️ Palsukan geolokasi, zona waktu, dan semua sinyal lokasi lainnya, cukup dengan satu klik.**

GeoSpoof adalah ekstensi Firefox yang mengutamakan privasi untuk **memalsukan geolokasi** dan **mengubah lokasi** Anda. Nyalakan satu sakelar, dan setiap situs membaca lokasi palsu yang Anda pilih, bukan tempat Anda sebenarnya berada.

Pengubah lokasi biasa hanya memindahkan pin di peta. GeoSpoof bekerja lebih jauh: menyelaraskan **zona waktu**, memblokir **kebocoran IP WebRTC**, dan menyinkronkan diri otomatis dengan **VPN** Anda, sehingga setiap sinyal cocok dengan tempat pilihan Anda.

Pilih kota, ketik koordinat yang tepat, atau biarkan GeoSpoof menyesuaikan dengan VPN Anda secara otomatis. Matikan kapan saja, dan lokasi asli Anda kembali tanpa perubahan.

**🆕 Baru di 2.3.0:** grup situs, alamat persis, dan daftar dari tautan, baik di Filter maupun di Lokasi per situs; Acak lokasi; serta tab Situs dan Pengaturan yang didesain ulang.

**⭐ Mengapa memilih GeoSpoof, bukan pengubah lokasi biasa**

1. **Atur lokasi GPS palsu dengan satu klik**: kota mana pun atau koordinat yang tepat.
2. **Sinkronkan dengan VPN**: mendeteksi wilayah keluar VPN Anda dan menyesuaikan lokasi Anda dengannya.
3. **Sinkronisasi otomatis di latar belakang**: ganti server VPN, dan lokasi Anda ikut berubah sendiri.
4. **Zona waktu juga**: jam dan tanggal sesuai dengan lokasi Anda, sehingga keduanya tidak saling bertentangan.
5. **Blokir kebocoran WebRTC**: IP asli Anda tetap tersembunyi, bahkan di balik VPN.
6. **Perlindungan zona waktu di worker**: mencakup worker dan saat halaman mulai dimuat, dengan opsi Perlindungan zona waktu instan sejak skrip pertama halaman.
7. **Anti-sidik jari**: semua sinyal tetap konsisten dan lolos dari pemeriksaan yang dijalankan skrip sidik jari sungguhan.
8. **Lokasi per situs**: beri sebuah situs lokasinya sendiri, sementara situs lain tetap memakai lokasi utama Anda.
9. **Filter**: pilih Semua situs, Daftar izin, atau Daftar blokir untuk menentukan di mana GeoSpoof bekerja.
10. **Tanpa akun, tanpa pelacakan, tanpa analitik**: semuanya tetap di perangkat Anda.

**📍 Atur lokasi palsu sesuai keinginan Anda**

- Cari berdasarkan kota atau alamat dan langsung tiba di titik yang tepat.
- Masukkan lintang dan bujur secara manual untuk posisi GPS yang bersih.
- Atur akurasi, dari yang realistis hingga nilai meter khusus.
- Simpan hingga 50 tempat favorit dan beralih di antaranya dengan sekali ketuk.
- **Pengaturan**, di ikon roda gigi ⚙, kini menampilkan dulu apa yang dilihat situs, dengan opsi Lanjutan dan Umum di bawahnya.

**🎲 Acak lokasi**

Situs bisa menerima titik acak di dekat lokasi yang Anda pilih, bukan titik persisnya: dalam radius 0,5 km, 2 km, atau 10 km. Pertahankan titik yang sama, atau pilih titik baru setiap sesi peramban, setiap jam, atau setiap hari.

Titik tersebut selalu diambil di sekitar lokasi yang Anda pilih di GeoSpoof, tidak pernah di sekitar lokasi asli Anda, dan zona waktu tetap mengikuti lokasi pilihan Anda. Satu hal yang perlu diketahui: titik yang berubah-ubah lebih sulit dikenali dari kunjungan ke kunjungan, tetapi situs yang mengumpulkan beberapa titik bisa merata-ratakannya.

**🧭 Tentukan di mana GeoSpoof bekerja, situs demi situs**

Tab **Situs** yang didesain ulang menampilkan situs yang sedang Anda buka dan lokasi yang dilihatnya, dengan satu tombol untuk menambahkannya ke daftar atau menghapusnya.

- **Filter**: di Mode filter, pilih Semua situs, **Daftar izin** (hanya situs di daftar Anda), atau **Daftar blokir** (semua situs kecuali yang ada di daftar Anda).
- **Lokasi per situs**: Twitch bisa melihat Mexico City dan ChatGPT melihat Dublin, sementara semua situs lain melihat Tokyo. Jika beberapa entri cocok, entri yang paling spesifik yang dipakai.
- **Grup situs**: satu entri mencakup semua domain yang dipakai sebuah layanan, seperti Google, Netflix, atau OpenAI, atau sebuah wilayah seperti Situs Tiongkok. Sekitar 1.500 grup berasal dari [daftar domain v2fly](https://github.com/v2fly/domain-list-community) yang oleh alat proxy disebut `geosite`, dan GeoSpoof memperbaruinya kira-kira seminggu sekali.
- **Hanya alamat persis**: cocok dengan `mail.example.com` dan tidak dengan subdomainnya.
- **Daftar dari tautan**: tempelkan tautan `https://` ke daftar domain yang sudah Anda pakai untuk proxy. GeoSpoof mengunduhnya dan memperbaruinya setiap minggu.

Grup situs, alamat persis, dan daftar dari tautan berfungsi baik di Filter maupun di Lokasi per situs.

**🌍 Palsukan geolokasi dengan atau tanpa VPN**

VPN mengubah IP Anda. GeoSpoof menulis ulang koordinat yang dilaporkan peramban melalui API geolokasi, dan bisa menyinkronkan keduanya.

Gunakan sendiri, atau padukan dengan VPN agar IP, lokasi, dan zona waktu Anda menceritakan hal yang sama.

**🔒 Privasi nomor satu**

- Semuanya berjalan di perangkat Anda: GeoSpoof tidak pernah mengirim lokasi asli Anda ke server.
- Tanpa akun, tanpa pelacakan, tanpa analitik. Pengaturan disimpan secara lokal.
- Filter dan lokasi per situs Anda tidak pernah meninggalkan perangkat. Pembaruan grup situs mengunduh seluruh katalog, jadi tidak ada permintaan yang mengungkap grup mana yang Anda pilih.
- Daftar dari tautan diunduh langsung dari situs yang menyimpannya, dan situs itu melihat alamat IP Anda, sama seperti unduhan lainnya.
- _Sumber terbuka_: periksa sendiri di [GitHub](https://github.com/GeoSpoof/geospoof) apa saja yang dilakukannya.
- Matikan perlindungan, dan koordinat asli Anda kembali tanpa perubahan.

**💡 Untuk siapa**

- Orang yang peduli privasi dan tidak ingin situs mencatat di mana mereka berada.
- Pengembang yang menguji fitur lokasi, zona waktu, dan wilayah.
- Siapa saja yang ingin mengakses konten dan layanan khusus wilayah tertentu.
- Pengguna VPN yang ingin lokasi peramban sesuai dengan node keluarnya.

**❓ Tanya jawab**

📌 **Apakah situs masih akan melihat lokasi asli saya?** Tidak. Selama perlindungan aktif, peramban mengembalikan tempat yang Anda pilih.

📌 **Apakah ini VPN?** Bukan. GeoSpoof mengubah koordinat yang dilaporkan peramban, bukan IP Anda. Ekstensi ini sangat cocok dipadukan dengan VPN dan bahkan bisa tersinkron otomatis dengannya.

📌 **Bisakah saya menetapkan titik yang tepat?** Bisa. Masukkan lintang dan bujur yang tepat, atau cari sebuah kota, untuk memalsukan GPS dengan bersih.

📌 **Apakah zona waktu saya juga berubah?** Ya. GeoSpoof memalsukan zona waktu bersama lokasi Anda sehingga keduanya selalu cocok, celah yang sering terlewat oleh alat yang hanya mengubah lokasi.

📌 **Apakah ini hanya pengubah lokasi?** Ini pengubah lokasi dan lebih dari itu. GeoSpoof menetapkan lokasi palsu, lalu juga menyesuaikan zona waktu dan memblokir kebocoran WebRTC agar tidak ada yang bertentangan dengannya.

📌 **Apakah berfungsi di Google Maps?** Ya. GeoSpoof berfungsi di situs mana pun yang memakai API geolokasi peramban.

📌 **Apakah data saya aman?** Ya. GeoSpoof berjalan secara lokal, tidak mengumpulkan apa pun, dan bersumber terbuka. Tidak ada informasi tentang lokasi Anda yang meninggalkan perangkat.

📌 **Apakah lokasi per situs mengubah IP atau wilayah akun saya?** Tidak. Fitur ini mengubah apa yang dibaca halaman situs itu dari peramban Anda: lokasi, zona waktu, dan bahasa jika Anda mengaturnya agar mengikuti lokasi. IP dan data akun Anda tetap sama, jadi untuk hasil yang paling konsisten, padukan dengan titik keluar VPN di tempat yang sama.

📌 **Bisakah situs tahu bahwa saya memakai GeoSpoof?** Kemungkinan itu tidak bisa dihilangkan sepenuhnya. GeoSpoof lolos dari pemeriksaan yang dijalankan skrip sidik jari sungguhan dan menjaga semua sinyal tetap konsisten, tetapi tidak ada ekstensi yang bisa menghapus semua jejak: mekanisme internal mesin dan saluran samping berbasis waktu berada di luar jangkauannya. Periksa sendiri di [geospoof.com/test](https://geospoof.com/test).

📌 **Apakah saya perlu mendaftar?** Tanpa akun dan tanpa pengaturan awal. Pasang dan langsung ubah lokasi Anda.

**📲 Kini juga tersedia di iPhone, iPad, dan Mac.**

Lokasi per situs, grup situs, dan Acak lokasi gratis di Firefox. Di Safari, Filter, Lokasi per situs, dan Acak lokasi termasuk GeoSpoof Pro, sedangkan grup situs, alamat persis, dan daftar dari tautan belum tersedia.

Pasang GeoSpoof, atur lokasi palsu, dan tentukan sendiri apa yang dilihat web tentang keberadaan Anda.

Tautan:

- [geospoof.com](https://geospoof.com)
- [GitHub](https://github.com/GeoSpoof/geospoof)
