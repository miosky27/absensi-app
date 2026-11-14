// Aplikasi Absensi Karyawan — server ringan tanpa dependensi eksternal
// Jalankan: node server.js
// Env opsional: PORT, ADMIN_PASSWORD, DATA_DIR (lokasi penyimpanan data persisten,
// contoh di Render: /var/data jika sudah pasang Persistent Disk dengan mount path tersebut)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR
  ? process.env.DATA_DIR
  : path.join(ROOT, 'data');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const EMPLOYEE_PHOTOS_DIR = path.join(DATA_DIR, 'employee-photos');
const PUBLIC_DIR = path.join(ROOT, 'public');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LEAVES_FILE = path.join(DATA_DIR, 'leaves.json'); // pengajuan izin/cuti
const KASBON_FILE = path.join(DATA_DIR, 'kasbon.json'); // pinjaman karyawan
const KASBON_PAYMENTS_FILE = path.join(DATA_DIR, 'kasbon_payments.json'); // cicilan/pelunasan kasbon
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json'); // pemberitahuan untuk karyawan (status cuti/kasbon dll)
const ADMIN_NOTIFICATIONS_FILE = path.join(DATA_DIR, 'admin_notifications.json'); // pemberitahuan untuk admin (pengajuan cuti/kasbon baru)
const JADWAL_FILE = path.join(DATA_DIR, 'jadwal.json'); // jadwal kerja bulanan (hasil upload Excel + status bagikan)
ensureFile(JADWAL_FILE, {});
const PAYROLL_LOCKS_FILE = path.join(DATA_DIR, 'payroll_locks.json'); // periode gaji yang sudah dikunci + hasil hitungannya
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const FAILED_ATTEMPTS_FILE = path.join(DATA_DIR, 'failed_attempts.json'); // percobaan absen yang gagal (ditolak server atau GPS/kamera di HP) // sesi login admin (hash token + masa berlaku)

const PORT = process.env.PORT || 3000;

// ---------- Util: storage sederhana berbasis file JSON ----------
function ensureFile(file, defaultValue) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(defaultValue, null, 2));
}
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
if (!fs.existsSync(EMPLOYEE_PHOTOS_DIR)) fs.mkdirSync(EMPLOYEE_PHOTOS_DIR, { recursive: true });
ensureFile(RECORDS_FILE, []);
ensureFile(LEAVES_FILE, []);
ensureFile(KASBON_FILE, []);
ensureFile(KASBON_PAYMENTS_FILE, []);
ensureFile(NOTIFICATIONS_FILE, []);
ensureFile(ADMIN_NOTIFICATIONS_FILE, []);
ensureFile(FAILED_ATTEMPTS_FILE, []);
ensureFile(PAYROLL_LOCKS_FILE, []);
ensureFile(SESSIONS_FILE, []);
ensureFile(CONFIG_FILE, {
  // Beberapa lokasi kantor/cabang, masing-masing punya daftar shift sendiri.
  // Karyawan memilih sendiri shift yang mereka jalani saat absen masuk.
  locations: [
    {
      name: "Yogya Jatibarang",
      lat: -6.200000, lng: 108.316666, radiusMeters: 10, maxDistanceMeters: 50,
      shifts: [
        { name: "Shift 1", startTime: "08:30", endTime: "16:30" },
        { name: "Shift 2", startTime: "12:30", endTime: "20:30" },
        { name: "Full Day", startTime: "08:30", endTime: "20:30" },
      ],
    },
    {
      name: "Yomart Karangampel",
      lat: -6.400000, lng: 108.416666, radiusMeters: 10, maxDistanceMeters: 50,
      shifts: [
        { name: "Shift 1", startTime: "07:30", endTime: "15:30" },
      ],
    },
  ],
  // Daftar karyawan: login memakai nomor telepon
  employees: [
    { phone: "081234567890", name: "Contoh Karyawan 1", namaDepan: "Contoh", namaBelakang: "Karyawan 1", idNumber: "", position: "", email: "", tanggalMasuk: "", status: "aktif", photoFilename: null, gajiPokok: 0, upahLemburPerJam: 0 },
    { phone: "081234567891", name: "Contoh Karyawan 2", namaDepan: "Contoh", namaBelakang: "Karyawan 2", idNumber: "", position: "", email: "", tanggalMasuk: "", status: "aktif", photoFilename: null, gajiPokok: 0, upahLemburPerJam: 0 },
  ],
  adminPassword: process.env.ADMIN_PASSWORD || "admin123",
  adminEmail: process.env.ADMIN_EMAIL || "f.yazid27@gmail.com",
  workStartTime: "08:00", // fallback kalau record lama tidak punya data shift
  reportEmail: "f.yazid27@gmail.com",
  // ---- Pengaturan perhitungan gaji ----
  uangMakanPerHari: 7000, // per hari masuk
  uangTransportPerHari: 5000, // per hari masuk
  jatahOffPerPeriode: 5, // hari tidak hadir yang masih ditoleransi per periode gajian
  pengaliPotonganOff: 2, // OFF melebihi jatah dipotong (gaji harian x pengali ini)
  toleransiTerlambatMenit: 15, // menit toleransi sebelum dianggap terlambat
  maksTerlambatUntukKerajinan: 2, // lebih dari ini dalam 1 periode, bonus kerajinan hangus
});

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Migrasi otomatis dari skema lama ke skema baru, supaya config.json yang
// sudah ada (dari deploy sebelumnya) tidak rusak.
function migrateConfig(config) {
  if (!config.locations && typeof config.officeLat === 'number') {
    config.locations = [
      { name: 'Kantor', lat: config.officeLat, lng: config.officeLng, radiusMeters: config.radiusMeters || 10, shifts: [] },
    ];
    delete config.officeLat;
    delete config.officeLng;
    delete config.radiusMeters;
  }
  if (!Array.isArray(config.locations)) config.locations = [];
  // Lokasi lama (sebelum fitur shift) belum punya field shifts.
  let changed = false;
  for (const loc of config.locations) {
    if (!Array.isArray(loc.shifts)) { loc.shifts = []; changed = true; }
    // Batas jarak maksimal (Task #38): lebih dari ini, absen DITOLAK (bukan cuma ditandai).
    if (loc.maxDistanceMeters === undefined) { loc.maxDistanceMeters = 50; changed = true; }
  }
  // Kode shift jadwal per jabatan (kunci = nama jabatan huruf kecil). Jabatan tanpa entri memakai kode default.
  if (!config.jadwalKodeShift || typeof config.jadwalKodeShift !== 'object') {
    config.jadwalKodeShift = { packing: { FL: { label: 'Full', jam: '05:00-17:00' } } };
    changed = true;
  }
  // Karyawan lama (sebelum fitur foto/No ID/jabatan) belum punya field-field ini.
  if (!Array.isArray(config.employees)) config.employees = [];
  for (const emp of config.employees) {
    if (emp.idNumber === undefined) { emp.idNumber = ''; changed = true; }
    if (emp.position === undefined) { emp.position = ''; changed = true; }
    if (emp.lokasiKerja === undefined) { emp.lokasiKerja = ''; changed = true; }
    if (emp.photoFilename === undefined) { emp.photoFilename = null; changed = true; }
    if (emp.gajiPokok === undefined) { emp.gajiPokok = 0; changed = true; }
    if (emp.upahLemburPerJam === undefined) { emp.upahLemburPerJam = 0; changed = true; }
    if (emp.tunjanganFungsional === undefined) { emp.tunjanganFungsional = 0; changed = true; }
    if (emp.tunjanganNatura === undefined) { emp.tunjanganNatura = 0; changed = true; }
    if (emp.dapatUangMakan === undefined) { emp.dapatUangMakan = true; changed = true; }
    if (emp.dapatTunjanganNatura === undefined) { emp.dapatTunjanganNatura = true; changed = true; }
    if (emp.dapatKerajinan === undefined) { emp.dapatKerajinan = true; changed = true; }
    if (emp.email === undefined) { emp.email = ''; changed = true; }
    if (emp.tanggalMasuk === undefined) { emp.tanggalMasuk = ''; changed = true; }
    if (emp.status === undefined) { emp.status = 'aktif'; changed = true; }
    if (emp.namaDepan === undefined || emp.namaBelakang === undefined) {
      const parts = String(emp.name || '').trim().split(/\s+/);
      emp.namaDepan = parts[0] || '';
      emp.namaBelakang = parts.slice(1).join(' ');
      changed = true;
    }
  }
  // Pengaturan gaji lama (sebelum fitur perhitungan gaji) belum punya field-field ini.
  const gajiDefaults = {
    uangMakanPerHari: 7000,
    uangTransportPerHari: 5000,
    jatahOffPerPeriode: 5,
    pengaliPotonganOff: 2,
    toleransiTerlambatMenit: 15,
    maksTerlambatUntukKerajinan: 2,
  };
  for (const key of Object.keys(gajiDefaults)) {
    if (config[key] === undefined) { config[key] = gajiDefaults[key]; changed = true; }
  }
  // Config lama (sebelum login admin pakai email) belum punya field ini.
  if (config.adminEmail === undefined) { config.adminEmail = "f.yazid27@gmail.com"; changed = true; }
  if (changed || typeof config.officeLat === 'number') writeJSON(CONFIG_FILE, config);
  return config;
}

// ---------- Parser CSV sederhana (tanpa dependensi eksternal) ----------
// Mendukung koma sebagai pemisah dan tanda kutip ganda untuk teks yang mengandung koma.
const { unzipEntries, xmlDecode, readSheetCells } = require('./lib/xlsx-read');
const { parseJadwalXlsx, jadwalUntukKaryawan, buatTemplateJadwal, normalizeName: normalizeNamaJadwal, WEEKDAY_NAMES, SHIFT_CODES } = require('./lib/jadwal');

// Jadwal disimpan per bulan + jabatan + lokasi kerja. Jadwal lama (tanpa jabatan dan lokasi) tetap memakai kunci bulan saja.
function normGrupJadwal(v) { return String(v || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
function kunciJadwal(month, jabatan, lokasi) {
  const j = normGrupJadwal(jabatan), l = normGrupJadwal(lokasi);
  return (j || l) ? `${month}|${j}|${l}` : month;
}
// Gabungkan jadwal lama dengan upload baru untuk grup yang sama. Hari yang sama dari upload baru menggantikan yang lama.
function gabungRowsJadwal(lama, baru) {
  const map = new Map();
  for (const r of lama) map.set(normGrupJadwal(r.name), { ...r, days: { ...r.days } });
  for (const r of baru) {
    const k = normGrupJadwal(r.name);
    const ada = map.get(k);
    if (ada) { ada.name = r.name; ada.days = { ...ada.days, ...r.days }; }
    else map.set(k, { ...r, days: { ...r.days } });
  }
  return [...map.values()];
}
// Kunci kode shift: "jabatan|lokasi" (paling spesifik), "jabatan" saja, atau "" (default).
function kunciKodeShift(jabatan, lokasi) {
  const j = normGrupJadwal(jabatan), l = normGrupJadwal(lokasi);
  return j && l ? j + '|' + l : j;
}
// Urutan pencarian: jabatan+lokasi -> jabatan -> default. Mengembalikan kode dan sumbernya.
function kodeShiftUntuk(config, jabatan, lokasi) {
  const semua = config.jadwalKodeShift || {};
  const j = normGrupJadwal(jabatan), l = normGrupJadwal(lokasi);
  const kandidat = [];
  if (j && l) kandidat.push([j + '|' + l, 'jabatan-lokasi']);
  if (j) kandidat.push([j, 'jabatan']);
  kandidat.push(['', 'default']);
  for (const [k, sumber] of kandidat) {
    if (semua[k] && Object.keys(semua[k]).length) return { kode: semua[k], sumber };
  }
  return { kode: SHIFT_CODES, sumber: 'bawaan' };
}
function kodeShiftJabatan(config, jabatan, lokasi) { return kodeShiftUntuk(config, jabatan, lokasi).kode; }
function cocokGrupJadwal(emp, jabatan, lokasi) {
  return (!normGrupJadwal(jabatan) || normGrupJadwal(emp.position) === normGrupJadwal(jabatan))
    && (!normGrupJadwal(lokasi) || normGrupJadwal(emp.lokasiKerja) === normGrupJadwal(lokasi));
}
function parseXlsxRows(buf) {
  const files = unzipEntries(buf);
  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    const xml = files['xl/sharedStrings.xml'].toString('utf8');
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(xmlDecode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
    }
  }
  const sheetName = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) throw new Error('Sheet tidak ditemukan di file Excel');
  const xml = files[sheetName].toString('utf8');
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
      const type = (attrs.match(/t="([^"]+)"/) || [])[1];
      const inner = cm[2] || '';
      let val = '';
      if (type === 's') val = shared[Number((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1])] || '';
      else if (type === 'inlineStr') val = xmlDecode([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
      else val = xmlDecode((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '');
      let col = row.length;
      if (ref) { col = 0; for (const ch of ref) col = col * 26 + (ch.charCodeAt(0) - 64); col -= 1; }
      while (row.length < col) row.push('');
      row[col] = val;
    }
    if (row.some((v) => String(v).trim() !== '')) rows.push(row);
  }
  return rows;
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  const clean = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n') {
      pushRow();
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => r.some((f) => String(f).trim() !== ''));
}

// Cari shift berdasarkan nama di dalam sebuah lokasi.
function findShift(location, shiftName) {
  if (!location || !location.shifts) return null;
  return location.shifts.find((s) => s.name === shiftName) || null;
}

// ---------- Lembur ----------
// Jam kerja standar sebelum dihitung lembur.
const JAM_KERJA_STANDAR_MENIT = 8 * 60;

function timeToMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

// Mengelompokkan records per (karyawan, tanggal), ambil jam masuk paling awal
// dan jam keluar paling akhir, lalu hitung lembur = (pulang - masuk) - 8 jam.
// Mengembalikan Map: "nama|tanggal" -> menit lembur (0 jika tidak lembur atau data tidak lengkap).
// Lembur per karyawan per tanggal, dihitung SAMA dengan slip gaji: lembur awal & akhir
// dibandingkan jadwal shift yang dipilih, plus lembur tambahan (tombol Lembur Masuk/Pulang).
// Hasil per key "employee|date" = { awal, akhir, tambahan } dalam menit; jam ditampilkan lewat
// totalLemburJam() supaya pembulatan bertingkatnya identik dengan slip gaji.
function computeLemburByEmployeeDate(records, config) {
  const daily = computePayrollDailyByEmployeeDate(records, (config && config.toleransiTerlambatMenit) || 0, config);
  const tambahan = computeLemburTambahanByEmployeeDate(records);
  const result = {};
  for (const k of Object.keys(daily)) result[k] = { awal: daily[k].lemburAwalMenit, akhir: daily[k].lemburAkhirMenit, tambahan: 0 };
  for (const k of Object.keys(tambahan)) {
    if (!result[k]) result[k] = { awal: 0, akhir: 0, tambahan: 0 };
    result[k].tambahan += tambahan[k];
  }
  return result;
}
function emptyLemburParts() { return { awal: 0, akhir: 0, tambahan: 0 }; }
function addLemburParts(acc, p) { acc.awal += p.awal; acc.akhir += p.akhir; acc.tambahan += p.tambahan; return acc; }
function totalLemburJam(p) { return roundJamBertingkat(p.awal) + roundJamBertingkat(p.akhir) + roundJamBertingkat(p.tambahan); }

// Lembur eksplisit (tombol "Lembur Masuk"/"Lembur Pulang"): di luar jadwal shift, tanpa
// potongan jam kerja standar — seluruh durasi antara Lembur Masuk dan Lembur Pulang dihitung
// sebagai jam lembur. Mengembalikan Map: "nama|tanggal" -> menit lembur tambahan.
function computeLemburTambahanByEmployeeDate(records) {
  const grouped = {};
  for (const r of records) {
    const key = r.employee + '|' + r.dateKey;
    if (!grouped[key]) grouped[key] = { masuk: null, keluar: null };
    const menit = timeToMinutes(r.timeHHMM);
    if (r.type === 'lembur_masuk') {
      if (grouped[key].masuk === null || menit < grouped[key].masuk) grouped[key].masuk = menit;
    } else if (r.type === 'lembur_keluar') {
      if (grouped[key].keluar === null || menit > grouped[key].keluar) grouped[key].keluar = menit;
    }
  }
  const result = {};
  for (const key of Object.keys(grouped)) {
    const { masuk, keluar } = grouped[key];
    result[key] = (masuk !== null && keluar !== null && keluar > masuk) ? (keluar - masuk) : 0;
  }
  return result;
}

// ---------- Perhitungan gaji (metode JADWAL: dibandingkan ke jam shift resmi) ----------
// Untuk tiap (karyawan, tanggal): shift acuan diambil dari record MASUK (karyawan memilih shift
// saat absen masuk). Dari situ dihitung:
// - lemburAwalMenit: datang sebelum jam shift mulai
// - terlambatMenit : datang sesudah jam shift mulai, dikurangi toleransi
// - lemburAkhirMenit: pulang sesudah jam shift selesai
// - pulangCepatMenit: pulang sebelum jam shift selesai (hanya jika ada record keluar hari itu)
function computePayrollDailyByEmployeeDate(records, toleransiMenit, config) {
  const grouped = {}; // key: employee|date -> { masuk, keluar, shiftStart, shiftEnd }
  for (const r of records) {
    const key = r.employee + '|' + r.dateKey;
    if (!grouped[key]) grouped[key] = { masuk: null, keluar: null, shiftStart: null, shiftEnd: null, keluarLoc: null };
    const g = grouped[key];
    if (r.type === 'masuk') {
      g.masuk = timeToMinutes(r.timeHHMM);
      if (r.shiftStart) g.shiftStart = timeToMinutes(r.shiftStart);
      if (r.shiftEnd) g.shiftEnd = timeToMinutes(r.shiftEnd);
    } else if (r.type === 'keluar') {
      g.keluar = timeToMinutes(r.timeHHMM);
      g.keluarLoc = r.nearestLocation || null;
    }
  }
  // Fallback jadwal shift standar (08:00 + 8 jam kerja) dipakai kalau record tidak punya
  // shiftStart/shiftEnd sendiri — misalnya absen yang di-input manual oleh admin (tombol
  // "+ Isi" di menu Absensi), yang tidak melalui pemilihan shift seperti absen GPS biasa.
  // Tanpa fallback ini, jam lembur/pulang-cepat tidak pernah terhitung untuk absen manual.
  const fallbackShiftStart = timeToMinutes((config && config.workStartTime) || '08:00');
  const fallbackShiftEnd = fallbackShiftStart + JAM_KERJA_STANDAR_MENIT;
  const result = {};
  for (const key of Object.keys(grouped)) {
    const g = grouped[key];
    // Lupa absen masuk (cuma ada absen pulang): absen pulang tidak menyimpan shift, jadi shift
    // ditebak dari lokasi absen pulang -- shift di lokasi itu yang jam pulangnya paling dekat.
    if (g.masuk === null && g.keluar !== null && g.shiftStart === null) {
      const inferred = inferShiftFromKeluar(g.keluarLoc, g.keluar, config);
      if (inferred) { g.shiftStart = inferred.start; g.shiftEnd = inferred.end; }
    }
    const shiftStart = g.shiftStart !== null ? g.shiftStart : fallbackShiftStart;
    const shiftEnd = g.shiftEnd !== null ? g.shiftEnd : fallbackShiftEnd;
    // Aturan alpa: karyawan dianggap HADIR kalau ada absen masuk ATAU absen pulang. Kalau cuma
    // salah satu, itu "lupa absen": hadir penuh tanpa potongan, jam yang kosong dianggap sama
    // dengan jadwal shift (jadi tidak menimbulkan lembur, terlambat, atau pulang cepat).
    const out = {
      lemburAwalMenit: 0, terlambatMenit: 0, lemburAkhirMenit: 0, pulangCepatMenit: 0,
      hadir: g.masuk !== null || g.keluar !== null,
      lupaMasuk: g.masuk === null && g.keluar !== null,
      lupaPulang: g.masuk !== null && g.keluar === null,
    };
    if (g.masuk !== null) {
      if (g.masuk < shiftStart) out.lemburAwalMenit = shiftStart - g.masuk;
      else if (g.masuk > shiftStart + toleransiMenit) out.terlambatMenit = g.masuk - shiftStart;
    }
    if (g.keluar !== null) {
      if (g.keluar > shiftEnd) out.lemburAkhirMenit = g.keluar - shiftEnd;
      else if (g.keluar < shiftEnd) out.pulangCepatMenit = shiftEnd - g.keluar;
    }
    result[key] = out;
  }
  return result;
}

