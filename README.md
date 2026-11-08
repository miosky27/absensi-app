# Aplikasi Absensi Karyawan

Absen dengan foto + lokasi GPS + waktu otomatis. Admin bisa lihat laporan harian dan rekap bulanan.

## Kenapa bukan "link Claude" langsung?

Fitur kamera & GPS **tidak bisa** diakses dari halaman yang dihosting di dalam Claude (dibatasi
oleh browser untuk keamanan). Supaya karyawan bisa absen beneran dengan GPS asli, aplikasi ini
harus di-hosting sebagai website biasa (butuh HTTPS). Setelah online, siapa pun — tanpa akun
Claude — bisa buka link itu dari Android/iOS seperti website biasa, dan bisa di-"Add to Home
Screen" supaya terasa seperti aplikasi.

## Cara deploy (gratis, ~5 menit, tanpa kartu kredit) — Render.com

1. Buat akun di https://render.com (bisa pakai akun Google).
2. Upload folder ini ke GitHub (atau saya bisa bantu buatkan repo-nya).
3. Di Render: **New +** → **Web Service** → hubungkan repo GitHub tadi.
4. Build Command: (kosongkan)
5. Start Command: `node server.js`
6. Klik **Create Web Service**. Tunggu ~2 menit sampai status "Live".
7. Anda akan dapat link seperti `https://absensi-xxxx.onrender.com` — itulah link siap pakai untuk
   karyawan Anda.

Alternatif: Railway.app, Fly.io, atau VPS apa pun yang Anda punya — tinggal `node server.js`.

## Setelah online

1. Buka `https://<link-anda>/admin.html`, login dengan password default **admin123** (segera
   ganti di tab Pengaturan).
2. Di tab **Pengaturan**: masukkan koordinat kantor (ambil dari Google Maps), radius absen
   (default 10 meter — lihat catatan akurasi GPS di bawah), dan daftar nomor telepon karyawan +
   nama.
3. Bagikan link utama (`https://<link-anda>/`) ke karyawan.

## Catatan penting soal radius 10 meter

GPS ponsel biasanya punya akurasi 5–20 meter, bisa lebih buruk di dalam gedung/dekat gedung
tinggi. Dengan radius 10 meter, absen yang sebenarnya valid bisa saja tetap tercatat "di luar
radius" karena galat GPS, bukan karena karyawan benar-benar di luar kantor. Aplikasi ini tidak
menolak absen tersebut — tetap tercatat beserta jarak sebenarnya (misal "35m") supaya Anda bisa
menilai sendiri di laporan. Kalau terlalu banyak false alarm, radius bisa diperbesar (misalnya ke
30–50 meter) di tab Pengaturan.

## Soal laporan otomatis ke email

Server ini punya endpoint `/api/records` dan `/api/summary` (butuh password admin) yang bisa
dipanggil otomatis setiap hari/bulan untuk membuat ringkasan. Setelah aplikasi online, saya bisa
bantu menjadwalkan pengiriman ringkasannya ke email Anda secara otomatis.

## Struktur data

- `data/config.json` — konfigurasi (lokasi kantor, radius, daftar karyawan, password admin)
- `data/records.json` — semua catatan absen
- `data/photos/` — foto-foto absen (nama file = ID record)

Backup berkala folder `data/` disarankan kalau hosting tidak punya disk persisten (beberapa free
tier hosting menghapus disk saat restart — kalau mau data permanen, pastikan pilih plan dengan
"persistent disk", atau beri tahu saya untuk saya ganti ke penyimpanan cloud).