// Absen masuk dianggap terlambat kalau lewat dari jam mulai shift + toleransi.
function isLateMasuk(r, config) {
  const start = timeToMinutes(r.shiftStart || config.workStartTime || '08:00');
  const t = timeToMinutes(r.timeHHMM);
  if (start === null || t === null) return false;
  return t > start + (config.toleransiTerlambatMenit ?? 15);
}

// Tebak shift untuk hari yang cuma punya absen pulang (lupa absen masuk): ambil shift di lokasi
// absen pulang yang jam pulangnya paling dekat dengan jam absen pulang karyawan.
function inferShiftFromKeluar(locName, keluarMenit, config) {
  const loc = ((config && config.locations) || []).find((l) => l.name === locName);
  if (!loc || !loc.shifts || loc.shifts.length === 0) return null;
  let best = null;
  for (const sh of loc.shifts) {
    const end = timeToMinutes(sh.endTime);
    const diff = Math.abs(end - keluarMenit);
    if (!best || diff < best.diff) best = { diff, start: timeToMinutes(sh.startTime), end, name: sh.name, startTime: sh.startTime, endTime: sh.endTime };
  }
  return best;
}

// Total menit bekerja (shift biasa + lembur tambahan) per karyawan per tanggal.
// Dipakai untuk cek aturan "potongan keterlambatan tidak berlaku kalau H-1 kerja >= 12 jam".
function computeWorkedMinutesByEmployeeDate(records) {
  const grouped = {};
  for (const r of records) {
    const key = r.employee + '|' + r.dateKey;
    if (!grouped[key]) grouped[key] = { masuk: null, keluar: null, lemburMasuk: null, lemburKeluar: null };
    const g = grouped[key];
    const menit = timeToMinutes(r.timeHHMM);
    if (r.type === 'masuk') { if (g.masuk === null || menit < g.masuk) g.masuk = menit; }
    else if (r.type === 'keluar') { if (g.keluar === null || menit > g.keluar) g.keluar = menit; }
    else if (r.type === 'lembur_masuk') { if (g.lemburMasuk === null || menit < g.lemburMasuk) g.lemburMasuk = menit; }
    else if (r.type === 'lembur_keluar') { if (g.lemburKeluar === null || menit > g.lemburKeluar) g.lemburKeluar = menit; }
  }
  const result = {};
  for (const key of Object.keys(grouped)) {
    const g = grouped[key];
    let total = 0;
    if (g.masuk !== null && g.keluar !== null && g.keluar > g.masuk) total += (g.keluar - g.masuk);
    if (g.lemburMasuk !== null && g.lemburKeluar !== null && g.lemburKeluar > g.lemburMasuk) total += (g.lemburKeluar - g.lemburMasuk);
    result[key] = total;
  }
  return result;
}

function shiftDateKey(dateKey, deltaDays) {
  const d = new Date(dateKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// Validasi input izin/cuti dari admin. Mengembalikan pesan error, atau null jika valid.
function validasiLeaveAdmin(body, config) {
  const TIPE = ['sakit', 'cuti', 'izin'];
  const STATUS = ['approved', 'pending', 'rejected'];
  const YMD = /^\d{4}-\d{2}-\d{2}$/;
  if (!config.employees.some((e) => e.phone === String(body.phone || '').trim())) return 'Karyawan tidak terdaftar.';
  if (!TIPE.includes(body.type)) return 'Jenis tidak valid.';
  if (!YMD.test(body.startDate || '') || !YMD.test(body.endDate || '')) return 'Tanggal mulai dan selesai wajib diisi.';
  if (body.endDate < body.startDate) return 'Tanggal selesai tidak boleh sebelum tanggal mulai.';
  if (body.status && !STATUS.includes(body.status)) return 'Status tidak valid.';
  return null;
}

// Daftar tanggal (urut naik) dalam periode [from, to] di mana karyawan tidak hadir dan
// tidak sedang cuti/izin yang disetujui. Dipakai untuk aturan potongan alpa (Task #37):
// hari tidak masuk yang jatuh SEBELUM tanggal masuk kerja karyawan hanya kena 1x upah harian.
function computeAbsentDates(employeeName, from, to, presentDateSet, leaves) {
  const dates = [];
  let cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  const leaveSet = new Set();
  for (const l of leaves) {
    if (l.employee !== employeeName || l.status !== 'approved') continue;
    const start = l.startDate > from ? l.startDate : from;
    const end2 = l.endDate < to ? l.endDate : to;
    if (start > end2) continue;
    let d2 = new Date(start + 'T00:00:00Z');
    const endD2 = new Date(end2 + 'T00:00:00Z');
    while (d2 <= endD2) { leaveSet.add(d2.toISOString().slice(0, 10)); d2.setUTCDate(d2.getUTCDate() + 1); }
  }
  return dates.filter((dk) => !presentDateSet.has(dk) && !leaveSet.has(dk));
}

function countDaysInclusive(from, to) {
  const a = new Date(from + 'T00:00:00Z');
  const b = new Date(to + 'T00:00:00Z');
  return Math.round((b - a) / 86400000) + 1;
}

// Periode gajian berjalan: tanggal 26 bulan lalu s.d. tanggal 25 bulan ini (WIB).
function defaultPayrollPeriod() {
  const todayKey = dateKeyJakarta(new Date().toISOString());
  const [y, m, d] = todayKey.split('-').map(Number);
  let toY = y, toM = m;
  if (d < 26) {
    // Sebelum tanggal 26: periode berjalan masih periode sebelumnya (berakhir tanggal 25 bulan ini).
    toY = y; toM = m;
  } else {
    // Tanggal 26 ke atas: periode berjalan berakhir tanggal 25 bulan depan.
    toM = m + 1;
    if (toM > 12) { toM = 1; toY = y + 1; }
  }
  let fromY = toY, fromM = toM - 1;
  if (fromM < 1) { fromM = 12; fromY = toY - 1; }
  const pad = (n) => String(n).padStart(2, '0');
  return {
    from: `${fromY}-${pad(fromM)}-26`,
    to: `${toY}-${pad(toM)}-25`,
  };
}

// Hitung rekap gaji per karyawan untuk satu periode (records sudah difilter ke rentang periode).
// Jumlah hari cuti/izin yang SUDAH DISETUJUI admin, per karyawan, yang beririsan dengan
// periode [from, to]. Hari-hari ini tidak dihitung sebagai "tidak hadir"/OFF di payroll.
function countApprovedLeaveDaysByEmployee(leaves, from, to) {
  const result = {};
  for (const l of leaves) {
    if (l.status !== 'approved') continue;
    const start = l.startDate > from ? l.startDate : from;
    const end = l.endDate < to ? l.endDate : to;
    if (start > end) continue;
    result[l.employee] = (result[l.employee] || 0) + countDaysInclusive(start, end);
  }
  return result;
}

// Total pembayaran/potongan kasbon per karyawan yang jatuh di dalam periode [from, to].
function sumKasbonPaymentsByEmployee(payments, from, to) {
  const result = {};
  for (const p of payments) {
    if (p.tanggal < from || p.tanggal > to) continue;
    result[p.employee] = (result[p.employee] || 0) + p.jumlah;
  }
  return result;
}

// Ledger kasbon satu karyawan untuk periode [from, to] (Task #49/#50): daftar transaksi
// (pinjam + bayar) yang jatuh di periode ini, dengan saldo berjalan (Sisa) yang dihitung
// dari SELURUH histori kasbon karyawan itu - bukan cuma transaksi yang masuk periode -
// supaya saldo tetap nyambung dari bulan-bulan sebelumnya. Dipakai bareng oleh endpoint
// /api/kasbon/export (format .xlsx) dan /api/period-report (data buat laporan email bulanan).
function buildKasbonLedger(phone, from, to, kasbonAll, payments) {
  const empKasbon = kasbonAll.filter((k) => k.phone === phone && (k.status === 'disetujui' || k.status === 'lunas'));
  const kasbonIds = new Set(empKasbon.map((k) => k.id));
  const empPayments = payments.filter((p) => kasbonIds.has(p.kasbonId));
  const jenisByKasbonId = {};
  empKasbon.forEach((k) => { jenisByKasbonId[k.id] = k.jenis; });

  const transaksi = [];
  empKasbon.forEach((k) => transaksi.push({ tanggal: k.tanggal, createdAt: k.createdAt, tipe: 'pinjam', jenis: k.jenis, jumlah: k.jumlah }));
  empPayments.forEach((p) => transaksi.push({ tanggal: p.tanggal, createdAt: p.createdAt, tipe: 'bayar', jenis: jenisByKasbonId[p.kasbonId] || 'cicil', jumlah: p.jumlah }));
  transaksi.sort((a, b) => (a.tanggal + a.createdAt).localeCompare(b.tanggal + b.createdAt));

  let saldo = 0;
  const hasil = [];
  transaksi.forEach((t) => {
    saldo += t.tipe === 'pinjam' ? t.jumlah : -t.jumlah;
    if (t.tanggal < from || t.tanggal > to) return;
    hasil.push({ tanggal: t.tanggal, tipe: t.tipe, jenis: t.jenis, jumlah: t.jumlah, saldoSetelah: Math.max(0, saldo) });
  });
  return hasil;
}

// ---------- Kunci periode gaji ----------
// Periode yang dikunci menyimpan hasil hitungan gajinya saat dikunci, jadi slip periode itu
// tidak berubah lagi walau ada data yang diedit belakangan. Absen di dalam periode terkunci
// juga tidak bisa ditambah/diubah/dihapus sampai kuncinya dibuka.
function findPayrollLock(from, to) {
  return readJSON(PAYROLL_LOCKS_FILE).find((l) => l.from === from && l.to === to) || null;
}
function findLockCoveringDate(dateKey) {
  return readJSON(PAYROLL_LOCKS_FILE).find((l) => dateKey >= l.from && dateKey <= l.to) || null;
}
function getPayrollForPeriod(records, config, from, to) {
  const lock = findPayrollLock(from, to);
  if (lock) return lock.payroll;
  return computePayrollSummary(records, config, from, to);
}

function computePayrollSummary(records, config, from, to) {
  const totalHariPeriode = countDaysInclusive(from, to);
  const toleransi = config.toleransiTerlambatMenit || 0;
  const daily = computePayrollDailyByEmployeeDate(records, toleransi, config);
  const lemburTambahan = computeLemburTambahanByEmployeeDate(records);
  const cutiDisetujui = countApprovedLeaveDaysByEmployee(readJSON(LEAVES_FILE), from, to);
  const sakitDisetujui = countApprovedLeaveDaysByEmployee(readJSON(LEAVES_FILE).filter((l) => l.type === 'sakit'), from, to);
  const izinDisetujui = countApprovedLeaveDaysByEmployee(readJSON(LEAVES_FILE).filter((l) => l.type === 'izin'), from, to);
  const cutiSajaDisetujui = countApprovedLeaveDaysByEmployee(readJSON(LEAVES_FILE).filter((l) => l.type !== 'sakit' && l.type !== 'izin'), from, to);
  const kasbonPotongan = sumKasbonPaymentsByEmployee(readJSON(KASBON_PAYMENTS_FILE), from, to);
  const leaves = readJSON(LEAVES_FILE);
  // Total menit kerja per employee|tanggal, dipakai buat cek "kerja >=12 jam di H-1" (Task #36).
  const workedMinutesMap = computeWorkedMinutesByEmployeeDate(records);

  const makeEmpty = (employee) => ({
    employee, hariHadir: 0, lemburAwalMenit: 0, terlambatMenit: 0, terlambatMenitPotongan: 0, terlambatKali: 0,
    lemburAkhirMenit: 0, pulangCepatMenit: 0, lemburTambahanMenit: 0, presentDates: new Set(), lupaAbsenHari: 0,
  });
  const todayKeyLupa = dateKeyJakarta(new Date().toISOString());

  const byEmployee = {};
  const empByName = {};
  for (const emp of config.employees) empByName[emp.name] = emp;

  for (const key of Object.keys(daily)) {
    const [employee, dateKey] = key.split('|');
    if (!byEmployee[employee]) byEmployee[employee] = makeEmpty(employee);
    const e = byEmployee[employee];
    const d = daily[key];
    if (d.hadir) { e.hariHadir += 1; e.presentDates.add(dateKey); }
    // Lupa pulang di hari ini belum dihitung (karyawan mungkin masih bekerja).
    if (d.lupaMasuk || (d.lupaPulang && dateKey < todayKeyLupa)) e.lupaAbsenHari += 1;
    e.lemburAwalMenit += d.lemburAwalMenit;
    e.lemburAkhirMenit += d.lemburAkhirMenit;
    e.pulangCepatMenit += d.pulangCepatMenit;
    if (d.terlambatMenit > 0) {
      e.terlambatMenit += d.terlambatMenit;
      e.terlambatKali += 1;
      // Task #36: potongan keterlambatan tidak berlaku kalau H-1 karyawan kerja >= 12 jam.
      const prevKey = employee + '|' + shiftDateKey(dateKey, -1);
      const prevWorkedMenit = workedMinutesMap[prevKey] || 0;
      const excusedByOvertimeH1 = prevWorkedMenit >= 12 * 60;
      if (!excusedByOvertimeH1) e.terlambatMenitPotongan += d.terlambatMenit;
    }
  }
  // Jam lembur tambahan (tombol Lembur Masuk/Pulang) bisa ada pada tanggal tanpa absen
  // shift biasa sama sekali, jadi digabung terpisah dari grup `daily` di atas.
  for (const key of Object.keys(lemburTambahan)) {
    const [employee] = key.split('|');
    if (!byEmployee[employee]) byEmployee[employee] = makeEmpty(employee);
    byEmployee[employee].lemburTambahanMenit += lemburTambahan[key];
  }
  // Pastikan semua karyawan terdaftar muncul walau tidak ada record sama sekali di periode ini.
  for (const emp of config.employees) {
    if (!byEmployee[emp.name]) byEmployee[emp.name] = makeEmpty(emp.name);
  }

  const result = Object.values(byEmployee).map((e) => {
    const emp = empByName[e.employee] || {};
    const gajiPokok = Number(emp.gajiPokok) || 0;
    const tunjanganFungsional = Number(emp.tunjanganFungsional) || 0;
    // Tunjangan natura otomatis 10% dari gaji pokok, hanya untuk karyawan yang dicentang
    // "Dapat Tunjangan Natura" (sama seperti pilihan uang makan).
    const tunjanganNatura = emp.dapatTunjanganNatura !== false ? Math.round(gajiPokok * 0.1) : 0;
    const gajiHarian = gajiPokok / 30;
    const upahJam = Number(emp.upahLemburPerJam) > 0 ? Number(emp.upahLemburPerJam) : gajiPokok / 240;

    // Task #37: hari tidak masuk tanpa alasan yang jatuh SEBELUM tanggal masuk kerja karyawan
    // hanya kena potongan 1x upah harian (bukan pengaliPotonganOff / biasanya 2x), karena
    // karyawan memang belum mulai bekerja saat itu.
    // Jangan hitung hari di MASA DEPAN sebagai alpa — kalau periode gajian belum selesai
    // (misal lagi dilihat sebelum tanggal 25), hari yang belum kejalanin bukan alpa.
    const todayKeyForAbsent = dateKeyJakarta(new Date().toISOString());
    const absentTo = to < todayKeyForAbsent ? to : todayKeyForAbsent;
    const absentDates = to < from ? [] : computeAbsentDates(e.employee, from, absentTo, e.presentDates, leaves);
    const hariTidakHadir = absentDates.length;
    const tanggalMasuk = emp.tanggalMasuk || null;
    // Hari alpa sebelum tanggal masuk kerja selalu kena potongan penuh dan TIDAK ikut memakai
    // jatah off gratis -- jatah itu haknya karyawan yang sudah bekerja, bukan buat hari sebelum
    // dia resmi join. Kuota jatah off cuma dipakai buat hari alpa SETELAH tanggal masuk kerja,
    // diambil dulu dari hari2 absen yang PALING AWAL secara kronologis di antara hari2 itu.
    const preJoinAbsentDates = tanggalMasuk ? absentDates.filter((dk) => dk < tanggalMasuk) : [];
    const postJoinAbsentDates = tanggalMasuk ? absentDates.filter((dk) => dk >= tanggalMasuk) : absentDates;
    // Kalau karyawan baru mulai kerja DI TENGAH periode ini, jatah off-nya diprorata dari
    // jumlah hari sejak dia masuk kerja sampai akhir periode -- aturannya 1 kali jatah off
    // per 7 hari kerja (6 hari kerja + 1 hari off), bukan jatah penuh satu periode utuh.
    // Contoh: periode 30 hari, karyawan baru masuk kerja di pertengahan (15 hari sisa periode
    // sejak dia masuk kerja) -> jatahnya cuma 2 (15 hari / 7 = 2,14, dibulatkan ke bawah).
    // Kalau dia sudah bekerja sejak sebelum/sejak awal periode ini, pakai jatah penuh seperti biasa.
    const joinedMidPeriode = !!(tanggalMasuk && tanggalMasuk > from && tanggalMasuk <= to);
    const jatah = joinedMidPeriode
      ? Math.floor(countDaysInclusive(tanggalMasuk, to) / 7)
      : (config.jatahOffPerPeriode || 0);
    const postJoinOverQuota = Math.max(0, postJoinAbsentDates.length - jatah);
    const chargedPostJoinDates = postJoinOverQuota > 0 ? postJoinAbsentDates.slice(postJoinAbsentDates.length - postJoinOverQuota) : [];
    const chargedAbsentDates = [...preJoinAbsentDates, ...chargedPostJoinDates];
    const offBerlebih = chargedAbsentDates.length;
    const hariCuti = cutiDisetujui[e.employee] || 0;
    const potonganKasbon = kasbonPotongan[e.employee] || 0;

    const dapatUangMakan = emp.dapatUangMakan !== false;
    const uangMakan = dapatUangMakan ? e.hariHadir * (config.uangMakanPerHari || 0) : 0;
    const uangTransport = e.hariHadir * (config.uangTransportPerHari || 0);
    const lemburAwalJam = roundJamBertingkat(e.lemburAwalMenit);
    const lemburAkhirJam = roundJamBertingkat(e.lemburAkhirMenit);
    const pulangCepatJam = roundJamBertingkat(e.pulangCepatMenit);
    const terlambatJam = roundJamBertingkat(e.terlambatMenit);
    const terlambatJamPotongan = roundJamBertingkat(e.terlambatMenitPotongan);
    const lemburTambahanJam = roundJamBertingkat(e.lemburTambahanMenit);

    const lemburAwalRp = Math.round(lemburAwalJam * upahJam);
    const lemburAkhirRp = Math.round(lemburAkhirJam * upahJam);
    const lemburTambahanRp = Math.round(lemburTambahanJam * upahJam);
    const totalPendapatan = gajiPokok + tunjanganFungsional + tunjanganNatura + uangMakan + lemburAwalRp + lemburAkhirRp + lemburTambahanRp;

    // Kerajinan = 10% dari total pendapatan, hanya untuk karyawan yang dicentang "Dapat Kerajinan"
    // dan memenuhi syarat (tidak ada OFF berlebih, terlambat tidak lewat batas).
    const dapatKerajinan = emp.dapatKerajinan !== false;
    const kerajinanEligible = dapatKerajinan && offBerlebih === 0 && e.terlambatKali <= (config.maksTerlambatUntukKerajinan ?? 2);
    const kerajinan = kerajinanEligible ? Math.round(totalPendapatan * 0.1) : 0;

    const potonganOff = Math.round(chargedAbsentDates.reduce((sum, dk) => {
      const pengali = (tanggalMasuk && dk < tanggalMasuk) ? 1 : (config.pengaliPotonganOff || 0);
      return sum + gajiHarian * pengali;
    }, 0));
    const potonganTerlambat = Math.round(terlambatJamPotongan * upahJam);
    const potonganPulangCepat = Math.round(pulangCepatJam * upahJam);
    const totalPotongan = potonganOff + potonganTerlambat + potonganPulangCepat + potonganKasbon;

    const gajiBersih = totalPendapatan + kerajinan + uangTransport - totalPotongan;

    return {
      employee: e.employee,
      gajiPokok, tunjanganFungsional, tunjanganNatura, upahPerJam: Math.round(upahJam), dapatKerajinan,
      hariHadir: e.hariHadir, hariCuti, hariTidakHadir, offBerlebih,
      hariSakit: sakitDisetujui[e.employee] || 0, hariIzin: izinDisetujui[e.employee] || 0,
      hariCutiSaja: cutiSajaDisetujui[e.employee] || 0, lupaAbsenHari: e.lupaAbsenHari,
      terlambatKali: e.terlambatKali, terlambatJam, pulangCepatJam, lemburAwalJam, lemburAkhirJam,
      lemburTambahanJam, lemburTambahanRp,
      uangMakan, uangTransport, lemburAwalRp, lemburAkhirRp, totalPendapatan,
      kerajinanEligible, kerajinan,
      potonganOff, potonganTerlambat, potonganPulangCepat, potonganKasbon, totalPotongan,
      gajiBersih,
    };
  });
  return result;
}

// Jarak terpendek ke lokasi mana pun, dan lokasi mana yang terdekat.
function nearestLocation(lat, lng, locations) {
  let best = null;
  for (const loc of locations) {
    const d = distanceMeters(lat, lng, loc.lat, loc.lng);
    if (!best || d < best.distanceMeters) {
      best = {
        name: loc.name,
        distanceMeters: d,
        radiusMeters: loc.radiusMeters,
        maxDistanceMeters: loc.maxDistanceMeters,
        withinRadius: d <= loc.radiusMeters,
        melebihiJarakMaksimal: typeof loc.maxDistanceMeters === 'number' && d > loc.maxDistanceMeters,
        shifts: loc.shifts || [],
      };
    }
  }
  return best;
}

// ---------- Haversine distance (meter) ----------
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ---------- Body parser ----------
function readBody(req, maxBytes = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------- Sesi login admin ----------
// Setiap login membuat token acak baru yang berlaku 7 hari. Yang disimpan di server hanya
// hash token-nya, jadi isi file sesi tidak bisa dipakai untuk login. Logout atau ganti password
// admin mencabut sesi. Disimpan di file supaya admin tidak ter-logout tiap server restart.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function activeSessions() { return readJSON(SESSIONS_FILE).filter((x) => x.expiresAt > Date.now()); }
function createAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = activeSessions();
  sessions.push({ tokenHash: hashToken(token), createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
  writeJSON(SESSIONS_FILE, sessions);
  return token;
}
function isValidAdminToken(token) {
  if (!token) return false;
  const h = hashToken(token);
  return activeSessions().some((x) => x.tokenHash === h);
}
function revokeAdminSession(token) {
  const h = hashToken(token);
  writeJSON(SESSIONS_FILE, activeSessions().filter((x) => x.tokenHash !== h));
}
function revokeOtherAdminSessions(keepToken) {
  const h = hashToken(keepToken);
  writeJSON(SESSIONS_FILE, activeSessions().filter((x) => x.tokenHash === h));
}
function bearerToken(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}
function checkAdmin(req, config) {
  return isValidAdminToken(bearerToken(req));
}

// ---------- Password owner ----------
// Password terpisah dari password admin, khusus untuk tindakan owner (buka kunci periode gaji).
// Disimpan sebagai hash scrypt + salt, tidak pernah dikirim ke browser.
function hashOwnerPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function checkOwnerPassword(config, pw) {
  if (!config.ownerPasswordHash || !config.ownerPasswordSalt || !pw) return false;
  const a = Buffer.from(hashOwnerPassword(pw, config.ownerPasswordSalt), 'hex');
  const b = Buffer.from(config.ownerPasswordHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

const { buildXlsx, XLSX_STYLE } = require('./lib/xlsx-write');

// Kunci laporan: diturunkan dari password admin, supaya tidak perlu disimpan
// terpisah. Otomatis berubah kalau password admin diganti.
function reportKey(config) {
  return crypto.createHash('sha256').update(config.adminPassword + ':report-key').digest('hex').slice(0, 24);
}

// Buat notifikasi baru untuk karyawan (dipakai saat admin approve/reject cuti & kasbon).
function addNotification(phone, message, type) {
  const notifications = readJSON(NOTIFICATIONS_FILE);
  notifications.push({
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    phone, message, type: type || 'info', read: false,
    createdAt: new Date().toISOString(),
  });
  writeJSON(NOTIFICATIONS_FILE, notifications);
}

// Pengingat lupa absen untuk karyawan (muncul di lonceng aplikasi karyawan). Dibuat saat
// karyawan membuka aplikasi, karena server tidak punya penjadwal sendiri. Setiap hari hanya
// diingatkan sekali (ditandai refKey). Yang dicek: 7 hari terakhir yang cuma punya absen masuk
// atau cuma absen pulang, plus hari ini kalau sudah lewat 1 jam dari jam pulang shift tapi
// belum absen pulang.
function generateLupaAbsenReminders(phone, config) {
  const emp = config.employees.find((e) => e.phone === phone);
  if (!emp) return;
  const todayKey = dateKeyJakarta(new Date().toISOString());
  const fromKey = shiftDateKey(todayKey, -7);
  const byDate = {};
  for (const r of readJSON(RECORDS_FILE)) {
    if (r.phone !== phone && r.employee !== emp.name) continue;
    if (r.dateKey < fromKey || r.dateKey > todayKey) continue;
    if (r.type !== 'masuk' && r.type !== 'keluar') continue;
    if (!byDate[r.dateKey]) byDate[r.dateKey] = {};
    byDate[r.dateKey][r.type] = r;
  }
  const notifications = readJSON(NOTIFICATIONS_FILE);
  const existing = new Set(notifications.filter((n) => n.phone === phone && n.refKey).map((n) => n.refKey));
  const nowMenit = timeToMinutes(timeHHMMJakarta(new Date().toISOString()));
  let added = false;
  const push = (refKey, message) => {
    if (existing.has(refKey)) return;
    notifications.push({
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      phone, message, type: 'lupa_absen', read: false, refKey, createdAt: new Date().toISOString(),
    });
    existing.add(refKey);
    added = true;
  };
  for (const [dk, g] of Object.entries(byDate).sort()) {
    const tgl = formatTanggalIndo(dk);
    if (dk < todayKey && g.masuk && !g.keluar) {
      const jam = g.masuk.shiftEnd ? ` (${g.masuk.shiftEnd})` : '';
      push(`lupa-absen|${dk}`, `Kamu lupa absen pulang tanggal ${tgl}. Jam pulang dicatat otomatis sesuai shift${jam}. Hubungi admin kalau jamnya berbeda.`);
    } else if (g.keluar && !g.masuk) {
      const sh = inferShiftFromKeluar(g.keluar.nearestLocation, timeToMinutes(g.keluar.timeHHMM), config);
      const jam = sh ? ` (${sh.startTime})` : '';
      push(`lupa-absen|${dk}`, `Kamu lupa absen masuk tanggal ${tgl}. Jam masuk dicatat otomatis sesuai shift${jam}. Hubungi admin kalau jamnya berbeda.`);
    } else if (dk === todayKey && g.masuk && !g.keluar && g.masuk.shiftEnd
      && nowMenit >= timeToMinutes(g.masuk.shiftEnd) + 60) {
      push(`belum-pulang|${dk}`, 'Kamu belum absen pulang hari ini. Jangan lupa absen pulang ya.');
    }
  }
  if (added) writeJSON(NOTIFICATIONS_FILE, notifications);
}

// Buat notifikasi baru untuk admin (dipakai saat karyawan ajukan cuti/izin atau kasbon baru).
function addAdminNotification(message, type, refId) {
  const notifications = readJSON(ADMIN_NOTIFICATIONS_FILE);
  notifications.push({
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    message, type: type || 'info', refId: refId || null, read: false,
    createdAt: new Date().toISOString(),
  });
  writeJSON(ADMIN_NOTIFICATIONS_FILE, notifications);
}

// ---------- Static file serving ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  filePath = path.join(PUBLIC_DIR, path.normalize(filePath).replace(/^\.\.(\/|\\)/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function servePhoto(req, res, filename) {
  const safe = path.basename(filename);
  const filePath = path.join(PHOTOS_DIR, safe);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    res.end(data);
  });
}

// ---------- Aggregation helpers ----------
function dateKeyJakarta(isoTimestamp) {
  // Pakai offset WIB (+7) secara sederhana dan konsisten
  const d = new Date(isoTimestamp);
  const jakarta = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return jakarta.toISOString().slice(0, 10); // YYYY-MM-DD
}
function timeHHMMJakarta(isoTimestamp) {
  const d = new Date(isoTimestamp);
  const jakarta = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return jakarta.toISOString().slice(11, 16);
}

// ---------- Helper format untuk Slip Gaji (tampilan web & export .xlsx) ----------
const BULAN_INDO = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
function formatTanggalIndo(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${d} ${BULAN_INDO[m - 1]} ${y}`;
}
function formatTanggalSlash(ymd) {
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}
function formatJamKoma(n) {
  return (Math.round(n * 10) / 10).toFixed(1).replace('.', ',');
}
// Pembulatan jam bertingkat untuk lembur/terlambat/pulang cepat (dikali upah per jam):
// sisa menit dari jam penuh 0-14 -> 0.0, 15-44 -> 0.5, 45-59 -> 1.0 (naik ke jam berikutnya).
// Contoh: 3 jam 15 menit (195 menit) -> 3.5 jam.
function roundJamBertingkat(menit) {
  if (!menit || menit <= 0) return 0;
  const jamPenuh = Math.floor(menit / 60);
  const sisaMenit = menit % 60;
  let tambahan;
  if (sisaMenit < 15) tambahan = 0;
  else if (sisaMenit < 45) tambahan = 0.5;
  else tambahan = 1;
  return jamPenuh + tambahan;
}
function formatRupiahServer(n) {
  const sign = n < 0 ? '-' : '';
  return sign + 'Rp ' + Math.abs(Math.round(n)).toLocaleString('id-ID');
}
// Tanggal 1 s.d. akhir bulan dari "YYYY-MM" (dipakai untuk periode Laporan Kasbon, Task #49:
// periode kasbon = 1 bulan kalender penuh, terpisah dari periode gajian 26-25).
function monthRange(yyyyMm) {
  const [y, m] = String(yyyyMm).split('-').map(Number);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // hari ke-0 bulan berikutnya = hari terakhir bulan ini
  const to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

// Nama sheet Excel tidak boleh mengandung \ / ? * [ ] : dan maksimal 31 karakter.
function safeSheetName(name) {
  return (name || 'Slip').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Slip';
}

// ---------- Request handler ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathName = url.pathname;
    const config = migrateConfig(readJSON(CONFIG_FILE));

    // CORS (untuk kemudahan jika frontend dipisah)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // ---- Public config (tanpa password admin, tanpa daftar nomor) ----
    if (pathName === '/api/public-config' && req.method === 'GET') {
      return sendJSON(res, 200, {
        locationCount: config.locations.length,
      });
    }

    // ---- Cek nomor telepon terdaftar (sebelum ambil foto) ----
    if (pathName === '/api/check-phone' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const emp = config.employees.find((e) => e.phone === String(body.phone || '').trim());
      if (!emp) return sendJSON(res, 404, { error: 'Nomor telepon tidak terdaftar' });
      if (emp.status === 'nonaktif') return sendJSON(res, 403, { error: 'Akun karyawan ini sudah tidak aktif. Hubungi admin.' });
      return sendJSON(res, 200, {
        name: emp.name,
        idNumber: emp.idNumber || '',
        position: emp.position || '',
        photoUrl: emp.photoFilename ? `/api/employee-photo/${encodeURIComponent(emp.phone)}` : null,
      });
    }

    // ---- Riwayat absensi milik karyawan sendiri (identifikasi pakai nomor telepon, tanpa login admin) ----
    if (pathName === '/api/my-records' && req.method === 'GET') {
      const phone = String(url.searchParams.get('phone') || '').trim();
      const month = url.searchParams.get('month') || dateKeyJakarta(new Date().toISOString()).slice(0, 7);
      const emp = config.employees.find((e) => e.phone === phone);
      if (!emp) return sendJSON(res, 404, { error: 'Nomor telepon tidak terdaftar' });

      const allPhoneRecords = readJSON(RECORDS_FILE).filter((r) => r.phone === phone);
      const records = allPhoneRecords
        .filter((r) => r.dateKey.startsWith(month))
        .sort((a, b) => (a.dateKey + a.timeHHMM < b.dateKey + b.timeHHMM ? 1 : -1)); // terbaru dulu

      const lemburMap = computeLemburByEmployeeDate(records, config);
      const result = records.map((r) => ({
        dateKey: r.dateKey,
        timeHHMM: r.timeHHMM,
        type: r.type,
        shift: r.shift,
        shiftStart: r.shiftStart || null,
        shiftEnd: r.shiftEnd || null,
        nearestLocation: r.nearestLocation,
        withinRadius: r.withinRadius,
        distanceMeters: r.distanceMeters,
      }));
      const totalLemburJamBulanIni = totalLemburJam(Object.values(lemburMap).reduce(addLemburParts, emptyLemburParts()));

      // Ringkasan bulan ini: hari hadir & total keterlambatan (dibandingkan jam mulai shift yang dipilih).
      const hariHadirSet = new Set();
      let terlambatMenit = 0;
      for (const r of records) {
        hariHadirSet.add(r.dateKey);
        if (r.type === 'masuk') {
          const startTime = r.shiftStart || config.workStartTime;
          if (startTime && r.timeHHMM > startTime) {
            terlambatMenit += timeToMinutes(r.timeHHMM) - timeToMinutes(startTime);
          }
        }
      }
      const todayKey = dateKeyJakarta(new Date().toISOString());
      // Status hari ini selalu dihitung dari seluruh data (bukan hanya bulan yang sedang dilihat),
      // supaya tombol Absen Masuk/Keluar tetap akurat walau karyawan sedang membuka riwayat bulan lain.
      const todayRecords = allPhoneRecords.filter((r) => r.dateKey === todayKey);
      const todayMasuk = todayRecords.find((r) => r.type === 'masuk');
      const todayKeluar = todayRecords.find((r) => r.type === 'keluar');
      const todayLemburMasuk = todayRecords.find((r) => r.type === 'lembur_masuk');
      const todayLemburKeluar = todayRecords.find((r) => r.type === 'lembur_keluar');

      // Izin/Cuti disetujui yang jatuh di bulan ini (untuk kartu ringkasan "Izin").
      const [sy, sm] = month.split('-').map(Number);
      const monthStart = `${month}-01`;
      const monthEndDate = new Date(sy, sm, 0).getDate();
      const monthEnd = `${month}-${String(monthEndDate).padStart(2, '0')}`;
      const myLeaves = readJSON(LEAVES_FILE).filter((l) => l.phone === phone && l.status === 'approved');
      const ijinDateSet = new Set();
      myLeaves.forEach((l) => {
        if (l.endDate < monthStart || l.startDate > monthEnd) return;
        const from = l.startDate < monthStart ? monthStart : l.startDate;
        const to = l.endDate > monthEnd ? monthEnd : l.endDate;
        let cur = new Date(from + 'T00:00:00');
        const end = new Date(to + 'T00:00:00');
        while (cur <= end) {
          ijinDateSet.add(dateKeyJakarta(cur.toISOString()));
          cur.setDate(cur.getDate() + 1);
        }
      });
      const ijinHari = ijinDateSet.size;

      // Tidak Hadir: hari berjalan bulan ini (s.d. hari ini kalau bulan sekarang) dikurangi hadir & izin.
      const nowKey = dateKeyJakarta(new Date().toISOString());
      const elapsedDay = month === nowKey.slice(0, 7) ? Number(nowKey.slice(8, 10)) : monthEndDate;
      const tidakHadir = Math.max(0, elapsedDay - hariHadirSet.size - ijinHari);

      return sendJSON(res, 200, {
        name: emp.name,
        idNumber: emp.idNumber || '',
        position: emp.position || '',
        photoUrl: emp.photoFilename ? `/api/employee-photo/${encodeURIComponent(emp.phone)}` : null,
        month,
        records: result,
        totalLemburJam: totalLemburJamBulanIni,
        toleransiMenit: config.toleransiTerlambatMenit || 0,
        summary: {
          hariHadir: hariHadirSet.size,
          terlambatJam: Math.floor(terlambatMenit / 60),
          terlambatMenit: terlambatMenit % 60,
          tidakHadir,
          ijin: ijinHari,
        },
        today: {
          dateKey: todayKey,
          masuk: todayMasuk ? todayMasuk.timeHHMM : null,
          keluar: todayKeluar ? todayKeluar.timeHHMM : null,
          lemburMasuk: todayLemburMasuk ? todayLemburMasuk.timeHHMM : null,
          lemburKeluar: todayLemburKeluar ? todayLemburKeluar.timeHHMM : null,
          shift: todayMasuk ? (todayMasuk.shift || null) : null,
          shiftStart: todayMasuk ? (todayMasuk.shiftStart || null) : null,
          shiftEnd: todayMasuk ? (todayMasuk.shiftEnd || null) : null,
          location: todayMasuk ? (todayMasuk.nearestLocation || null) : null,
        },
        // Hari izin/cuti/sakit yang disetujui di bulan ini (ditampilkan di Riwayat sebagai "Tidak masuk").
        leaveDays: myLeaves.flatMap((l) => {
          if (l.endDate < monthStart || l.startDate > monthEnd) return [];
          const out = [];
          let cur = l.startDate < monthStart ? monthStart : l.startDate;
          const end = l.endDate > monthEnd ? monthEnd : l.endDate;
          while (cur <= end) { out.push({ dateKey: cur, type: l.type }); cur = shiftDateKey(cur, 1); }
          return out;
        }),
      });
    }

    // ---- Slip gaji milik karyawan sendiri (identifikasi pakai nomor telepon, tanpa login admin) ----
    if (pathName === '/api/my-payslip' && req.method === 'GET') {
      const phone = String(url.searchParams.get('phone') || '').trim();
      const emp = config.employees.find((e) => e.phone === phone);
      if (!emp) return sendJSON(res, 404, { error: 'Nomor telepon tidak terdaftar' });

      const defaultPeriod = defaultPayrollPeriod();
      const from = url.searchParams.get('from') || defaultPeriod.from;
      const to = url.searchParams.get('to') || defaultPeriod.to;

      const records = readJSON(RECORDS_FILE).filter((r) => r.dateKey >= from && r.dateKey <= to);
      const payroll = getPayrollForPeriod(records, config, from, to);
      const slip = payroll.find((p) => p.employee === emp.name) || null;

      return sendJSON(res, 200, {
        from, to,
        employee: { name: emp.name, idNumber: emp.idNumber || '', position: emp.position || '' },
        slip,
      });
    }

    // ---- Lokasi terdekat + daftar shift lokasi itu (dipakai saat absen masuk) ----
    if (pathName === '/api/nearest-location' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const { lat, lng } = body;
      if (typeof lat !== 'number' || typeof lng !== 'number') {
        return sendJSON(res, 400, { error: 'Lokasi tidak valid' });
      }
      if (config.locations.length === 0) {
        return sendJSON(res, 400, { error: 'Belum ada lokasi kantor yang diatur. Hubungi admin.' });
      }
      const nearest = nearestLocation(lat, lng, config.locations);
      return sendJSON(res, 200, {
        name: nearest.name,
        distanceMeters: Math.round(nearest.distanceMeters),
        withinRadius: nearest.withinRadius,
        maxDistanceMeters: nearest.maxDistanceMeters,
        melebihiJarakMaksimal: nearest.melebihiJarakMaksimal,
        shifts: nearest.shifts,
      });
    }

    // ---- Login admin (email + password) ----
    if (pathName === '/api/login' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const emailOk = String(body.email || '').trim().toLowerCase() === String(config.adminEmail || '').trim().toLowerCase();
      const passwordOk = body.password === config.adminPassword;
      if (emailOk && passwordOk) {
        return sendJSON(res, 200, { token: createAdminSession() });
      }
      return sendJSON(res, 401, { error: 'Email atau password salah' });
    }

    if (pathName === '/api/logout' && req.method === 'POST') {
      const t = bearerToken(req);
      if (t) revokeAdminSession(t);
      return sendJSON(res, 200, { ok: true });
    }

    // Buat / ganti password owner. Kalau sudah pernah dibuat, wajib isi password owner lama.
    if (pathName === '/api/owner-password' && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const newPassword = String(body.newPassword || '');
      if (newPassword.length < 6) return sendJSON(res, 400, { error: 'Password owner minimal 6 karakter.' });
      if (newPassword === config.adminPassword) return sendJSON(res, 400, { error: 'Password owner harus berbeda dari password admin.' });
      const fresh = readJSON(CONFIG_FILE);
      if (fresh.ownerPasswordHash && !checkOwnerPassword(fresh, body.currentPassword)) {
        return sendJSON(res, 403, { error: 'Password owner lama salah.' });
      }
      fresh.ownerPasswordSalt = crypto.randomBytes(16).toString('hex');
      fresh.ownerPasswordHash = hashOwnerPassword(newPassword, fresh.ownerPasswordSalt);
      writeJSON(CONFIG_FILE, fresh);
      return sendJSON(res, 200, { ok: true });
    }

    // ---- Absen (check-in / check-out / lembur masuk / lembur pulang) ----
// Percobaan absen yang gagal dicatat supaya admin bisa melihat siapa yang sering gagal absen.
function logFailedAttempt({ phone, employee, type, reason, detail, lat, lng, distanceMeters, nearestLocation }) {
  const serverTime = new Date().toISOString();
  const list = readJSON(FAILED_ATTEMPTS_FILE);
  list.push({
    id: crypto.randomUUID(),
    phone: phone ? String(phone) : null,
    employee: employee || null,
    type: type || null,
    reason, // 'telepon_tidak_terdaftar' | 'nonaktif' | 'jarak_terlalu_jauh' | 'shift_kosong' | 'lokasi_belum_diatur' | 'data_tidak_lengkap' | 'shift_tidak_dikenali' | 'gps' | 'kamera'
    detail: detail || '',
    lat: typeof lat === 'number' ? lat : null,
    lng: typeof lng === 'number' ? lng : null,
    distanceMeters: typeof distanceMeters === 'number' ? Math.round(distanceMeters) : null,
    nearestLocation: nearestLocation || null,
    serverTime,
    dateKey: dateKeyJakarta(serverTime),
    timeHHMM: timeHHMMJakarta(serverTime),
  });
  // Simpan 2000 terakhir saja agar file tidak membengkak.
  writeJSON(FAILED_ATTEMPTS_FILE, list.slice(-2000));

  // Notifikasi ke admin maksimal 1 kali per karyawan per hari, supaya admin tahu
  // kalau karyawan tidak absen karena kendala aplikasi, bukan karena tidak hadir.
  // Notifikasi admin hanya sekali per karyawan per hari (jam percobaan pertama). Semua jam ada di dashboard.
  const who = employee || phone;
  if (who) {
    const dateKey = dateKeyJakarta(serverTime);
    const refId = `absen-gagal:${who}:${dateKey}`;
    const sudahAda = readJSON(ADMIN_NOTIFICATIONS_FILE).some((n) => n.refId === refId);
    if (!sudahAda) {
      addAdminNotification(pesanAbsenGagal(who, reasonLabelAbsen(reason), timeHHMMJakarta(serverTime)), 'absen_gagal', refId);
    }
  }
}

function pesanAbsenGagal(who, alasan, jam) {
  return `${who} gagal absen hari ini pukul ${jam}. Alasan: ${alasan}. Kemungkinan karena kendala aplikasi, bukan karena tidak hadir.`;
}

// Label alasan absen gagal (dipakai notifikasi admin dan dashboard).
function reasonLabelAbsen(reason) {
  return ({
    telepon_tidak_terdaftar: 'nomor tidak terdaftar', nonaktif: 'akun non-aktif', jarak_terlalu_jauh: 'terlalu jauh dari lokasi',
    shift_kosong: 'shift belum dipilih', shift_tidak_dikenali: 'shift tidak dikenali', lokasi_belum_diatur: 'lokasi kantor belum diatur',
    data_tidak_lengkap: 'data tidak lengkap', gps: 'GPS gagal', kamera: 'kamera gagal',
  })[reason] || reason;
}

    // Laporan dari app karyawan saat GPS atau kamera gagal (request tidak sampai ke /api/checkin).
    if (pathName === '/api/checkin-gagal' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const emp = config.employees.find((e) => e.phone === String(body.phone || '').trim());
      const reason = body.reason === 'kamera' ? 'kamera' : 'gps';
      logFailedAttempt({
        phone: emp ? emp.phone : String(body.phone || '').trim() || null,
        employee: emp ? emp.name : null,
        type: typeof body.type === 'string' ? body.type : null,
        reason,
        detail: String(body.detail || '').slice(0, 300),
      });
      return sendJSON(res, 200, { ok: true });
    }

    if (pathName === '/api/checkin' && req.method === 'POST') {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf8'));
      const { phone, type, lat, lng, photoBase64, deviceTime, shift } = body;

      const validTypes = ['masuk', 'keluar', 'lembur_masuk', 'lembur_keluar'];
      if (!phone || !validTypes.includes(type) || typeof lat !== 'number' || typeof lng !== 'number' || !photoBase64) {
        const empKosong = config.employees.find((e) => e.phone === String(phone || '').trim());
        logFailedAttempt({ phone: empKosong ? empKosong.phone : (phone ? String(phone) : null), employee: empKosong ? empKosong.name : null, type, reason: 'data_tidak_lengkap', detail: 'Field wajib kosong atau tidak valid', lat, lng });
        return sendJSON(res, 400, { error: 'Data tidak lengkap (nomor telepon, tipe, lokasi, foto wajib diisi)' });
      }
      const emp = config.employees.find((e) => e.phone === String(phone).trim());
      if (!emp) {
        logFailedAttempt({ phone, type, reason: 'telepon_tidak_terdaftar', detail: 'Nomor tidak ada di daftar karyawan', lat, lng });
        return sendJSON(res, 400, { error: 'Nomor telepon tidak terdaftar. Hubungi admin untuk didaftarkan.' });
      }
      if (emp.status === 'nonaktif') {
        logFailedAttempt({ phone: emp.phone, employee: emp.name, type, reason: 'nonaktif', detail: 'Akun karyawan non-aktif', lat, lng });
        return sendJSON(res, 403, { error: 'Akun karyawan ini sudah tidak aktif. Hubungi admin.' });
      }

      if (config.locations.length === 0) {
        logFailedAttempt({ phone: emp.phone, employee: emp.name, type, reason: 'lokasi_belum_diatur', detail: 'Belum ada lokasi kantor', lat, lng });
        return sendJSON(res, 400, { error: 'Belum ada lokasi kantor yang diatur. Hubungi admin.' });
      }
      const nearest = nearestLocation(lat, lng, config.locations);
      const withinRadius = nearest.withinRadius;

      // Task #38: batas jarak maksimal (hard limit) — kalau lebih jauh dari ini, absen DITOLAK
      // sepenuhnya (bukan cuma ditandai "di luar radius" seperti sebelumnya).
      if (nearest.melebihiJarakMaksimal) {
        logFailedAttempt({ phone: emp.phone, employee: emp.name, type, reason: 'jarak_terlalu_jauh', detail: `Jarak ${Math.round(nearest.distanceMeters)} m, maksimal ${nearest.maxDistanceMeters} m`, lat, lng, distanceMeters: nearest.distanceMeters, nearestLocation: nearest.name });
        return sendJSON(res, 400, {
          error: `Lokasi kamu terlalu jauh dari ${nearest.name} (jarak ${Math.round(nearest.distanceMeters)} m, maksimal ${nearest.maxDistanceMeters} m). Absen tidak bisa disimpan, pastikan kamu berada dekat lokasi kerja.`,
        });
      }

      // Shift wajib dipilih saat absen masuk reguler; dicocokkan ke daftar shift lokasi terdekat.
      // Lembur Masuk/Lembur Pulang tidak terikat jadwal shift ataupun batasan waktu.
      let shiftInfo = null;
      if (type === 'masuk') {
        if (!shift) {
          logFailedAttempt({ phone: emp.phone, employee: emp.name, type, reason: 'shift_kosong', detail: 'Shift belum dipilih', lat, lng, nearestLocation: nearest.name });
          return sendJSON(res, 400, { error: 'Pilih shift terlebih dahulu.' });
        }
        shiftInfo = (nearest.shifts || []).find((s) => s.name === shift) || null;
        if (!shiftInfo) {
          logFailedAttempt({ phone: emp.phone, employee: emp.name, type, reason: 'shift_tidak_dikenali', detail: `Shift "${shift}" tidak ada di lokasi ini`, lat, lng, nearestLocation: nearest.name });
          return sendJSON(res, 400, { error: 'Shift tidak dikenali untuk lokasi ini.' });
        }
      }

      const id = crypto.randomUUID();
      const serverTime = new Date().toISOString();
      const photoFilename = `${id}.jpg`;
      const base64Data = photoBase64.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(path.join(PHOTOS_DIR, photoFilename), Buffer.from(base64Data, 'base64'));

      const record = {
        id,
        phone: emp.phone,
        employee: emp.name,
        type, // 'masuk' | 'keluar' | 'lembur_masuk' | 'lembur_keluar'
        lat,
        lng,
        nearestLocation: nearest.name,
        distanceMeters: Math.round(nearest.distanceMeters),
        withinRadius,
        shift: shiftInfo ? shiftInfo.name : null,
        shiftStart: shiftInfo ? shiftInfo.startTime : null,
        shiftEnd: shiftInfo ? shiftInfo.endTime : null,
        photoFilename,
        serverTime,
        deviceTime: deviceTime || null,
        dateKey: dateKeyJakarta(serverTime),
        timeHHMM: timeHHMMJakarta(serverTime),
      };

      const records = readJSON(RECORDS_FILE);
      records.push(record);
      writeJSON(RECORDS_FILE, records);

      return sendJSON(res, 200, {
        ok: true,
        withinRadius,
        nearestLocation: nearest.name,
        distanceMeters: Math.round(nearest.distanceMeters),
        message: withinRadius
          ? `Absen berhasil, lokasi terverifikasi di ${nearest.name}.`
          : `Absen tercatat, tetapi lokasi di luar radius ${nearest.name} (jarak ${Math.round(nearest.distanceMeters)} m).`,
      });
    }

    // ---- Foto ----
    if (pathName.startsWith('/api/photo/') && req.method === 'GET') {
      // Lindungi foto dengan token admin sederhana lewat query ?t=
      const token = url.searchParams.get('t');
      if (!isValidAdminToken(token)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      const filename = pathName.replace('/api/photo/', '');
      return servePhoto(req, res, filename);
    }

    // ---- Foto profil karyawan (untuk ditampilkan di halaman riwayat & admin) ----
    if (pathName.startsWith('/api/employee-photo/') && req.method === 'GET') {
      const phone = decodeURIComponent(pathName.replace('/api/employee-photo/', ''));
      const emp = config.employees.find((e) => e.phone === phone);
      if (!emp || !emp.photoFilename) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const filePath = path.join(EMPLOYEE_PHOTOS_DIR, path.basename(emp.photoFilename));
      return fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
        res.end(data);
      });
    }

    // ---- Endpoint admin (butuh token) ----
    if (pathName === '/api/records' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const date = url.searchParams.get('date'); // YYYY-MM-DD
      const records = readJSON(RECORDS_FILE);
      const filtered = date ? records.filter((r) => r.dateKey === date) : records;
      // Lupa absen di tanggal ini: jam yang kosong diisi otomatis sesuai jadwal shift
      // (hanya untuk ditampilkan; lupa pulang di hari ini belum dianggap lupa).
      const lupaAbsen = {};
      if (date) {
        const todayKey = dateKeyJakarta(new Date().toISOString());
        const byEmp = {};
        for (const r of filtered) {
          if (!byEmp[r.employee]) byEmp[r.employee] = {};
          byEmp[r.employee][r.type] = r;
        }
        for (const [name, g] of Object.entries(byEmp)) {
          if (g.masuk && !g.keluar && date < todayKey) {
            const jam = g.masuk.shiftEnd || null;
            if (jam) lupaAbsen[name] = { type: 'keluar', jam, shift: g.masuk.shift || '' };
          } else if (!g.masuk && g.keluar) {
            const sh = inferShiftFromKeluar(g.keluar.nearestLocation, timeToMinutes(g.keluar.timeHHMM), config);
            if (sh) lupaAbsen[name] = { type: 'masuk', jam: sh.startTime, shift: sh.name };
          }
        }
      }
      return sendJSON(res, 200, { records: filtered, lupaAbsen });
    }

    // Admin: input manual jam absen (karyawan lupa absen masuk/pulang/lembur masuk/lembur pulang).
    if (pathName === '/api/records/manual' && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { phone, type, dateKey, timeHHMM, locationName, shift } = body;
      const emp = config.employees.find((e) => e.phone === String(phone || '').trim());
      if (!emp) return sendJSON(res, 400, { error: 'Karyawan tidak ditemukan.' });
      if (!['masuk', 'keluar', 'lembur_masuk', 'lembur_keluar'].includes(type)) {
        return sendJSON(res, 400, { error: 'Jenis absen tidak valid.' });
      }
      if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return sendJSON(res, 400, { error: 'Tanggal tidak valid.' });
      if (!timeHHMM || !/^\d{2}:\d{2}$/.test(timeHHMM)) return sendJSON(res, 400, { error: 'Jam tidak valid (format HH:MM).' });
      const lockManual = findLockCoveringDate(dateKey);
      if (lockManual) return sendJSON(res, 400, { error: `Periode ${lockManual.from} s.d. ${lockManual.to} sudah dikunci. Buka kunci dulu di menu Gaji.` });

      // Shift wajib dipilih utk jenis Masuk (dipakai untuk hitung lembur/terlambat akurat,
      // bukan fallback shift standar) — dicocokkan ke daftar shift lokasi yang dipilih admin.
      let shiftInfo = null;
      let resolvedLocationName = 'Input Manual Admin';
      if (type === 'masuk') {
        if (!locationName || !shift) return sendJSON(res, 400, { error: 'Pilih lokasi dan shift terlebih dahulu.' });
        const loc = (config.locations || []).find((l) => l.name === locationName);
        if (!loc) return sendJSON(res, 400, { error: 'Lokasi tidak dikenali.' });
        shiftInfo = (loc.shifts || []).find((s) => s.name === shift) || null;
        if (!shiftInfo) return sendJSON(res, 400, { error: 'Shift tidak dikenali untuk lokasi ini.' });
        resolvedLocationName = loc.name;
      }

      const records = readJSON(RECORDS_FILE);
      const exists = records.find((r) => r.phone === emp.phone && r.dateKey === dateKey && r.type === type);
      if (exists) return sendJSON(res, 400, { error: 'Sudah ada data absen untuk jenis & tanggal ini. Gunakan Edit untuk mengubahnya.' });

      const record = {
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        phone: emp.phone,
        employee: emp.name,
        type,
        lat: null,
        lng: null,
        nearestLocation: resolvedLocationName,
        distanceMeters: 0,
        withinRadius: true,
        shift: shiftInfo ? shiftInfo.name : null,
        shiftStart: shiftInfo ? shiftInfo.startTime : null,
        shiftEnd: shiftInfo ? shiftInfo.endTime : null,
        photoFilename: null,
        serverTime: new Date().toISOString(),
        deviceTime: null,
        dateKey,
        timeHHMM,
        manualByAdmin: true,
      };
      records.push(record);
      writeJSON(RECORDS_FILE, records);
      return sendJSON(res, 200, { ok: true, record });
    }

    // Admin: edit jam absen yang sudah ada (perbaikan kesalahan / lupa absen).
    if (pathName.startsWith('/api/records/') && pathName.split('/').length === 4 && req.method === 'PUT') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const id = pathName.split('/')[3];
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const records = readJSON(RECORDS_FILE);
      const r = records.find((x) => x.id === id);
      if (!r) return sendJSON(res, 404, { error: 'Data absen tidak ditemukan' });
      const lockEdit = findLockCoveringDate(r.dateKey);
      if (lockEdit) return sendJSON(res, 400, { error: `Periode ${lockEdit.from} s.d. ${lockEdit.to} sudah dikunci. Buka kunci dulu di menu Gaji.` });
      if (!body.timeHHMM || !/^\d{2}:\d{2}$/.test(body.timeHHMM)) return sendJSON(res, 400, { error: 'Jam tidak valid (format HH:MM).' });
      r.timeHHMM = body.timeHHMM;
      // Kalau admin ikut ubah lokasi/shift (hanya relevan utk record jenis masuk).
      if (r.type === 'masuk' && body.locationName && body.shift) {
        const loc = (config.locations || []).find((l) => l.name === body.locationName);
        if (!loc) return sendJSON(res, 400, { error: 'Lokasi tidak dikenali.' });
        const shiftInfo = (loc.shifts || []).find((s) => s.name === body.shift) || null;
        if (!shiftInfo) return sendJSON(res, 400, { error: 'Shift tidak dikenali untuk lokasi ini.' });
        r.nearestLocation = loc.name;
        r.shift = shiftInfo.name;
        r.shiftStart = shiftInfo.startTime;
        r.shiftEnd = shiftInfo.endTime;
      }
      r.manualByAdmin = true;
      writeJSON(RECORDS_FILE, records);
      return sendJSON(res, 200, { ok: true, record: r });
    }

    // Admin: hapus satu data absen (Masuk/Pulang/Lembur Masuk/Lembur Pulang) karena salah input.
    if (pathName.startsWith('/api/records/') && pathName.split('/').length === 4 && req.method === 'DELETE') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const id = pathName.split('/')[3];
      let records = readJSON(RECORDS_FILE);
      const exists = records.find((x) => x.id === id);
      if (!exists) return sendJSON(res, 404, { error: 'Data absen tidak ditemukan' });
      const lockDel = findLockCoveringDate(exists.dateKey);
      if (lockDel) return sendJSON(res, 400, { error: `Periode ${lockDel.from} s.d. ${lockDel.to} sudah dikunci. Buka kunci dulu di menu Gaji.` });
      records = records.filter((x) => x.id !== id);
      writeJSON(RECORDS_FILE, records);
      return sendJSON(res, 200, { ok: true });
    }

    if (pathName === '/api/summary' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      // Task #58: rekap absensi dgn rentang tanggal bebas (sebelumnya cuma per bulan kalender).
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from || !to) return sendJSON(res, 400, { error: 'Parameter from & to (YYYY-MM-DD) wajib diisi' });
      const records = readJSON(RECORDS_FILE).filter((r) => r.dateKey >= from && r.dateKey <= to);
      const lemburMap = computeLemburByEmployeeDate(records, config);

      const byEmployee = {};
      for (const emp of config.employees) {
        byEmployee[emp.name] = { employee: emp.name, hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0, lemburMenit: emptyLemburParts() };
      }
      for (const r of records) {
        if (!byEmployee[r.employee]) {
          byEmployee[r.employee] = { employee: r.employee, hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0, lemburMenit: emptyLemburParts() };
        }
        const e = byEmployee[r.employee];
        e.hariHadir.add(r.dateKey);
        e.totalAbsen += 1;
        if (!r.withinRadius) e.diLuarRadius += 1;
        // Pakai jam mulai shift yang dipilih karyawan saat absen masuk (fallback ke default global untuk record lama).
        const startTime = r.shiftStart || config.workStartTime;
        if (r.type === 'masuk' && startTime && r.timeHHMM > startTime) {
          e.terlambat += 1;
        }
      }
      // Jumlahkan lembur per (karyawan, tanggal) sekali saja per kombinasi.
      for (const key of Object.keys(lemburMap)) {
        const [employee] = key.split('|');
        if (byEmployee[employee]) addLemburParts(byEmployee[employee].lemburMenit, lemburMap[key]);
      }
      const summary = Object.values(byEmployee).map((e) => ({
        employee: e.employee,
        hariHadir: e.hariHadir.size,
        totalAbsen: e.totalAbsen,
        diLuarRadius: e.diLuarRadius,
        terlambat: e.terlambat,
        lemburJam: totalLemburJam(e.lemburMenit),
      }));
      return sendJSON(res, 200, { from, to, summary, workStartTime: config.workStartTime });
    }

    // ---- Export rekap absensi ke CSV untuk rentang tanggal bebas yang dipilih admin ----
    // Template import data absensi (kolom sama dengan export detail, ditambah Lokasi & Shift).
    if (pathName === '/api/records/import-template' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const header = ['Nama', 'No ID', 'Tanggal', 'Jam Masuk', 'Jam Pulang', 'Lembur Masuk', 'Lembur Pulang', 'Lokasi', 'Shift'];
      const contoh = ['Nama Karyawan', '', '2026-11-01', '08:30', '16:30', '', '', 'Yogya Jatibarang', 'Shift 1'];
      const referensi = [['Lokasi', 'Shift', 'Mulai', 'Selesai']];
      (config.locations || []).forEach((l) => (l.shifts || []).forEach((sh) => referensi.push([l.name, sh.name, sh.startTime, sh.endTime])));
      const xlsxBuffer = buildXlsx([
        { name: 'Absensi', rows: [header.map((v) => ({ v, s: XLSX_STYLE.BOLD })), contoh] },
        { name: 'Referensi Shift', rows: [referensi[0].map((v) => ({ v, s: XLSX_STYLE.BOLD })), ...referensi.slice(1)] },
      ]);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="template-import-absensi.xlsx"',
      });
      return res.end(xlsxBuffer);
    }

    // Import data absensi dari Excel. simpan=false: hanya preview. Baris yang ada error dilewati seluruhnya.
    if (pathName === '/api/records/import' && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!body.base64) return sendJSON(res, 400, { error: 'File belum dipilih' });
      let cells;
      try { cells = readSheetCells(Buffer.from(String(body.base64), 'base64')); }
      catch (e) { return sendJSON(res, 400, { error: 'File tidak bisa dibaca. Pastikan formatnya .xlsx.' }); }

      const grid = {};
      for (const c of cells) { if (!grid[c.row]) grid[c.row] = {}; grid[c.row][c.col] = c.v; }
      const norm = (v) => String(v === undefined || v === null ? '' : v).toLowerCase().replace(/\(.*?\)/g, '').trim();
      const kolom = {};
      Object.entries(grid[1] || {}).forEach(([col, v]) => { kolom[norm(v)] = Number(col); });
      const colNama = kolom['nama'], colNoId = kolom['no id'], colTanggal = kolom['tanggal'];
      const colMasuk = kolom['jam masuk'], colPulang = kolom['jam pulang'];
      const colLemburMasuk = kolom['lembur masuk'], colLemburPulang = kolom['lembur pulang'];
      const colLokasi = kolom['lokasi'], colShift = kolom['shift'];
      if (!colNama || !colTanggal) return sendJSON(res, 400, { error: 'Kolom "Nama" dan "Tanggal" wajib ada di baris pertama.' });

      const teks = (v) => (v === undefined || v === null ? '' : String(v).trim());
      const normNama = (v) => teks(v).toLowerCase().replace(/\s+/g, ' ');
      const tanggalDari = (v) => {
        if (typeof v === 'number' && isFinite(v)) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
        const t = teks(v);
        return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
      };
      const jamDari = (v) => {
        if (teks(v) === '') return { ok: true, jam: '' };
        if (typeof v === 'number' && isFinite(v) && v >= 0 && v < 1) {
          const m = Math.round(v * 1440) % 1440;
          return { ok: true, jam: String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') };
        }
        const m = teks(v).match(/^(\d{1,2}):(\d{2})$/);
        if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return { ok: true, jam: m[1].padStart(2, '0') + ':' + m[2] };
        return { ok: false, jam: '' };
      };

      const existing = readJSON(RECORDS_FILE);
      const sudahAda = new Set(existing.map((r) => r.phone + '|' + r.dateKey + '|' + r.type));
      const batch = new Set();
      const newRecords = [];
      const baris = [];
      const jenisKolom = [['masuk', colMasuk, 'Jam Masuk'], ['keluar', colPulang, 'Jam Pulang'], ['lembur_masuk', colLemburMasuk, 'Lembur Masuk'], ['lembur_keluar', colLemburPulang, 'Lembur Pulang']];
      const lastRow = Math.max(1, ...Object.keys(grid).map(Number));

      for (let r = 2; r <= lastRow; r++) {
        const row = grid[r];
        if (!row) continue;
        const get = (c) => (c ? row[c] : undefined);
        const nama = teks(get(colNama)), noId = teks(get(colNoId));
        const adaJam = jenisKolom.some(([, c]) => teks(get(c)) !== '');
        if (!nama && !noId && teks(get(colTanggal)) === '' && !adaJam) continue;

        const item = { baris: r, nama, tanggal: '', status: 'gagal', pesan: '', jumlah: 0 };
        const errs = [];
        const emp = (noId && config.employees.find((e) => (e.idNumber || '') === noId))
          || config.employees.find((e) => normNama(e.name) === normNama(nama));
        if (!emp) errs.push('Karyawan tidak ditemukan (periksa Nama atau No ID)');
        const dk = tanggalDari(get(colTanggal));
        if (!dk) errs.push('Tanggal tidak valid (gunakan YYYY-MM-DD)');
        else item.tanggal = dk;
        if (dk) {
          const lock = findLockCoveringDate(dk);
          if (lock) errs.push(`Periode ${lock.from} s.d. ${lock.to} sudah dikunci`);
        }
        if (!adaJam) errs.push('Tidak ada jam absen yang diisi');

        // Jam masuk wajib disertai lokasi dan shift yang dikenali (sama seperti input manual)
        const jamMasuk = jamDari(get(colMasuk));
        let lokasiInfo = null, shiftInfo = null;
        if (!jamMasuk.ok) errs.push('Jam Masuk tidak valid (gunakan HH:MM)');
        if (jamMasuk.jam) {
          lokasiInfo = (config.locations || []).find((l) => l.name === teks(get(colLokasi))) || null;
          if (!lokasiInfo) errs.push('Lokasi untuk Jam Masuk tidak dikenali');
          else {
            shiftInfo = (lokasiInfo.shifts || []).find((sh) => sh.name === teks(get(colShift))) || null;
            if (!shiftInfo) errs.push('Shift untuk Jam Masuk tidak dikenali di lokasi tersebut');
          }
        }

        const recs = [];
        if (emp && dk && errs.length === 0) {
          for (const [jenis, col, label] of jenisKolom) {
            const j = jenis === 'masuk' ? jamMasuk : jamDari(get(col));
            if (!j.ok) { errs.push(label + ' tidak valid (gunakan HH:MM)'); continue; }
            if (!j.jam) continue;
            const key = emp.phone + '|' + dk + '|' + jenis;
            if (sudahAda.has(key) || batch.has(key)) { errs.push(label + ' untuk tanggal ini sudah ada'); continue; }
            batch.add(key);
            recs.push({
              id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
              phone: emp.phone, employee: emp.name, type: jenis,
              lat: null, lng: null,
              nearestLocation: jenis === 'masuk' ? lokasiInfo.name : 'Input Manual Admin',
              distanceMeters: 0, withinRadius: true,
              shift: jenis === 'masuk' && shiftInfo ? shiftInfo.name : null,
              shiftStart: jenis === 'masuk' && shiftInfo ? shiftInfo.startTime : null,
              shiftEnd: jenis === 'masuk' && shiftInfo ? shiftInfo.endTime : null,
              photoFilename: null, serverTime: new Date().toISOString(), deviceTime: null,
              dateKey: dk, timeHHMM: j.jam, manualByAdmin: true,
            });
          }
        }

        if (errs.length) item.pesan = errs.join('; ');
        else {
          item.status = 'siap';
          item.jumlah = recs.length;
          item.pesan = recs.length + ' jam akan disimpan';
          newRecords.push(...recs);
        }
        baris.push(item);
      }

      const siap = baris.filter((b) => b.status === 'siap').length;
      const simpan = body.simpan === true;
      if (simpan && newRecords.length) {
        const all = readJSON(RECORDS_FILE);
        all.push(...newRecords);
        writeJSON(RECORDS_FILE, all);
      }
      return sendJSON(res, 200, {
        ok: true, simpan,
        barisSiap: siap, barisGagal: baris.length - siap,
        jumlahData: newRecords.length, tersimpan: simpan ? newRecords.length : 0,
        baris,
      });
    }

    if (pathName === '/api/records/export' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const mode = url.searchParams.get('mode') === 'detail' ? 'detail' : 'summary';
      const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'xlsx';
      // Filter karyawan opsional: daftar nomor telepon dipisah koma. Kosong/tidak diisi = semua karyawan.
      const phonesParam = (url.searchParams.get('employees') || '').trim();
      const selectedPhones = phonesParam ? phonesParam.split(',').map((s) => s.trim()).filter(Boolean) : null;
      if (!from || !to) return sendJSON(res, 400, { error: 'Parameter from dan to (YYYY-MM-DD) wajib diisi' });
      if (to < from) return sendJSON(res, 400, { error: 'Tanggal selesai tidak boleh sebelum tanggal mulai' });

      const empMeta = {};
      config.employees.forEach((e) => { empMeta[e.name] = e; });
      const selectedEmployees = selectedPhones
        ? config.employees.filter((e) => selectedPhones.includes(e.phone))
        : config.employees;
      const selectedNames = new Set(selectedEmployees.map((e) => e.name));

      const records = readJSON(RECORDS_FILE)
        .filter((r) => r.dateKey >= from && r.dateKey <= to)
        .filter((r) => !selectedPhones || selectedNames.has(r.employee))
        .sort((a, b) => (a.dateKey + a.timeHHMM).localeCompare(b.dateKey + b.timeHHMM));

      let headerRow, dataRows, filenameBase;

      if (mode === 'detail') {
        // Satu baris per karyawan per tanggal (Jam Masuk/Pulang/Lembur Masuk/Lembur Pulang sekaligus).
        const byKey = {};
        const order = [];
        records.forEach((r) => {
          const key = r.employee + '|' + r.dateKey;
          if (!byKey[key]) { byKey[key] = { employee: r.employee, dateKey: r.dateKey }; order.push(key); }
          byKey[key][r.type] = r;
        });
        headerRow = ['Nama', 'No ID', 'Tanggal', 'Jam Masuk', 'Jam Pulang', 'Lembur Masuk', 'Lembur Pulang', 'Lokasi', 'Shift', 'Keterangan'];
        dataRows = order.map((key) => {
          const g = byKey[key];
          const ref = g.masuk || g.keluar || g.lembur_masuk || g.lembur_keluar;
          const emp = empMeta[g.employee] || {};
          const anyInvalid = (g.masuk && !g.masuk.withinRadius) || (g.keluar && !g.keluar.withinRadius);
          const startTime = (g.masuk && g.masuk.shiftStart) || config.workStartTime;
          const terlambat = g.masuk && startTime && g.masuk.timeHHMM > startTime;
          const keterangan = [terlambat ? 'Terlambat' : '', anyInvalid ? 'Di luar radius' : ''].filter(Boolean).join('; ');
          return [
            g.employee, emp.idNumber || '', g.dateKey,
            g.masuk ? g.masuk.timeHHMM : '', g.keluar ? g.keluar.timeHHMM : '',
            g.lembur_masuk ? g.lembur_masuk.timeHHMM : '', g.lembur_keluar ? g.lembur_keluar.timeHHMM : '',
            ref ? (ref.nearestLocation || '') : '', ref ? (ref.shift || '') : '', keterangan,
          ];
        });
        filenameBase = `detail-absensi-${from}_${to}`;
      } else {
        // Ringkasan per karyawan (hari hadir, terlambat, di luar radius, lembur jam) untuk rentang tanggal.
        const lemburMap = computeLemburByEmployeeDate(records, config);
        const byEmployee = {};
        for (const emp of selectedEmployees) {
          byEmployee[emp.name] = { employee: emp.name, idNumber: emp.idNumber || '', hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0, lemburMenit: emptyLemburParts() };
        }
        for (const r of records) {
          if (!byEmployee[r.employee]) {
            if (selectedPhones && !selectedNames.has(r.employee)) continue;
            byEmployee[r.employee] = { employee: r.employee, idNumber: (empMeta[r.employee] && empMeta[r.employee].idNumber) || '', hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0, lemburMenit: emptyLemburParts() };
          }
          const e = byEmployee[r.employee];
          e.hariHadir.add(r.dateKey);
          e.totalAbsen += 1;
          if (!r.withinRadius) e.diLuarRadius += 1;
          const startTime = r.shiftStart || config.workStartTime;
          if (r.type === 'masuk' && startTime && r.timeHHMM > startTime) e.terlambat += 1;
        }
        for (const key of Object.keys(lemburMap)) {
          const [employee] = key.split('|');
          if (byEmployee[employee]) addLemburParts(byEmployee[employee].lemburMenit, lemburMap[key]);
        }
        headerRow = ['Nama', 'No ID', 'Hari Hadir', 'Total Catatan Absen', 'Terlambat (kali)', 'Di Luar Radius', 'Lembur (jam)'];
        dataRows = Object.values(byEmployee).map((e) => [
          e.employee, e.idNumber, e.hariHadir.size, e.totalAbsen, e.terlambat, e.diLuarRadius,
          totalLemburJam(e.lemburMenit),
        ]);
        filenameBase = `rekap-absensi-${from}_${to}`;
      }

      if (format === 'csv') {
        const esc = (v) => {
          const s = String(v === undefined || v === null ? '' : v);
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const lines = [headerRow, ...dataRows].map((row) => row.map(esc).join(','));
        const csv = '﻿' + lines.join('\r\n'); // BOM biar Excel baca UTF-8 dengan benar
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filenameBase}.csv"`,
        });
        return res.end(csv);
      }

      // Default: file Excel (.xlsx), satu sheet berisi header + data.
      const xlsxBuffer = buildXlsx([{ name: mode === 'detail' ? 'Detail Absensi' : 'Rekap Absensi', rows: [headerRow, ...dataRows] }]);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filenameBase}.xlsx"`,
      });
      return res.end(xlsxBuffer);
    }

    // ---- Rekap gaji untuk admin (rentang tanggal bebas, biasanya periode gajian 26 - 25) ----
    if (pathName === '/api/payroll' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from || !to) return sendJSON(res, 400, { error: 'Parameter from dan to (YYYY-MM-DD) wajib diisi' });
      const records = readJSON(RECORDS_FILE).filter((r) => r.dateKey >= from && r.dateKey <= to);
      const payroll = getPayrollForPeriod(records, config, from, to);
      const lock = findPayrollLock(from, to);
      return sendJSON(res, 200, { from, to, payroll, locked: !!lock, lockedAt: lock ? lock.lockedAt : null });
    }

    // Kunci periode gaji: simpan hasil hitungan saat ini dan blokir edit absen di periode itu.
    if (pathName === '/api/payroll/lock' && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { from, to } = body;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || from > to) {
        return sendJSON(res, 400, { error: 'Periode tidak valid.' });
      }
      const locks = readJSON(PAYROLL_LOCKS_FILE);
      const overlap = locks.find((l) => !(to < l.from || from > l.to));
      if (overlap) return sendJSON(res, 400, { error: `Periode ini bertabrakan dengan periode terkunci ${overlap.from} s.d. ${overlap.to}.` });
      const records = readJSON(RECORDS_FILE).filter((r) => r.dateKey >= from && r.dateKey <= to);
      const payroll = computePayrollSummary(records, config, from, to);
      const lockedAt = new Date().toISOString();
      locks.push({ from, to, lockedAt, payroll });
      writeJSON(PAYROLL_LOCKS_FILE, locks);
      return sendJSON(res, 200, { ok: true, lockedAt });
    }

    // Buka kunci periode: hapus hasil tersimpan, hitungan kembali mengikuti data absen terbaru.
    if (pathName === '/api/payroll/lock' && req.method === 'DELETE') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      if (!config.ownerPasswordHash) return sendJSON(res, 403, { error: 'Password owner belum dibuat. Buat dulu di menu Pengaturan.' });
      if (!checkOwnerPassword(config, req.headers['x-owner-password'])) return sendJSON(res, 403, { error: 'Password owner salah.' });
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const locks = readJSON(PAYROLL_LOCKS_FILE);
      const remaining = locks.filter((l) => !(l.from === from && l.to === to));
      if (remaining.length === locks.length) return sendJSON(res, 404, { error: 'Periode ini tidak terkunci.' });
      writeJSON(PAYROLL_LOCKS_FILE, remaining);
      return sendJSON(res, 200, { ok: true });
    }

    // Export Slip Gaji ke .xlsx — HANYA karyawan yang dipilih (dicentang) di admin UI.
    if (pathName === '/api/payroll/export' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from || !to) return sendJSON(res, 400, { error: 'Parameter from dan to (YYYY-MM-DD) wajib diisi' });
      const phonesParam = (url.searchParams.get('employees') || '').trim();
      const selectedPhones = phonesParam ? phonesParam.split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (selectedPhones.length === 0) return sendJSON(res, 400, { error: 'Pilih minimal satu karyawan untuk di-export' });
      const selectedNames = new Set(config.employees.filter((e) => selectedPhones.includes(e.phone)).map((e) => e.name));

      const records = readJSON(RECORDS_FILE).filter((r) => r.dateKey >= from && r.dateKey <= to);
      const payroll = getPayrollForPeriod(records, config, from, to).filter((p) => selectedNames.has(p.employee));

      const todayStr = formatTanggalSlash(dateKeyJakarta(new Date().toISOString()));
      const periodeStr = `${formatTanggalIndo(from)} - ${formatTanggalIndo(to)}`;
      const B = XLSX_STYLE.BOLD, BU = XLSX_STYLE.BOLD_UNDERLINE, BT = XLSX_STYLE.BOLD_TOPBORDER;
      const bold = (v) => ({ v, s: B });
      const sect = (v) => ({ v, s: BU });
      const total = (v) => ({ v, s: BT });

      const sheets = payroll.map((p) => {
        const emp = config.employees.find((e) => e.name === p.employee) || {};
        const rows = [
          [bold('No ID'), ':', emp.idNumber || '-', '', bold('Department'), ':', emp.position || '-'],
          [bold('Nama'), ':', p.employee, '', bold('Periode'), ':', periodeStr],
          [],
          [sect('PENDAPATAN'), '', '', '', sect('POTONGAN'), '', ''],
          [bold('Gaji Pokok'), ':', formatRupiahServer(p.gajiPokok || 0), '', bold(`Tidak Masuk (${p.offBerlebih})`), ':', formatRupiahServer(p.potonganOff)],
          [bold('Tunjangan Fungsional'), ':', formatRupiahServer(p.tunjanganFungsional || 0), '', bold(`Terlambat (${p.terlambatKali} kali)`), ':', formatRupiahServer(p.potonganTerlambat)],
          [bold('Tunjangan Natura'), ':', formatRupiahServer(p.tunjanganNatura || 0), '', bold('Pulang Cepat'), ':', formatRupiahServer(p.potonganPulangCepat)],
          [bold('Uang Makan'), ':', formatRupiahServer(p.uangMakan), '', bold('Kasbon'), ':', formatRupiahServer(p.potonganKasbon || 0)],
          [bold(`Lembur Awal (${formatJamKoma(p.lemburAwalJam)} j)`), ':', formatRupiahServer(p.lemburAwalRp)],
          [bold(`Lembur Akhir (${formatJamKoma(p.lemburAkhirJam)} j)`), ':', formatRupiahServer(p.lemburAkhirRp)],
          [bold(`Lembur Tambahan (${formatJamKoma(p.lemburTambahanJam)} j)`), ':', formatRupiahServer(p.lemburTambahanRp)],
          [],
          [total('TOTAL PENDAPATAN'), total(':'), total(formatRupiahServer(p.totalPendapatan)), '', total('TOTAL POTONGAN'), total(':'), total(formatRupiahServer(p.totalPotongan))],
          [],
          [total('KERAJINAN'), total(':'), total(formatRupiahServer(p.kerajinanEligible ? p.kerajinan : 0))],
          [total('TRANSPORT'), total(':'), total(formatRupiahServer(p.uangTransport))],
          [total('GAJI BERSIH'), total(':'), total(formatRupiahServer(p.gajiBersih)), '', '', '', total(todayStr)],
        ];
        return { name: safeSheetName(p.employee), rows };
      });
      if (sheets.length === 0) sheets.push({ name: 'Slip Gaji', rows: [['Tidak ada data']] });

      const xlsxBuffer = buildXlsx(sheets);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="slip-gaji-${from}_${to}.xlsx"`,
      });
      return res.end(xlsxBuffer);
    }

    // ---- Laporan untuk otomasi (dilindungi report key, bukan token admin) ----
    if (pathName === '/api/daily-report' && req.method === 'GET') {
      const key = url.searchParams.get('key');
      if (key !== reportKey(config)) return sendJSON(res, 403, { error: 'Forbidden' });
      const date = url.searchParams.get('date') || dateKeyJakarta(new Date().toISOString());
      const records = readJSON(RECORDS_FILE)
        .filter((r) => r.dateKey === date)
        .sort((a, b) => a.timeHHMM.localeCompare(b.timeHHMM));

      if (records.length === 0) {
        return sendJSON(res, 200, { date, text: `Laporan Absensi ${date}\n\nTidak ada absen tercatat pada tanggal ini.` });
      }
      const lemburMap = computeLemburByEmployeeDate(records, config);
      const lines = records.map(
        (r) =>
          `- ${r.employee} | ${r.type === 'masuk' ? 'Masuk' : 'Keluar'} ${r.timeHHMM} WIB${r.shift ? ` (${r.shift})` : ''} | ${
            r.withinRadius
              ? `lokasi valid (${r.nearestLocation || 'kantor'})`
              : `di luar radius ${r.nearestLocation || 'kantor'} (${r.distanceMeters} m)`
          }`
      );
      const lemburLines = Object.entries(lemburMap)
        .filter(([, parts]) => totalLemburJam(parts) > 0)
        .map(([key, parts]) => `- ${key.split('|')[0]}: lembur ${totalLemburJam(parts)} jam`);
      const lemburSection = lemburLines.length ? `\n\nLembur:\n${lemburLines.join('\n')}` : '';
      const text = `Laporan Absensi ${date}\nTotal catatan: ${records.length}\n\n${lines.join('\n')}${lemburSection}`;
      return sendJSON(res, 200, { date, text, records });
    }

    if (pathName === '/api/monthly-report' && req.method === 'GET') {
      const key = url.searchParams.get('key');
      if (key !== reportKey(config)) return sendJSON(res, 403, { error: 'Forbidden' });
      const month = url.searchParams.get('month') || dateKeyJakarta(new Date().toISOString()).slice(0, 7);
      const records = readJSON(RECORDS_FILE).filter((r) => r.dateKey.startsWith(month));
      const lemburMap = computeLemburByEmployeeDate(records, config);

      const byEmployee = {};
      for (const emp of config.employees) {
        byEmployee[emp.name] = { employee: emp.name, hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0, lemburMenit: emptyLemburParts() };
      }
      for (const r of records) {
        if (!byEmployee[r.employee]) {
          byEmployee[r.employee] = { employee: r.employee, hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0, lemburMenit: emptyLemburParts() };
        }
        const e = byEmployee[r.employee];
        e.hariHadir.add(r.dateKey);
        e.totalAbsen += 1;
        if (!r.withinRadius) e.diLuarRadius += 1;
        const startTime = r.shiftStart || config.workStartTime;
        if (r.type === 'masuk' && startTime && r.timeHHMM > startTime) {
          e.terlambat += 1;
        }
      }
      for (const key of Object.keys(lemburMap)) {
        const [employee] = key.split('|');
        if (byEmployee[employee]) addLemburParts(byEmployee[employee].lemburMenit, lemburMap[key]);
      }
      const summary = Object.values(byEmployee).map((e) => ({
        employee: e.employee,
        hariHadir: e.hariHadir.size,
        totalAbsen: e.totalAbsen,
        diLuarRadius: e.diLuarRadius,
        terlambat: e.terlambat,
        lemburJam: totalLemburJam(e.lemburMenit),
      }));
      const lines = summary.map(
        (s) =>
          `- ${s.employee}: ${s.hariHadir} hari hadir, ${s.terlambat} kali terlambat, ${s.diLuarRadius} absen di luar radius, ${s.lemburJam} jam lembur`
      );
      const text = `Rekap Absensi Bulan ${month}\n\n${lines.join('\n')}`;
      return sendJSON(res, 200, { month, text, summary });
    }

    // ---- Rekap untuk rentang tanggal bebas (dipakai untuk periode gajian, misalnya 26 - 25) ----
    // Dilindungi report key, bukan token admin, supaya bisa dipanggil otomatis oleh scheduled task.
    if (pathName === '/api/period-report' && req.method === 'GET') {
      const key = url.searchParams.get('key');
      if (key !== reportKey(config)) return sendJSON(res, 403, { error: 'Forbidden' });
      const from = url.searchParams.get('from'); // YYYY-MM-DD
      const to = url.searchParams.get('to'); // YYYY-MM-DD
      if (!from || !to) return sendJSON(res, 400, { error: 'Parameter from dan to (YYYY-MM-DD) wajib diisi' });

      const records = readJSON(RECORDS_FILE)
        .filter((r) => r.dateKey >= from && r.dateKey <= to)
        .sort((a, b) => (a.dateKey + a.timeHHMM).localeCompare(b.dateKey + b.timeHHMM));

      const lemburMap = computeLemburByEmployeeDate(records, config);
      const byEmployee = {};
      for (const emp of config.employees) {
        byEmployee[emp.name] = { employee: emp.name, hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0, lemburMenit: emptyLemburParts() };
      }
      for (const r of records) {
        if (!byEmployee[r.employee]) {
          byEmployee[r.employee] = { employee: r.employee, hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0, lemburMenit: emptyLemburParts() };
        }
        const e = byEmployee[r.employee];
        e.hariHadir.add(r.dateKey);
        e.totalAbsen += 1;
        if (!r.withinRadius) e.diLuarRadius += 1;
        const startTime = r.shiftStart || config.workStartTime;
        if (r.type === 'masuk' && startTime && r.timeHHMM > startTime) {
          e.terlambat += 1;
        }
      }
      for (const key2 of Object.keys(lemburMap)) {
        const [employee] = key2.split('|');
        if (byEmployee[employee]) addLemburParts(byEmployee[employee].lemburMenit, lemburMap[key2]);
      }
      const summary = Object.values(byEmployee).map((e) => ({
        employee: e.employee,
        hariHadir: e.hariHadir.size,
        totalAbsen: e.totalAbsen,
        diLuarRadius: e.diLuarRadius,
        terlambat: e.terlambat,
        lemburJam: totalLemburJam(e.lemburMenit),
      }));

      const detail = records.map((r) => ({
        tanggal: r.dateKey,
        jam: r.timeHHMM,
        karyawan: r.employee,
        tipe: r.type === 'masuk' ? 'Masuk' : 'Keluar',
        shift: r.shift || '',
        lokasi: r.nearestLocation || '',
        validRadius: r.withinRadius ? 'Valid' : `Di luar radius (${r.distanceMeters} m)`,
      }));

      const payroll = getPayrollForPeriod(records, config, from, to);

      // Daftar kasbon yang masih aktif (belum lunas) per karyawan, untuk transparansi potongan
      // kasbon di laporan gaji (termasuk cicilan per bulan yang disepakati).
      const kasbonAll = readJSON(KASBON_FILE);
      const kasbonPayments = readJSON(KASBON_PAYMENTS_FILE);
      const kasbonAktif = kasbonAll
        .filter((k) => k.status !== 'ditolak' && k.status !== 'lunas')
        .map((k) => {
          const dibayar = kasbonPayments.filter((p) => p.kasbonId === k.id).reduce((s, p) => s + p.jumlah, 0);
          return {
            employee: k.employee, jenis: k.jenis, jumlah: k.jumlah,
            cicilanPerBulan: k.cicilanPerBulan || null, dibayar, sisa: Math.max(0, k.jumlah - dibayar),
            status: k.status, catatan: k.catatan || '',
          };
        });

      // Ledger kasbon (Task #49/#50) untuk laporan email bulanan: periode TERPISAH dari
      // periode gajian (26-25) di atas - pakai 1 bulan kalender penuh, yaitu bulan tempat
      // `to` jatuh (karena `to` selalu tanggal 25 bulan berjalan, dan gajian terjadi awal
      // bulan berikutnya, jadi "1 bulan sebelum gajian" = bulan berjalan itu sendiri).
      const kasbonBulan = to.slice(0, 7);
      const kasbonPeriode = monthRange(kasbonBulan);
      const kasbonLedger = config.employees.map((emp) => ({
        employee: emp.name,
        transaksi: buildKasbonLedger(emp.phone, kasbonPeriode.from, kasbonPeriode.to, kasbonAll, kasbonPayments),
      })).filter((e) => e.transaksi.length > 0);

      return sendJSON(res, 200, {
        from, to, summary, detail, payroll, kasbonAktif,
        kasbonLedgerPeriode: kasbonPeriode, kasbonLedger,
      });
    }

    // Backup seluruh data (semua file .json + foto absen + foto karyawan) dalam satu file .zip.
    if (pathName === '/api/backup' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const backupFiles = [];
      for (const f of fs.readdirSync(DATA_DIR)) {
        const full = path.join(DATA_DIR, f);
        if (f.endsWith('.json') && fs.statSync(full).isFile()) backupFiles.push({ name: f, data: fs.readFileSync(full) });
      }
      for (const dir of ['photos', 'employee-photos']) {
        const d = path.join(DATA_DIR, dir);
        if (!fs.existsSync(d)) continue;
        for (const f of fs.readdirSync(d)) {
          const full = path.join(d, f);
          if (fs.statSync(full).isFile()) backupFiles.push({ name: `${dir}/${f}`, data: fs.readFileSync(full) });
        }
      }
      const zipBuf = buildZipStore(backupFiles);
      const tanggal = dateKeyJakarta(new Date().toISOString());
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="backup-absensi-${tanggal}.zip"`,
        'Content-Length': zipBuf.length,
      });
      return res.end(zipBuf);
    }

    if (pathName === '/api/config' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const { adminPassword, ownerPasswordHash, ownerPasswordSalt, ...safeConfig } = config;
      return sendJSON(res, 200, { ...safeConfig, ownerPasswordSet: !!ownerPasswordHash });
    }

    // Profil admin (email dan password). Perubahan wajib memakai password lama.
    if (pathName === '/api/admin/profil' && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (body.passwordLama !== config.adminPassword) return sendJSON(res, 403, { error: 'Password lama salah.' });
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJSON(res, 400, { error: 'Email tidak valid.' });
      const passwordBaru = String(body.passwordBaru || '');
      if (passwordBaru && passwordBaru.length < 6) return sendJSON(res, 400, { error: 'Password baru minimal 6 karakter.' });
      if (passwordBaru && passwordBaru !== String(body.konfirmasi || '')) return sendJSON(res, 400, { error: 'Konfirmasi password tidak sama.' });
      const fresh = migrateConfig(readJSON(CONFIG_FILE));
      fresh.adminEmail = email;
      if (passwordBaru) fresh.adminPassword = passwordBaru;
      writeJSON(CONFIG_FILE, fresh);
      if (passwordBaru) revokeOtherAdminSessions(bearerToken(req));
      return sendJSON(res, 200, { ok: true, adminEmail: email, passwordDiganti: !!passwordBaru });
    }

    if (pathName === '/api/config' && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      // Password owner hanya bisa diubah lewat /api/owner-password (butuh password owner lama).
      delete body.ownerPasswordHash; delete body.ownerPasswordSalt; delete body.ownerPasswordSet;
      // Password admin hanya bisa diubah lewat /api/admin/profil (butuh password lama).
      delete body.adminPassword;
      const updated = { ...config, ...body };
      // Jangan biarkan password/email kosong tak sengaja
      if (!updated.adminPassword) updated.adminPassword = config.adminPassword;
      if (!updated.adminEmail) updated.adminEmail = config.adminEmail;
      writeJSON(CONFIG_FILE, updated);
      return sendJSON(res, 200, { ok: true });
    }

    // ---- Upload foto profil karyawan ----
    if (pathName === '/api/employees/photo' && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { phone, photoBase64 } = body;
      const fresh = migrateConfig(readJSON(CONFIG_FILE));
      const emp = fresh.employees.find((e) => e.phone === String(phone || '').trim());
      if (!emp) return sendJSON(res, 404, { error: 'Karyawan tidak ditemukan' });
      if (!photoBase64) return sendJSON(res, 400, { error: 'Foto kosong' });
      const filename = `${emp.phone}.jpg`;
      const base64Data = String(photoBase64).replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(path.join(EMPLOYEE_PHOTOS_DIR, filename), Buffer.from(base64Data, 'base64'));
      emp.photoFilename = filename;
      writeJSON(CONFIG_FILE, fresh);
      return sendJSON(res, 200, { ok: true, photoUrl: `/api/employee-photo/${encodeURIComponent(emp.phone)}` });
    }

    // ---- Import data karyawan dari CSV (ekspor dari Excel: File > Save As > CSV) ----
    // Kolom yang dikenali (header baris pertama, tidak case-sensitive, urutan bebas):
    // Nama / Name, No Telepon / Phone / No HP, No ID / NIK / ID, Jabatan / Posisi / Position
    if (pathName === '/api/employees/import' && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      // Bisa file Excel (.xlsx, dikirim base64) atau CSV (teks).
      let rows;
      if (body.xlsxBase64) {
        try {
          rows = parseXlsxRows(Buffer.from(String(body.xlsxBase64).replace(/^data:[^,]*,/, ''), 'base64'));
        } catch (e) {
          return sendJSON(res, 400, { error: 'File Excel tidak bisa dibaca: ' + e.message });
        }
      } else {
        const csvText = body.csv;
        if (!csvText || typeof csvText !== 'string') return sendJSON(res, 400, { error: 'File kosong atau tidak valid' });
        rows = parseCSV(csvText);
      }
      rows = rows.map((r) => r.map((v) => String(v ?? '')));
      if (rows.length < 2) return sendJSON(res, 400, { error: 'File tidak punya data (minimal 1 baris header + 1 baris data)' });

      const header = rows[0].map((h) => String(h).trim().toLowerCase());
      const findCol = (...names) => header.findIndex((h) => names.includes(h));
      const colName = findCol('nama', 'name');
      const colPhone = findCol('no telepon', 'telepon', 'phone', 'no hp', 'nomor telepon', 'nomor hp', 'hp');
      const colId = findCol('no id', 'nik', 'id', 'id number', 'nomor id');
      const colPos = findCol('jabatan', 'posisi', 'position');
      const colLokasiKerja = findCol('lokasi kerja', 'lokasi', 'outlet', 'cabang');

      if (colName === -1 || colPhone === -1) {
        return sendJSON(res, 400, { error: 'Kolom "Nama" dan "No Telepon" wajib ada di file.' });
      }

      const fresh = migrateConfig(readJSON(CONFIG_FILE));
      let added = 0, updated = 0;
      const errors = [];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const name = (r[colName] || '').trim();
        let phone = (r[colPhone] || '').trim();
        // Excel sering menyimpan nomor HP sebagai angka sehingga angka 0 di depan hilang (812... -> 0812...).
        if (/^8\d{7,}$/.test(phone)) phone = '0' + phone;
        const idNumber = colId !== -1 ? (r[colId] || '').trim() : '';
        const position = colPos !== -1 ? (r[colPos] || '').trim() : '';
        const lokasiKerja = colLokasiKerja !== -1 ? (r[colLokasiKerja] || '').trim() : '';
        if (!name || !phone) { errors.push(`Baris ${i + 1}: nama/no telepon kosong, dilewati`); continue; }

        const existing = fresh.employees.find((e) => e.phone === phone);
        if (existing) {
          existing.name = name;
          existing.idNumber = idNumber || existing.idNumber || '';
          existing.position = position || existing.position || '';
          existing.lokasiKerja = lokasiKerja || existing.lokasiKerja || '';
          updated++;
        } else {
          fresh.employees.push({ phone, name, idNumber, position, lokasiKerja, photoFilename: null });
          added++;
        }
      }
      writeJSON(CONFIG_FILE, fresh);
      return sendJSON(res, 200, { ok: true, added, updated, errors });
    }

    // ---- Export data karyawan ke CSV (bisa dibuka di Excel) ----
    if (pathName === '/api/employees/export' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const cols = ['Nama', 'No Telepon', 'No ID', 'Jabatan', 'Lokasi Kerja', 'Email', 'Tanggal Masuk', 'Status', 'Gaji Pokok', 'Upah Lembur Per Jam'];
      // Export data karyawan dalam format Excel (.xlsx).
      const rows = [cols];
      for (const e of config.employees) {
        rows.push([
          e.name, e.phone, e.idNumber || '', e.position || '', e.lokasiKerja || '', e.email || '',
          e.tanggalMasuk || '', e.status || 'aktif', Number(e.gajiPokok) || 0, Number(e.upahLemburPerJam) || 0,
        ]);
      }
      const xlsxBuffer = buildXlsx([{ name: 'Data Karyawan', rows }]);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="data-karyawan.xlsx"',
        'Content-Length': xlsxBuffer.length,
      });
      return res.end(xlsxBuffer);
    }

    // ---- Izin/Cuti ----
    // Karyawan mengajukan (tanpa login admin, identifikasi via nomor telepon).
    if (pathName === '/api/leaves' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { phone, type, startDate, endDate, reason } = body;
      const emp = config.employees.find((e) => e.phone === String(phone || '').trim());
      if (!emp) return sendJSON(res, 400, { error: 'Nomor telepon tidak terdaftar.' });
      if (!type || !startDate || !endDate) return sendJSON(res, 400, { error: 'Jenis, tanggal mulai, dan tanggal selesai wajib diisi.' });
      if (endDate < startDate) return sendJSON(res, 400, { error: 'Tanggal selesai tidak boleh sebelum tanggal mulai.' });
      const leaves = readJSON(LEAVES_FILE);
      const entry = {
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        phone: emp.phone, employee: emp.name, type, startDate, endDate,
        reason: reason || '', status: 'pending',
        createdAt: new Date().toISOString(), reviewedAt: null,
      };
      leaves.push(entry);
      writeJSON(LEAVES_FILE, leaves);
      const jenisLabel = { sakit: 'Sakit', cuti: 'Cuti', izin: 'Izin' };
      addAdminNotification(`${emp.name} mengajukan ${jenisLabel[type] || type} (${startDate} s.d. ${endDate})`, 'leave_new', entry.id);
      return sendJSON(res, 200, { ok: true, leave: entry });
    }
    // Riwayat pengajuan izin/cuti milik karyawan sendiri.
    if (pathName === '/api/my-leaves' && req.method === 'GET') {
      const phone = String(url.searchParams.get('phone') || '').trim();
      const leaves = readJSON(LEAVES_FILE).filter((l) => l.phone === phone)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return sendJSON(res, 200, { leaves });
    }
    // Admin: daftar semua pengajuan izin/cuti, opsional filter per tanggal (yang sedang berjalan pada tanggal itu) atau status.
    if (pathName === '/api/leaves' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      let leaves = readJSON(LEAVES_FILE);
      const date = url.searchParams.get('date');
      const status = url.searchParams.get('status');
      if (date) leaves = leaves.filter((l) => l.startDate <= date && date <= l.endDate);
      if (status) leaves = leaves.filter((l) => l.status === status);
      leaves.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return sendJSON(res, 200, { leaves });
    }
    // Export rekap Izin/Cuti ke .xlsx. Tanpa param date/status = semua data ("Semua Data" di UI).
    // Dengan date/status = sesuai filter yang lagi aktif ("Sesuai Filter" di UI).
    if (pathName === '/api/leaves/export' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      let leaves = readJSON(LEAVES_FILE);
      const date = url.searchParams.get('date');
      const status = url.searchParams.get('status');
      if (date) leaves = leaves.filter((l) => l.startDate <= date && date <= l.endDate);
      if (status) leaves = leaves.filter((l) => l.status === status);
      leaves.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

      const statusLabel = { pending: 'Pending', approved: 'Disetujui', rejected: 'Ditolak' };
      const typeLabel = { sakit: 'Sakit', cuti: 'Cuti', izin: 'Izin' };
      const headerRow = ['Nama', 'Jenis', 'Mulai', 'Selesai', 'Alasan', 'Status'];
      const dataRows = leaves.map((l) => [
        l.employee || '', typeLabel[l.type] || l.type || '', l.startDate || '', l.endDate || '', l.reason || '', statusLabel[l.status] || l.status || '',
      ]);
      const xlsxBuffer = buildXlsx([{ name: 'Izin Cuti', rows: [headerRow, ...dataRows] }]);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="izin-cuti${date ? '-' + date : ''}${status ? '-' + status : ''}.xlsx"`,
      });
      return res.end(xlsxBuffer);
    }
    // Admin: daftar notifikasi admin (pengajuan cuti/izin & kasbon baru) + jumlah belum dibaca.
    if (pathName === '/api/admin-notifications' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const notifications = readJSON(ADMIN_NOTIFICATIONS_FILE).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const unreadCount = notifications.filter((n) => !n.read).length;
      return sendJSON(res, 200, { notifications, unreadCount });
    }
    // Admin: tandai satu notifikasi admin sudah dibaca.
    if (pathName.startsWith('/api/admin-notifications/') && pathName.endsWith('/read') && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const id = pathName.split('/')[3];
      const notifications = readJSON(ADMIN_NOTIFICATIONS_FILE);
      const n = notifications.find((x) => x.id === id);
      if (!n) return sendJSON(res, 404, { error: 'Notifikasi tidak ditemukan' });
      n.read = true;
      writeJSON(ADMIN_NOTIFICATIONS_FILE, notifications);
      return sendJSON(res, 200, { ok: true });
    }
    // Admin: tandai semua notifikasi admin sudah dibaca.
    if (pathName === '/api/admin-notifications/read-all' && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const notifications = readJSON(ADMIN_NOTIFICATIONS_FILE);
      notifications.forEach((n) => { n.read = true; });
      writeJSON(ADMIN_NOTIFICATIONS_FILE, notifications);
      return sendJSON(res, 200, { ok: true });
    }
    // Admin: approve/reject pengajuan.
    if (pathName.startsWith('/api/leaves/') && pathName.endsWith('/approve') && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const id = pathName.split('/')[3];
      const leaves = readJSON(LEAVES_FILE);
      const l = leaves.find((x) => x.id === id);
      if (!l) return sendJSON(res, 404, { error: 'Pengajuan tidak ditemukan' });
      l.status = 'approved'; l.reviewedAt = new Date().toISOString();
      writeJSON(LEAVES_FILE, leaves);
      addNotification(l.phone, 'Pengajuan Cuti/Izin Anda telah diterima.', 'leave_approved');
      return sendJSON(res, 200, { ok: true });
    }
    if (pathName.startsWith('/api/leaves/') && pathName.endsWith('/reject') && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const id = pathName.split('/')[3];
      const leaves = readJSON(LEAVES_FILE);
      const l = leaves.find((x) => x.id === id);
      if (!l) return sendJSON(res, 404, { error: 'Pengajuan tidak ditemukan' });
      l.status = 'rejected'; l.reviewedAt = new Date().toISOString();
      writeJSON(LEAVES_FILE, leaves);
      addNotification(l.phone, 'Pengajuan Cuti/Izin Anda telah ditolak.', 'leave_rejected');
      return sendJSON(res, 200, { ok: true });
    }

    // Admin: input izin/cuti langsung untuk karyawan. Status default Disetujui (langsung berlaku).
    if (pathName === '/api/leaves/admin' && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const err = validasiLeaveAdmin(body, config);
      if (err) return sendJSON(res, 400, { error: err });
      const emp = config.employees.find((e) => e.phone === String(body.phone).trim());
      const status = body.status || 'approved';
      const now = new Date().toISOString();
      const leaves = readJSON(LEAVES_FILE);
      const entry = {
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        phone: emp.phone, employee: emp.name, type: body.type, startDate: body.startDate, endDate: body.endDate,
        reason: String(body.reason || ''), status,
        createdAt: now, reviewedAt: status === 'pending' ? null : now, createdBy: 'admin',
      };
      leaves.push(entry);
      writeJSON(LEAVES_FILE, leaves);
      return sendJSON(res, 200, { ok: true, leave: entry });
    }
    // Admin: ubah data izin/cuti (jenis, karyawan, tanggal, alasan, status).
    if (pathName.startsWith('/api/leaves/') && req.method === 'PUT') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const id = pathName.split('/')[3];
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const err = validasiLeaveAdmin(body, config);
      if (err) return sendJSON(res, 400, { error: err });
      const leaves = readJSON(LEAVES_FILE);
      const l = leaves.find((x) => x.id === id);
      if (!l) return sendJSON(res, 404, { error: 'Pengajuan tidak ditemukan' });
      const emp = config.employees.find((e) => e.phone === String(body.phone).trim());
      const status = body.status || l.status;
      if (status !== l.status) l.reviewedAt = status === 'pending' ? null : new Date().toISOString();
      Object.assign(l, {
        phone: emp.phone, employee: emp.name, type: body.type, startDate: body.startDate, endDate: body.endDate,
        reason: String(body.reason || ''), status,
      });
      writeJSON(LEAVES_FILE, leaves);
      return sendJSON(res, 200, { ok: true, leave: l });
    }

    // ---- Kasbon ----
    // Karyawan mengajukan kasbon baru.
    if (pathName === '/api/kasbon' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { phone, jenis, jumlah, cicilanPerBulan, catatan } = body;
      const emp = config.employees.find((e) => e.phone === String(phone || '').trim());
      if (!emp) return sendJSON(res, 400, { error: 'Nomor telepon tidak terdaftar.' });
      if (!['cicil', 'potlang'].includes(jenis)) return sendJSON(res, 400, { error: 'Jenis kasbon harus "cicil" atau "potlang".' });
      const jml = Number(jumlah);
      if (!jml || jml <= 0) return sendJSON(res, 400, { error: 'Jumlah pinjaman harus lebih dari 0.' });
      let cicilan = null;
      if (jenis === 'cicil') {
        cicilan = Number(cicilanPerBulan);
        if (!cicilan || cicilan <= 0) return sendJSON(res, 400, { error: 'Cicilan per bulan harus diisi untuk kasbon cicil.' });
      }
      const kasbonList = readJSON(KASBON_FILE);
      const entry = {
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        phone: emp.phone, employee: emp.name, jenis, jumlah: jml, cicilanPerBulan: cicilan, catatan: catatan || '',
        status: 'pending', // pending -> disetujui admin -> lunas
        tanggal: dateKeyJakarta(new Date().toISOString()),
        createdAt: new Date().toISOString(),
      };
      kasbonList.push(entry);
      writeJSON(KASBON_FILE, kasbonList);
      addAdminNotification(`${emp.name} mengajukan kasbon ${jenis === 'cicil' ? 'cicil' : 'potong lunas'} sebesar Rp${jml.toLocaleString('id-ID')}`, 'kasbon_new', entry.id);
      return sendJSON(res, 200, { ok: true, kasbon: entry });
    }
    // Admin: input kasbon manual langsung (Task #48) - dua kegunaan: (1) catat "sisa kasbon
    // bulan lalu" (data lama yang sebelumnya dicatat manual di luar sistem) lewat field
    // sudahDibayar, (2) bikin kasbon tambahan baru kapan aja tanpa lewat pengajuan karyawan.
    // Beda dari POST /api/kasbon (dipanggil app karyawan): endpoint ini butuh login admin,
    // statusnya langsung 'disetujui' (skip approval), dan bisa sekaligus catat jumlah yang
    // sudah dibayar sebagai payment awal/backdated supaya sisa langsung akurat.
    if (pathName === '/api/kasbon/admin-create' && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { phone, jenis, jumlah, cicilanPerBulan, catatan, tanggal, sudahDibayar } = body;
      const emp = config.employees.find((e) => e.phone === String(phone || '').trim());
      if (!emp) return sendJSON(res, 400, { error: 'Karyawan tidak ditemukan.' });
      if (!['cicil', 'potlang'].includes(jenis)) return sendJSON(res, 400, { error: 'Jenis kasbon harus "cicil" atau "potlang".' });
      const jml = Number(jumlah);
      if (!jml || jml <= 0) return sendJSON(res, 400, { error: 'Jumlah pinjaman harus lebih dari 0.' });
      let cicilan = null;
      if (jenis === 'cicil') {
        cicilan = Number(cicilanPerBulan);
        if (!cicilan || cicilan <= 0) return sendJSON(res, 400, { error: 'Cicilan per bulan harus diisi untuk kasbon cicil.' });
      }
      const tgl = (tanggal && /^\d{4}-\d{2}-\d{2}$/.test(tanggal)) ? tanggal : dateKeyJakarta(new Date().toISOString());
      const kasbonList = readJSON(KASBON_FILE);
      const entry = {
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        phone: emp.phone, employee: emp.name, jenis, jumlah: jml, cicilanPerBulan: cicilan, catatan: catatan || '',
        status: 'disetujui', // admin yang input langsung, tidak perlu approval
        tanggal: tgl,
        createdAt: new Date().toISOString(),
      };
      kasbonList.push(entry);

      let dibayarAwal = Math.max(0, Number(sudahDibayar) || 0);
      if (dibayarAwal > jml) dibayarAwal = jml;
      if (dibayarAwal > 0) {
        const payments = readJSON(KASBON_PAYMENTS_FILE);
        payments.push({
          id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          kasbonId: entry.id, phone: emp.phone, employee: emp.name, jumlah: dibayarAwal,
          tanggal: tgl, createdAt: new Date().toISOString(),
        });
        writeJSON(KASBON_PAYMENTS_FILE, payments);
        if (dibayarAwal >= jml) entry.status = 'lunas';
      }
      writeJSON(KASBON_FILE, kasbonList);
      return sendJSON(res, 200, { ok: true, kasbon: entry });
    }
    // Riwayat kasbon milik karyawan sendiri + sisa.
    if (pathName === '/api/my-kasbon' && req.method === 'GET') {
      const phone = String(url.searchParams.get('phone') || '').trim();
      const kasbonList = readJSON(KASBON_FILE).filter((k) => k.phone === phone);
      const payments = readJSON(KASBON_PAYMENTS_FILE);
      const result = kasbonList.map((k) => {
        const dibayar = payments.filter((p) => p.kasbonId === k.id).reduce((s, p) => s + p.jumlah, 0);
        return { ...k, dibayar, sisa: Math.max(0, k.jumlah - dibayar) };
      }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return sendJSON(res, 200, { kasbon: result });
    }
    // Riwayat notifikasi milik karyawan sendiri (status pengajuan cuti/izin & kasbon).
    // ---- Jadwal kerja ----
    // Admin: unduh template Excel jadwal untuk satu bulan (nama karyawan aktif sudah terisi).
    if (pathName === '/api/jadwal/template' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const month = String(url.searchParams.get('month') || '');
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return sendJSON(res, 400, { error: 'Bulan tidak valid (format YYYY-MM)' });
      const jabatan = String(url.searchParams.get('jabatan') || '').trim();
      const lokasi = String(url.searchParams.get('lokasi') || '').trim();
      const nama = config.employees.filter((e) => e.status !== 'nonaktif' && cocokGrupJadwal(e, jabatan, lokasi)).map((e) => e.name);
      const rows = buatTemplateJadwal(month, nama, { TEBAL: XLSX_STYLE.BOLD, BIRU: XLSX_STYLE.FILL_BIRU, HIJAU: XLSX_STYLE.FILL_HIJAU });
      const xlsxBuffer = buildXlsx([{ name: 'Jadwal', rows }]);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="template-jadwal-${month}${[jabatan, lokasi].filter(Boolean).map((v) => '-' + v.replace(/[^A-Za-z0-9]+/g, '_')).join('')}.xlsx"`,
      });
      return res.end(xlsxBuffer);
    }

    // Admin upload file Excel jadwal bulanan. Jadwal langsung terlihat karyawan setelah diupload.
    if (pathName === '/api/jadwal/upload' && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const month = String(body.month || '');
      if (!body.base64) return sendJSON(res, 400, { error: 'File jadwal belum dipilih' });
      let data;
      const jabatan = String(body.jabatan || '').trim();
      const lokasi = String(body.lokasi || '').trim();
      try { data = parseJadwalXlsx(Buffer.from(String(body.base64), 'base64'), month, kodeShiftJabatan(config, jabatan, lokasi)); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
      // Teks pendek mirip kode shift yang tidak dikenal untuk jabatan ini: beri peringatan ke admin.
      const kodeTakDikenal = new Set();
      for (const r of data.rows) for (const e of Object.values(r.days)) if (e.teks && /^[A-Za-z0-9]{1,4}$/.test(String(e.teks).trim())) kodeTakDikenal.add(String(e.teks).trim().toUpperCase());
      if (kodeTakDikenal.size) data.warnings = [...(data.warnings || []), `Kode ${[...kodeTakDikenal].join(", ")} tidak terdaftar di Kode Shift ${jabatan || "default"}. Sel tersebut tampil sebagai teks biasa.`];
      const all = readJSON(JADWAL_FILE);
      const kunci = kunciJadwal(month, jabatan, lokasi);
      const prev = all[kunci];
      const uploadedAt = new Date().toISOString();
      const file = String(body.filename || '').slice(0, 200);
      const notesGabung = [...(prev && prev.notes ? prev.notes : []), ...(data.notes || [])];
      all[kunci] = {
        month,
        jabatan,
        lokasi,
        uploadedAt,
        uploadedFile: file,
        uploads: [...(prev && prev.uploads ? prev.uploads : []), { uploadedAt, uploadedFile: file, jumlahBaris: data.rows.length }],
        rows: gabungRowsJadwal(prev && prev.rows ? prev.rows : [], data.rows),
        legend: data.legend,
        notes: [...new Map(notesGabung.map((n) => [JSON.stringify(n), n])).values()],
        mismatches: data.mismatches,
        warnings: data.warnings,
        sharedAt: prev ? prev.sharedAt : null,
        sharedPhones: prev ? prev.sharedPhones : [],
        shareHistory: prev ? prev.shareHistory : [],
      };
      writeJSON(JADWAL_FILE, all);
      return sendJSON(res, 200, { ok: true, month, jumlahKaryawan: data.rows.length, legend: data.legend, notes: data.notes, mismatches: data.mismatches, warnings: data.warnings, digabung: !!prev });
    }

    // Admin: lihat jadwal satu bulan + daftar karyawan (untuk memilih siapa yang dibagikan).
    if (pathName === '/api/jadwal' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const month = String(url.searchParams.get('month') || '');
      const jabatan = String(url.searchParams.get('jabatan') || '').trim();
      const lokasi = String(url.searchParams.get('lokasi') || '').trim();
      const semuaJadwal = readJSON(JADWAL_FILE);
      const data = semuaJadwal[kunciJadwal(month, jabatan, lokasi)] || null;
      const karyawan = config.employees.map((e) => ({ name: e.name, phone: e.phone, status: e.status || 'aktif' }));
      const unik = (arr) => [...new Map(arr.map((v) => String(v || '').trim()).filter(Boolean).map((v) => [normGrupJadwal(v), v])).values()].sort((a, b) => a.localeCompare(b));
      const pilihanJabatan = unik(config.employees.map((e) => e.position));
      const pilihanLokasi = unik([...config.employees.map((e) => e.lokasiKerja), ...(config.locations || []).map((l) => l.name)]);
      const grupBulanIni = Object.values(semuaJadwal).filter((m) => m.month === month)
        .map((m) => ({ jabatan: m.jabatan || '', lokasi: m.lokasi || '', jumlah: (m.rows || []).length }));
      const kodeInfo = kodeShiftUntuk(config, jabatan, lokasi);
      const kodeShift = kodeInfo.kode;
      const rows = data ? data.rows.map((r) => {
        const emp = config.employees.find((e) => normalizeNamaJadwal(e.name) === normalizeNamaJadwal(r.name));
        return { name: r.name, phone: emp ? emp.phone : null, days: r.days };
      }) : [];
      return sendJSON(res, 200, { month, jabatan, lokasi, jadwal: data ? { ...data, rows } : null, karyawan, pilihanJabatan, pilihanLokasi, grupBulanIni, kodeShift, kodeShiftSumber: kodeInfo.sumber });
    }

    // Admin: ubah kode shift untuk satu jabatan. Daftar kosong = kembali ke kode default.
    if (pathName === '/api/jadwal/kode-shift' && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const kunci = kunciKodeShift(body.jabatan, body.lokasi);
      const daftar = Array.isArray(body.kode) ? body.kode : [];
      const hasil = {};
      for (const k of daftar) {
        const kode = String(k.kode || '').trim().toUpperCase();
        const label = String(k.label || '').trim().slice(0, 40);
        const mulai = String(k.mulai || '').trim(), selesai = String(k.selesai || '').trim();
        if (!/^[A-Z0-9]{1,4}$/.test(kode)) return sendJSON(res, 400, { error: `Kode "${kode || '(kosong)'}" tidak valid. Pakai 1-4 huruf atau angka.` });
        if (kode === 'X') return sendJSON(res, 400, { error: 'Kode X sudah dipakai untuk libur.' });
        if (hasil[kode]) return sendJSON(res, 400, { error: `Kode ${kode} ditulis lebih dari sekali.` });
        if (!/^\d{2}:\d{2}$/.test(mulai) || !/^\d{2}:\d{2}$/.test(selesai)) return sendJSON(res, 400, { error: `Jam untuk kode ${kode} belum lengkap.` });
        hasil[kode] = { label: label || kode, jam: `${mulai}-${selesai}` };
      }
      const fresh = migrateConfig(readJSON(CONFIG_FILE));
      fresh.jadwalKodeShift = { ...(fresh.jadwalKodeShift || {}) };
      if (Object.keys(hasil).length) fresh.jadwalKodeShift[kunci] = hasil;
      else delete fresh.jadwalKodeShift[kunci];
      writeJSON(CONFIG_FILE, fresh);
      return sendJSON(res, 200, { ok: true, kodeShift: kodeShiftJabatan(fresh, body.jabatan, body.lokasi) });
    }

    // Admin: bagikan jadwal ke karyawan yang dipilih. Setiap karyawan dapat notifikasi.
    if (pathName === '/api/jadwal/share' && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const month = String(body.month || '');
      const all = readJSON(JADWAL_FILE);
      const kunci = kunciJadwal(month, body.jabatan, body.lokasi);
      const data = all[kunci];
      if (!data) return sendJSON(res, 404, { error: 'Jadwal bulan ini belum diupload' });
      const pilihan = Array.isArray(body.phones) ? body.phones.map((p) => String(p)) : [];
      const terpilih = config.employees.filter((e) => pilihan.includes(String(e.phone))
        && data.rows.some((r) => normalizeNamaJadwal(r.name) === normalizeNamaJadwal(e.name)));
      if (terpilih.length === 0) return sendJSON(res, 400, { error: 'Pilih minimal satu karyawan yang punya jadwal di bulan ini' });
      const [y, m] = month.split('-').map(Number);
      const namaBulan = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'][m - 1];
      const at = new Date().toISOString();
      for (const e of terpilih) {
        addNotification(e.phone, `Jadwal kerja ${namaBulan} ${y} sudah dibagikan. Buka menu Jadwal untuk melihatnya.`, 'jadwal');
      }
      data.sharedAt = at;
      data.sharedPhones = [...new Set([...(data.sharedPhones || []), ...terpilih.map((e) => e.phone)])];
      data.shareHistory = [...(data.shareHistory || []), { at, phones: terpilih.map((e) => e.phone) }];
      all[kunci] = data;
      writeJSON(JADWAL_FILE, all);
      return sendJSON(res, 200, { ok: true, dibagikan: terpilih.length });
    }

    // Karyawan: jadwal kerja miliknya dari semua bulan yang sudah diupload (tidak perlu menunggu dibagikan).
    if (pathName === '/api/my-jadwal' && req.method === 'GET') {
      const phone = String(url.searchParams.get('phone') || '').trim();
      const emp = config.employees.find((e) => e.phone === phone);
      if (!emp) return sendJSON(res, 200, { bulan: [] });
      // Satu jadwal per bulan. Kalau nama karyawan ada di beberapa jadwal pada bulan yang sama,
      // pakai jadwal yang jabatan dan lokasinya cocok dengan data karyawan, lalu yang terakhir diupload.
      const perBulan = new Map();
      for (const m of Object.values(readJSON(JADWAL_FILE))) {
        const kode = kodeShiftJabatan(config, m.jabatan, m.lokasi);
        const hari = jadwalUntukKaryawan(m, emp.name, kode);
        if (!hari.length) continue;
        const skor = (m.jabatan || m.lokasi) ? (cocokGrupJadwal(emp, m.jabatan, m.lokasi) ? 2 : 1) : 0;
        const kandidat = { month: m.month, uploadedAt: m.uploadedAt, jabatan: m.jabatan || '', lokasi: m.lokasi || '', hari, legend: m.legend, notes: m.notes, kodeShift: kode, skor };
        const ada = perBulan.get(m.month);
        if (!ada || skor > ada.skor || (skor === ada.skor && String(m.uploadedAt) > String(ada.uploadedAt))) perBulan.set(m.month, kandidat);
      }
      const bulan = [...perBulan.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
      return sendJSON(res, 200, { bulan, namaHari: WEEKDAY_NAMES });
    }

    if (pathName === '/api/my-notifications' && req.method === 'GET') {
      const phone = String(url.searchParams.get('phone') || '').trim();
      generateLupaAbsenReminders(phone, config);
      const notifications = readJSON(NOTIFICATIONS_FILE)
        .filter((n) => n.phone === phone)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return sendJSON(res, 200, { notifications });
    }
    // Tandai semua notifikasi milik karyawan sebagai sudah dibaca.
    if (pathName === '/api/notifications/mark-read' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const phone = String(body.phone || '').trim();
      const notifications = readJSON(NOTIFICATIONS_FILE);
      let changed = false;
      notifications.forEach((n) => { if (n.phone === phone && !n.read) { n.read = true; changed = true; } });
      if (changed) writeJSON(NOTIFICATIONS_FILE, notifications);
      return sendJSON(res, 200, { ok: true });
    }

    // Admin: daftar semua kasbon + sisa per karyawan (dipakai menu Kasbon & Dashboard).
    if (pathName === '/api/kasbon' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const kasbonList = readJSON(KASBON_FILE);
      const payments = readJSON(KASBON_PAYMENTS_FILE);
      const result = kasbonList.map((k) => {
        const dibayar = payments.filter((p) => p.kasbonId === k.id).reduce((s, p) => s + p.jumlah, 0);
        return { ...k, dibayar, sisa: Math.max(0, k.jumlah - dibayar) };
      }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return sendJSON(res, 200, { kasbon: result });
    }
    // Export rekap Kasbon ke .xlsx — seluruh data (halaman Kasbon tidak punya filter tanggal/status).
    // Export Laporan Kasbon (Task #49): format LEDGER per transaksi per karyawan, bukan
    // tabel ringkasan flat. Periode = 1 bulan kalender penuh (param "bulan"=YYYY-MM), beda
    // dari periode gajian 26-25. Kolom Sisa = saldo berjalan dihitung dari SELURUH histori
    // kasbon karyawan (bukan cuma transaksi yang masuk periode filter), supaya angkanya
    // nyambung dari bulan-bulan sebelumnya - tapi baris yang DITAMPILKAN tetap difilter
    // sesuai bulan yang dipilih.
    if (pathName === '/api/kasbon/export' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const bulan = url.searchParams.get('bulan'); // YYYY-MM
      if (!bulan || !/^\d{4}-\d{2}$/.test(bulan)) return sendJSON(res, 400, { error: 'Parameter bulan (YYYY-MM) wajib diisi' });
      const { from, to } = monthRange(bulan);
      const phonesParam = (url.searchParams.get('employees') || '').trim();
      const selectedPhones = phonesParam ? phonesParam.split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (selectedPhones.length === 0) return sendJSON(res, 400, { error: 'Pilih minimal satu karyawan untuk di-export' });

      const kasbonAll = readJSON(KASBON_FILE);
      const payments = readJSON(KASBON_PAYMENTS_FILE);
      const BU = XLSX_STYLE.BOLD_UNDERLINE;
      const bold = (v) => ({ v, s: XLSX_STYLE.BOLD });
      const headerCell = (v) => ({ v, s: BU });

      const sheets = selectedPhones.map((phone) => {
        const emp = config.employees.find((e) => e.phone === phone);
        const employeeName = emp ? emp.name : phone;
        const ledger = buildKasbonLedger(phone, from, to, kasbonAll, payments);

        const rows = [
          [bold('No ID'), ':', emp ? (emp.idNumber || '-') : '-'],
          [bold('Nama Karyawan'), ':', employeeName],
          [bold('Periode'), ':', `${formatTanggalSlash(from)} s/d ${formatTanggalSlash(to)}`],
          [],
          [headerCell('Tanggal'), headerCell('Kasbon: Cicil'), headerCell('Kasbon: Potlang'), headerCell('Bayar: Cicil'), headerCell('Bayar: Potlang'), headerCell('Sisa')],
        ];
        ledger.forEach((t) => {
          rows.push([
            formatTanggalSlash(t.tanggal),
            t.tipe === 'pinjam' && t.jenis === 'cicil' ? formatRupiahServer(t.jumlah) : '',
            t.tipe === 'pinjam' && t.jenis === 'potlang' ? formatRupiahServer(t.jumlah) : '',
            t.tipe === 'bayar' && t.jenis === 'cicil' ? formatRupiahServer(t.jumlah) : '',
            t.tipe === 'bayar' && t.jenis === 'potlang' ? formatRupiahServer(t.jumlah) : '',
            formatRupiahServer(t.saldoSetelah),
          ]);
        });
        if (ledger.length === 0) rows.push(['Tidak ada transaksi kasbon pada periode ini.']);

        return { name: safeSheetName(employeeName), rows };
      });

      const xlsxBuffer = buildXlsx(sheets);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="laporan-kasbon-${bulan}.xlsx"`,
      });
      return res.end(xlsxBuffer);
    }
    // Admin: setujui pengajuan kasbon.
    if (pathName.startsWith('/api/kasbon/') && pathName.endsWith('/approve') && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const id = pathName.split('/')[3];
      const kasbonList = readJSON(KASBON_FILE);
      const k = kasbonList.find((x) => x.id === id);
      if (!k) return sendJSON(res, 404, { error: 'Kasbon tidak ditemukan' });
      k.status = 'disetujui';
      writeJSON(KASBON_FILE, kasbonList);
      addNotification(k.phone, 'Pengajuan Kasbon Anda telah diterima.', 'kasbon_approved');
      return sendJSON(res, 200, { ok: true });
    }
    // Admin: tolak pengajuan kasbon.
    if (pathName.startsWith('/api/kasbon/') && pathName.endsWith('/reject') && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const id = pathName.split('/')[3];
      const kasbonList = readJSON(KASBON_FILE);
      const k = kasbonList.find((x) => x.id === id);
      if (!k) return sendJSON(res, 404, { error: 'Kasbon tidak ditemukan' });
      k.status = 'ditolak';
      writeJSON(KASBON_FILE, kasbonList);
      addNotification(k.phone, 'Pengajuan Kasbon Anda telah ditolak.', 'kasbon_rejected');
      return sendJSON(res, 200, { ok: true });
    }
    // Admin: edit data kasbon (perbaikan kesalahan input).
    if (pathName.startsWith('/api/kasbon/') && pathName.split('/').length === 4 && req.method === 'PUT') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const id = pathName.split('/')[3];
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const kasbonList = readJSON(KASBON_FILE);
      const k = kasbonList.find((x) => x.id === id);
      if (!k) return sendJSON(res, 404, { error: 'Kasbon tidak ditemukan' });
      if (body.jenis && ['cicil', 'potlang'].includes(body.jenis)) k.jenis = body.jenis;
      if (body.jumlah !== undefined) {
        const jml = Number(body.jumlah);
        if (!jml || jml <= 0) return sendJSON(res, 400, { error: 'Jumlah pinjaman harus lebih dari 0.' });
        k.jumlah = jml;
      }
      if (k.jenis === 'cicil') {
        if (body.cicilanPerBulan !== undefined) {
          const cicilan = Number(body.cicilanPerBulan);
          if (!cicilan || cicilan <= 0) return sendJSON(res, 400, { error: 'Cicilan per bulan harus lebih dari 0.' });
          k.cicilanPerBulan = cicilan;
        }
      } else {
        k.cicilanPerBulan = null;
      }
      if (body.catatan !== undefined) k.catatan = body.catatan;
      writeJSON(KASBON_FILE, kasbonList);
      return sendJSON(res, 200, { ok: true, kasbon: k });
    }
    // Admin: hapus data kasbon (beserta histori pembayarannya).
    if (pathName.startsWith('/api/kasbon/') && pathName.split('/').length === 4 && req.method === 'DELETE') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const id = pathName.split('/')[3];
      let kasbonList = readJSON(KASBON_FILE);
      const exists = kasbonList.find((x) => x.id === id);
      if (!exists) return sendJSON(res, 404, { error: 'Kasbon tidak ditemukan' });
      kasbonList = kasbonList.filter((x) => x.id !== id);
      writeJSON(KASBON_FILE, kasbonList);
      const payments = readJSON(KASBON_PAYMENTS_FILE).filter((p) => p.kasbonId !== id);
      writeJSON(KASBON_PAYMENTS_FILE, payments);
      return sendJSON(res, 200, { ok: true });
    }
    // Admin: catat pembayaran/cicilan kasbon (dipotong dari gaji atau dibayar manual).
    if (pathName.startsWith('/api/kasbon/') && pathName.endsWith('/bayar') && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const id = pathName.split('/')[3];
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const kasbonList = readJSON(KASBON_FILE);
      const k = kasbonList.find((x) => x.id === id);
      if (!k) return sendJSON(res, 404, { error: 'Kasbon tidak ditemukan' });
      const payments = readJSON(KASBON_PAYMENTS_FILE);
      const dibayarSoFar = payments.filter((p) => p.kasbonId === id).reduce((s, p) => s + p.jumlah, 0);
      const sisa = Math.max(0, k.jumlah - dibayarSoFar);
      let jumlah = Number(body.jumlah);
      if (k.jenis === 'potlang' || !jumlah) jumlah = sisa; // potlang selalu lunas sekaligus
      if (jumlah <= 0) return sendJSON(res, 400, { error: 'Tidak ada sisa kasbon untuk dibayar.' });
      if (jumlah > sisa) jumlah = sisa;
      payments.push({
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        kasbonId: id, phone: k.phone, employee: k.employee, jumlah,
        tanggal: body.tanggal || dateKeyJakarta(new Date().toISOString()),
        createdAt: new Date().toISOString(),
      });
      writeJSON(KASBON_PAYMENTS_FILE, payments);
      if (jumlah >= sisa) { k.status = 'lunas'; writeJSON(KASBON_FILE, kasbonList); }
      return sendJSON(res, 200, { ok: true });
    }

    // ---- Dashboard: ringkasan live hari ini ----
    if (pathName === '/api/dashboard-summary' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const todayKey = dateKeyJakarta(new Date().toISOString());
      const recordsToday = readJSON(RECORDS_FILE).filter((r) => r.dateKey === todayKey);
      const karyawanMasuk = new Set(recordsToday.filter((r) => r.type === 'masuk').map((r) => r.employee)).size;
      const leavesToday = readJSON(LEAVES_FILE).filter((l) => l.status === 'approved' && l.startDate <= todayKey && todayKey <= l.endDate);
      const positionByName = {};
      config.employees.forEach((e) => { positionByName[e.name] = e.position || ''; });

      // "Terbaru" (Task #54): bukan cuma hari ini, tapi data PALING BARU secara
      // keseluruhan (diurutkan tanggal+jam terbaru duluan). Ambil 50 dulu, ditampilkan
      // 5 per halaman di frontend dengan tombol Sebelumnya/Selanjutnya.
      // Absensi Terbaru di Dashboard hanya menampilkan absen hari ini (WIB), terbaru di atas.
      const recentRecords = recordsToday
        .slice()
        .sort((a, b) => (a.timeHHMM < b.timeHHMM ? 1 : -1))
        .map((r) => ({
          employee: r.employee, position: positionByName[r.employee] || '', type: r.type,
          timeHHMM: r.timeHHMM, nearestLocation: r.nearestLocation, dateKey: r.dateKey,
          late: r.type === 'masuk' && isLateMasuk(r, config),
        }));
      const kasbonTerbaru = readJSON(KASBON_FILE)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 50)
        .map((k) => ({ id: k.id, employee: k.employee, jenis: k.jenis, jumlah: k.jumlah, status: k.status }));
      const leaveTerbaru = readJSON(LEAVES_FILE)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 50)
        .map((l) => ({ id: l.id, employee: l.employee, type: l.type, startDate: l.startDate, endDate: l.endDate, status: l.status, reason: l.reason || '' }));

      const masukHariIni = {};
      recordsToday.filter((r) => r.type === 'masuk').forEach((r) => {
        if (!masukHariIni[r.employee] || r.timeHHMM < masukHariIni[r.employee].timeHHMM) masukHariIni[r.employee] = r;
      });
      const terlambatHariIni = Object.values(masukHariIni).filter((r) => isLateMasuk(r, config)).length;
      const totalKaryawan = config.employees.filter((e) => e.status !== 'nonaktif').length;
      const reasonLabel = {
        telepon_tidak_terdaftar: 'Nomor tidak terdaftar', nonaktif: 'Akun non-aktif', jarak_terlalu_jauh: 'Terlalu jauh dari lokasi',
        shift_kosong: 'Shift belum dipilih', shift_tidak_dikenali: 'Shift tidak dikenali', lokasi_belum_diatur: 'Lokasi kantor belum diatur',
        data_tidak_lengkap: 'Data tidak lengkap', gps: 'GPS gagal', kamera: 'Kamera gagal',
      };
      // Satu baris per karyawan + alasan (kalau alasannya sama, cukup ditampilkan 1 kali).
      const gagalGroup = {};
      readJSON(FAILED_ATTEMPTS_FILE)
        .filter((f) => f.dateKey === todayKey)
        .sort((a, b) => (a.timeHHMM < b.timeHHMM ? 1 : -1))
        .forEach((f) => {
          const key = `${f.employee || f.phone}|${f.reason}`;
          if (!gagalGroup[key]) {
            gagalGroup[key] = {
              id: f.id, employee: f.employee || f.phone || '-', type: f.type, timeHHMM: f.timeHHMM,
              reason: f.reason, reasonLabel: reasonLabel[f.reason] || f.reason, detail: f.detail,
              distanceMeters: f.distanceMeters, nearestLocation: f.nearestLocation, count: 0,
            };
          }
          gagalGroup[key].count += 1;
          // Jam yang ditampilkan adalah jam percobaan pertama hari itu (sama dengan notifikasi).
          if (f.timeHHMM < gagalGroup[key].timeHHMM) gagalGroup[key].timeHHMM = f.timeHHMM;
        });
      const absenGagalHariIni = Object.values(gagalGroup).slice(0, 50);
      return sendJSON(res, 200, {
        date: todayKey,
        absenGagalHariIni,
        totalKaryawan,
        karyawanMasuk,
        belumAbsen: Math.max(0, totalKaryawan - karyawanMasuk),
        terlambatHariIni,
        toleransiTerlambatMenit: config.toleransiTerlambatMenit ?? 15,
        leavePending: readJSON(LEAVES_FILE).filter((l) => l.status === 'pending').length,
        kasbonPending: readJSON(KASBON_FILE).filter((k) => k.status === 'pending').length,
        karyawanCuti: leavesToday.length,
        recentRecords,
        kasbonTerbaru,
        leaveTerbaru,
      });
    }

    // ---- Static files (halaman) ----
    if (req.method === 'GET') {
      return serveStatic(req, res, pathName);
    }

    sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: 'Server error: ' + err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Absensi app jalan di http://localhost:${PORT}`);
});
