// Aplikasi Absensi Karyawan — server ringan tanpa dependensi eksternal
// Jalankan: node server.js
// Env opsional: PORT, ADMIN_PASSWORD, DATA_DIR (lokasi penyimpanan data persisten,
// contoh di Render: /var/data jika sudah pasang Persistent Disk dengan mount path tersebut)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  // Karyawan lama (sebelum fitur foto/No ID/jabatan) belum punya field-field ini.
  if (!Array.isArray(config.employees)) config.employees = [];
  for (const emp of config.employees) {
    if (emp.idNumber === undefined) { emp.idNumber = ''; changed = true; }
    if (emp.position === undefined) { emp.position = ''; changed = true; }
    if (emp.photoFilename === undefined) { emp.photoFilename = null; changed = true; }
    if (emp.gajiPokok === undefined) { emp.gajiPokok = 0; changed = true; }
    if (emp.upahLemburPerJam === undefined) { emp.upahLemburPerJam = 0; changed = true; }
    if (emp.tunjanganFungsional === undefined) { emp.tunjanganFungsional = 0; changed = true; }
    if (emp.tunjanganNatura === undefined) { emp.tunjanganNatura = 0; changed = true; }
    if (emp.dapatUangMakan === undefined) { emp.dapatUangMakan = true; changed = true; }
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
function computeLemburByEmployeeDate(records) {
  const grouped = {}; // key: employee|date -> { masuk: minMenit, keluar: maxMenit }
  for (const r of records) {
    const key = r.employee + '|' + r.dateKey;
    if (!grouped[key]) grouped[key] = { masuk: null, keluar: null };
    const menit = timeToMinutes(r.timeHHMM);
    if (r.type === 'masuk') {
      if (grouped[key].masuk === null || menit < grouped[key].masuk) grouped[key].masuk = menit;
    } else if (r.type === 'keluar') {
      if (grouped[key].keluar === null || menit > grouped[key].keluar) grouped[key].keluar = menit;
    }
  }
  const result = {};
  for (const key of Object.keys(grouped)) {
    const { masuk, keluar } = grouped[key];
    if (masuk === null || keluar === null || keluar <= masuk) {
      result[key] = 0;
      continue;
    }
    result[key] = Math.max(0, keluar - masuk - JAM_KERJA_STANDAR_MENIT);
  }
  return result;
}

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
    if (!grouped[key]) grouped[key] = { masuk: null, keluar: null, shiftStart: null, shiftEnd: null };
    const g = grouped[key];
    if (r.type === 'masuk') {
      g.masuk = timeToMinutes(r.timeHHMM);
      if (r.shiftStart) g.shiftStart = timeToMinutes(r.shiftStart);
      if (r.shiftEnd) g.shiftEnd = timeToMinutes(r.shiftEnd);
    } else if (r.type === 'keluar') {
      g.keluar = timeToMinutes(r.timeHHMM);
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
    const shiftStart = g.shiftStart !== null ? g.shiftStart : fallbackShiftStart;
    const shiftEnd = g.shiftEnd !== null ? g.shiftEnd : fallbackShiftEnd;
    const out = { lemburAwalMenit: 0, terlambatMenit: 0, lemburAkhirMenit: 0, pulangCepatMenit: 0, hadir: g.masuk !== null };
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

function computePayrollSummary(records, config, from, to) {
  const totalHariPeriode = countDaysInclusive(from, to);
  const toleransi = config.toleransiTerlambatMenit || 0;
  const daily = computePayrollDailyByEmployeeDate(records, toleransi, config);
  const lemburTambahan = computeLemburTambahanByEmployeeDate(records);
  const cutiDisetujui = countApprovedLeaveDaysByEmployee(readJSON(LEAVES_FILE), from, to);
  const kasbonPotongan = sumKasbonPaymentsByEmployee(readJSON(KASBON_PAYMENTS_FILE), from, to);
  const leaves = readJSON(LEAVES_FILE);
  // Total menit kerja per employee|tanggal, dipakai buat cek "kerja >=12 jam di H-1" (Task #36).
  const workedMinutesMap = computeWorkedMinutesByEmployeeDate(records);

  const makeEmpty = (employee) => ({
    employee, hariHadir: 0, lemburAwalMenit: 0, terlambatMenit: 0, terlambatMenitPotongan: 0, terlambatKali: 0,
    lemburAkhirMenit: 0, pulangCepatMenit: 0, lemburTambahanMenit: 0, presentDates: new Set(),
  });

  const byEmployee = {};
  const empByName = {};
  for (const emp of config.employees) empByName[emp.name] = emp;

  for (const key of Object.keys(daily)) {
    const [employee, dateKey] = key.split('|');
    if (!byEmployee[employee]) byEmployee[employee] = makeEmpty(employee);
    const e = byEmployee[employee];
    const d = daily[key];
    if (d.hadir) { e.hariHadir += 1; e.presentDates.add(dateKey); }
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
    const tunjanganNatura = Number(emp.tunjanganNatura) || 0;
    const gajiHarian = gajiPokok / 30;
    const upahJam = Number(emp.upahLemburPerJam) > 0 ? Number(emp.upahLemburPerJam) : gajiPokok / 240;

    // Task #37: hari tidak masuk tanpa alasan yang jatuh SEBELUM tanggal masuk kerja karyawan
    // hanya kena potongan 1x upah harian (bukan pengaliPotonganOff / biasanya 2x), karena
    // karyawan memang belum mulai bekerja saat itu. Kuota OFF gratis (jatahOffPerPeriode)
    // dipakai dulu buat hari2 absen yang PALING AWAL secara kronologis.
    // Jangan hitung hari di MASA DEPAN sebagai alpa — kalau periode gajian belum selesai
    // (misal lagi dilihat sebelum tanggal 25), hari yang belum kejalanin bukan alpa.
    const todayKeyForAbsent = dateKeyJakarta(new Date().toISOString());
    const absentTo = to < todayKeyForAbsent ? to : todayKeyForAbsent;
    const absentDates = to < from ? [] : computeAbsentDates(e.employee, from, absentTo, e.presentDates, leaves);
    const hariTidakHadir = absentDates.length;
    const jatah = config.jatahOffPerPeriode || 0;
    const offBerlebih = Math.max(0, hariTidakHadir - jatah);
    const chargedAbsentDates = offBerlebih > 0 ? absentDates.slice(hariTidakHadir - offBerlebih) : [];
    const hariCuti = cutiDisetujui[e.employee] || 0;
    const potonganKasbon = kasbonPotongan[e.employee] || 0;

    const dapatUangMakan = emp.dapatUangMakan !== false;
    const uangMakan = dapatUangMakan ? e.hariHadir * (config.uangMakanPerHari || 0) : 0;
    const uangTransport = e.hariHadir * (config.uangTransportPerHari || 0);
    const lemburAwalJam = Math.round((e.lemburAwalMenit / 60) * 100) / 100;
    const lemburAkhirJam = Math.round((e.lemburAkhirMenit / 60) * 100) / 100;
    const pulangCepatJam = Math.round((e.pulangCepatMenit / 60) * 100) / 100;
    const terlambatJam = Math.round((e.terlambatMenit / 60) * 100) / 100;
    const terlambatJamPotongan = Math.round((e.terlambatMenitPotongan / 60) * 100) / 100;
    const lemburTambahanJam = Math.round((e.lemburTambahanMenit / 60) * 100) / 100;

    const lemburAwalRp = Math.round(lemburAwalJam * upahJam);
    const lemburAkhirRp = Math.round(lemburAkhirJam * upahJam);
    const lemburTambahanRp = Math.round(lemburTambahanJam * upahJam);
    const totalPendapatan = gajiPokok + tunjanganFungsional + tunjanganNatura + uangMakan + lemburAwalRp + lemburAkhirRp + lemburTambahanRp;

    const kerajinanEligible = offBerlebih === 0 && e.terlambatKali <= (config.maksTerlambatUntukKerajinan ?? 2);
    const kerajinan = kerajinanEligible ? Math.round(totalPendapatan * 0.1) : 0;

    const tanggalMasuk = emp.tanggalMasuk || null;
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
      gajiPokok, tunjanganFungsional, tunjanganNatura, upahPerJam: Math.round(upahJam),
      hariHadir: e.hariHadir, hariCuti, hariTidakHadir, offBerlebih,
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

function checkAdmin(req, config) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return token === hashPassword(config.adminPassword);
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

// ---- Penulis file .xlsx minimal (tanpa dependency npm tambahan) ----
// Dipakai untuk fitur export rekap absensi ke Excel. Membuat file .xlsx (ZIP berisi
// XML OOXML) langsung dengan Node bawaan: ZIP disimpan tanpa kompresi (method STORE)
// supaya tidak perlu library zip/deflate pihak ketiga.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dateVal = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, dateVal };
}

// files: [{ name, data: Buffer }] -> Buffer berisi file .zip (tanpa kompresi, cukup untuk dibaca Excel/OOXML).
function buildZipStore(files) {
  const now = new Date();
  const { time, dateVal } = dosDateTime(now);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach((f) => {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // versi minimum
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // method = 0 (store)
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(dateVal, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(dateVal, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  });

  const centralDirStart = offset;
  const centralDir = Buffer.concat(centralParts);
  const centralDirSize = centralDir.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

function xmlEscape(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function colLetter(idx) {
  let n = idx + 1, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// sheets: [{ name, rows }], rows: array of array of cell (string | number). Nama sheet maks 31 karakter.
// Style index tetap (dipakai lewat cell { v, s: XLSX_STYLE.xxx }):
// 0 normal, 1 bold, 2 bold+underline (judul seksi), 3 bold+border-top (baris total).
const XLSX_STYLE = { NORMAL: 0, BOLD: 1, BOLD_UNDERLINE: 2, BOLD_TOPBORDER: 3 };

function buildXlsx(sheets) {
  const files = [];
  files.push({ name: '[Content_Types].xml', data: Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    `</Types>`, 'utf8') });

  files.push({ name: '_rels/.rels', data: Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`, 'utf8') });

  files.push({ name: 'xl/workbook.xml', data: Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>` + sheets.map((s, i) => `<sheet name="${xmlEscape(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + `</sheets>` +
    `</workbook>`, 'utf8') });

  // rId diurut: sheet1..sheetN dulu, lalu styles.xml setelahnya.
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`, 'utf8') });

  // Styles: font 0 normal, font 1 bold. xf 0 normal, xf 1 bold, xf 2 bold+underline,
  // xf 3 bold dengan border atas (dipakai baris TOTAL/GAJI BERSIH).
  files.push({ name: 'xl/styles.xml', data: Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><u/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
    `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color indexed="64"/></top><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="4">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment/></xf>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>` +
    `</cellXfs>` +
    `</styleSheet>`, 'utf8') });

  sheets.forEach((sheet, idx) => {
    const rowsXml = sheet.rows.map((row, rIdx) => {
      const cells = row.map((cell, cIdx) => {
        const ref = colLetter(cIdx) + (rIdx + 1);
        const isObj = cell !== null && typeof cell === 'object';
        const value = isObj ? cell.v : cell;
        const styleAttr = isObj && cell.s ? ` s="${cell.s}"` : '';
        if (value === null || value === undefined || value === '') {
          return styleAttr ? `<c r="${ref}"${styleAttr}/>` : '';
        }
        if (typeof value === 'number' && isFinite(value)) {
          return `<c r="${ref}"${styleAttr}><v>${value}</v></c>`;
        }
        return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
      }).join('');
      return `<row r="${rIdx + 1}">${cells}</row>`;
    }).join('');
    files.push({ name: `xl/worksheets/sheet${idx + 1}.xml`, data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`, 'utf8') });
  });

  return buildZipStore(files);
}

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

// Buat notifikasi baru untuk admin (dipakai saat karyawan ajukan cuti/ijin atau kasbon baru).
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
function formatRupiahServer(n) {
  const sign = n < 0 ? '-' : '';
  return sign + 'Rp' + Math.abs(Math.round(n)).toLocaleString('id-ID');
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

      const lemburMap = computeLemburByEmployeeDate(records);
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
      const totalLemburJam = Math.round((Object.values(lemburMap).reduce((a, b) => a + b, 0) / 60) * 10) / 10;

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

      // Ijin/Cuti disetujui yang jatuh di bulan ini (untuk kartu ringkasan "Ijin").
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

      // Tidak Hadir: hari berjalan bulan ini (s.d. hari ini kalau bulan sekarang) dikurangi hadir & ijin.
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
        totalLemburJam,
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
        },
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
      const payroll = computePayrollSummary(records, config, from, to);
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
        return sendJSON(res, 200, { token: hashPassword(config.adminPassword) });
      }
      return sendJSON(res, 401, { error: 'Email atau password salah' });
    }

    // ---- Absen (check-in / check-out / lembur masuk / lembur pulang) ----
    if (pathName === '/api/checkin' && req.method === 'POST') {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf8'));
      const { phone, type, lat, lng, photoBase64, deviceTime, shift } = body;

      const validTypes = ['masuk', 'keluar', 'lembur_masuk', 'lembur_keluar'];
      if (!phone || !validTypes.includes(type) || typeof lat !== 'number' || typeof lng !== 'number' || !photoBase64) {
        return sendJSON(res, 400, { error: 'Data tidak lengkap (nomor telepon, tipe, lokasi, foto wajib diisi)' });
      }
      const emp = config.employees.find((e) => e.phone === String(phone).trim());
      if (!emp) {
        return sendJSON(res, 400, { error: 'Nomor telepon tidak terdaftar. Hubungi admin untuk didaftarkan.' });
      }
      if (emp.status === 'nonaktif') {
        return sendJSON(res, 403, { error: 'Akun karyawan ini sudah tidak aktif. Hubungi admin.' });
      }

      if (config.locations.length === 0) {
        return sendJSON(res, 400, { error: 'Belum ada lokasi kantor yang diatur. Hubungi admin.' });
      }
      const nearest = nearestLocation(lat, lng, config.locations);
      const withinRadius = nearest.withinRadius;

      // Task #38: batas jarak maksimal (hard limit) — kalau lebih jauh dari ini, absen DITOLAK
      // sepenuhnya (bukan cuma ditandai "di luar radius" seperti sebelumnya).
      if (nearest.melebihiJarakMaksimal) {
        return sendJSON(res, 400, {
          error: `Lokasi kamu terlalu jauh dari ${nearest.name} (jarak ${Math.round(nearest.distanceMeters)} m, maksimal ${nearest.maxDistanceMeters} m). Absen tidak bisa disimpan, pastikan kamu berada dekat lokasi kerja.`,
        });
      }

      // Shift wajib dipilih saat absen masuk reguler; dicocokkan ke daftar shift lokasi terdekat.
      // Lembur Masuk/Lembur Pulang tidak terikat jadwal shift ataupun batasan waktu.
      let shiftInfo = null;
      if (type === 'masuk') {
        if (!shift) return sendJSON(res, 400, { error: 'Pilih shift terlebih dahulu.' });
        shiftInfo = (nearest.shifts || []).find((s) => s.name === shift) || null;
        if (!shiftInfo) return sendJSON(res, 400, { error: 'Shift tidak dikenali untuk lokasi ini.' });
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
      if (token !== hashPassword(config.adminPassword)) {
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
      return sendJSON(res, 200, { records: filtered });
    }

    // Admin: input manual jam absen (karyawan lupa absen masuk/pulang/lembur masuk/lembur pulang).
    if (pathName === '/api/records/manual' && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { phone, type, dateKey, timeHHMM } = body;
      const emp = config.employees.find((e) => e.phone === String(phone || '').trim());
      if (!emp) return sendJSON(res, 400, { error: 'Karyawan tidak ditemukan.' });
      if (!['masuk', 'keluar', 'lembur_masuk', 'lembur_keluar'].includes(type)) {
        return sendJSON(res, 400, { error: 'Jenis absen tidak valid.' });
      }
      if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return sendJSON(res, 400, { error: 'Tanggal tidak valid.' });
      if (!timeHHMM || !/^\d{2}:\d{2}$/.test(timeHHMM)) return sendJSON(res, 400, { error: 'Jam tidak valid (format HH:MM).' });

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
        nearestLocation: 'Input Manual Admin',
        distanceMeters: 0,
        withinRadius: true,
        shift: null,
        shiftStart: null,
        shiftEnd: null,
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
      if (!body.timeHHMM || !/^\d{2}:\d{2}$/.test(body.timeHHMM)) return sendJSON(res, 400, { error: 'Jam tidak valid (format HH:MM).' });
      r.timeHHMM = body.timeHHMM;
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
      records = records.filter((x) => x.id !== id);
      writeJSON(RECORDS_FILE, records);
      return sendJSON(res, 200, { ok: true });
    }

    if (pathName === '/api/summary' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const month = url.searchParams.get('month'); // YYYY-MM
      const records = readJSON(RECORDS_FILE).filter((r) => r.dateKey.startsWith(month));
      const lemburMap = computeLemburByEmployeeDate(records);

      const byEmployee = {};
      for (const emp of config.employees) {
        byEmployee[emp.name] = { employee: emp.name, hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0, lemburMenit: 0 };
      }
      for (const r of records) {
        if (!byEmployee[r.employee]) {
          byEmployee[r.employee] = { employee: r.employee, hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0, lemburMenit: 0 };
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
        if (byEmployee[employee]) byEmployee[employee].lemburMenit += lemburMap[key];
      }
      const summary = Object.values(byEmployee).map((e) => ({
        employee: e.employee,
        hariHadir: e.hariHadir.size,
        totalAbsen: e.totalAbsen,
        diLuarRadius: e.diLuarRadius,
        terlambat: e.terlambat,
        lemburJam: Math.round((e.lemburMenit / 60) * 10) / 10,
      }));
      return sendJSON(res, 200, { month, summary, workStartTime: config.workStartTime });
    }

    // ---- Export rekap absensi ke CSV untuk rentang tanggal bebas yang dipilih admin ----
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
        const lemburMap = computeLemburByEmployeeDate(records);
        const byEmployee = {};
        for (const emp of selectedEmployees) {
          byEmployee[emp.name] = { employee: emp.name, idNumber: emp.idNumber || '', hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0, lemburMenit: 0 };
        }
        for (const r of records) {
          if (!byEmployee[r.employee]) {
            if (selectedPhones && !selectedNames.has(r.employee)) continue;
            byEmployee[r.employee] = { employee: r.employee, idNumber: (empMeta[r.employee] && empMeta[r.employee].idNumber) || '', hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0, lemburMenit: 0 };
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
          if (byEmployee[employee]) byEmployee[employee].lemburMenit += lemburMap[key];
        }
        headerRow = ['Nama', 'No ID', 'Hari Hadir', 'Total Catatan Absen', 'Terlambat (kali)', 'Di Luar Radius', 'Lembur (jam)'];
        dataRows = Object.values(byEmployee).map((e) => [
          e.employee, e.idNumber, e.hariHadir.size, e.totalAbsen, e.terlambat, e.diLuarRadius,
          Math.round((e.lemburMenit / 60) * 10) / 10,
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
      const payroll = computePayrollSummary(records, config, from, to);
      return sendJSON(res, 200, { from, to, payroll });
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
      const payroll = computePayrollSummary(records, config, from, to).filter((p) => selectedNames.has(p.employee));

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
      const lemburMap = computeLemburByEmployeeDate(records);
      const lines = records.map(
        (r) =>
          `- ${r.employee} | ${r.type === 'masuk' ? 'Masuk' : 'Keluar'} ${r.timeHHMM} WIB${r.shift ? ` (${r.shift})` : ''} | ${
            r.withinRadius
              ? `lokasi valid (${r.nearestLocation || 'kantor'})`
              : `di luar radius ${r.nearestLocation || 'kantor'} (${r.distanceMeters} m)`
          }`
      );
      const lemburLines = Object.entries(lemburMap)
        .filter(([, menit]) => menit > 0)
        .map(([key, menit]) => `- ${key.split('|')[0]}: lembur ${(menit / 60).toFixed(1)} jam`);
      const lemburSection = lemburLines.length ? `\n\nLembur:\n${lemburLines.join('\n')}` : '';
      const text = `Laporan Absensi ${date}\nTotal catatan: ${records.length}\n\n${lines.join('\n')}${lemburSection}`;
      return sendJSON(res, 200, { date, text, records });
    }

    if (pathName === '/api/monthly-report' && req.method === 'GET') {
      const key = url.searchParams.get('key');
      if (key !== reportKey(config)) return sendJSON(res, 403, { error: 'Forbidden' });
      const month = url.searchParams.get('month') || dateKeyJakarta(new Date().toISOString()).slice(0, 7);
      const records = readJSON(RECORDS_FILE).filter((r) => r.dateKey.startsWith(month));
      const lemburMap = computeLemburByEmployeeDate(records);

      const byEmployee = {};
      for (const emp of config.employees) {
        byEmployee[emp.name] = { employee: emp.name, hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0, lemburMenit: 0 };
      }
      for (const r of records) {
        if (!byEmployee[r.employee]) {
          byEmployee[r.employee] = { employee: r.employee, hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0, lemburMenit: 0 };
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
        if (byEmployee[employee]) byEmployee[employee].lemburMenit += lemburMap[key];
      }
      const summary = Object.values(byEmployee).map((e) => ({
        employee: e.employee,
        hariHadir: e.hariHadir.size,
        totalAbsen: e.totalAbsen,
        diLuarRadius: e.diLuarRadius,
        terlambat: e.terlambat,
        lemburJam: Math.round((e.lemburMenit / 60) * 10) / 10,
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

      const lemburMap = computeLemburByEmployeeDate(records);
      const byEmployee = {};
      for (const emp of config.employees) {
        byEmployee[emp.name] = { employee: emp.name, hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0, lemburMenit: 0 };
      }
      for (const r of records) {
        if (!byEmployee[r.employee]) {
          byEmployee[r.employee] = { employee: r.employee, hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0, lemburMenit: 0 };
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
        if (byEmployee[employee]) byEmployee[employee].lemburMenit += lemburMap[key2];
      }
      const summary = Object.values(byEmployee).map((e) => ({
        employee: e.employee,
        hariHadir: e.hariHadir.size,
        totalAbsen: e.totalAbsen,
        diLuarRadius: e.diLuarRadius,
        terlambat: e.terlambat,
        lemburJam: Math.round((e.lemburMenit / 60) * 10) / 10,
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

      const payroll = computePayrollSummary(records, config, from, to);

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

      return sendJSON(res, 200, { from, to, summary, detail, payroll, kasbonAktif });
    }

    if (pathName === '/api/config' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const { adminPassword, ...safeConfig } = config;
      return sendJSON(res, 200, safeConfig);
    }

    if (pathName === '/api/config' && req.method === 'POST') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8'));
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
      const csvText = body.csv;
      if (!csvText || typeof csvText !== 'string') return sendJSON(res, 400, { error: 'File CSV kosong atau tidak valid' });

      const rows = parseCSV(csvText);
      if (rows.length < 2) return sendJSON(res, 400, { error: 'File CSV tidak punya data (minimal 1 baris header + 1 baris data)' });

      const header = rows[0].map((h) => String(h).trim().toLowerCase());
      const findCol = (...names) => header.findIndex((h) => names.includes(h));
      const colName = findCol('nama', 'name');
      const colPhone = findCol('no telepon', 'telepon', 'phone', 'no hp', 'nomor telepon', 'nomor hp', 'hp');
      const colId = findCol('no id', 'nik', 'id', 'id number', 'nomor id');
      const colPos = findCol('jabatan', 'posisi', 'position');

      if (colName === -1 || colPhone === -1) {
        return sendJSON(res, 400, { error: 'Kolom "Nama" dan "No Telepon" wajib ada di file CSV.' });
      }

      const fresh = migrateConfig(readJSON(CONFIG_FILE));
      let added = 0, updated = 0;
      const errors = [];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const name = (r[colName] || '').trim();
        const phone = (r[colPhone] || '').trim();
        const idNumber = colId !== -1 ? (r[colId] || '').trim() : '';
        const position = colPos !== -1 ? (r[colPos] || '').trim() : '';
        if (!name || !phone) { errors.push(`Baris ${i + 1}: nama/no telepon kosong, dilewati`); continue; }

        const existing = fresh.employees.find((e) => e.phone === phone);
        if (existing) {
          existing.name = name;
          existing.idNumber = idNumber || existing.idNumber || '';
          existing.position = position || existing.position || '';
          updated++;
        } else {
          fresh.employees.push({ phone, name, idNumber, position, photoFilename: null });
          added++;
        }
      }
      writeJSON(CONFIG_FILE, fresh);
      return sendJSON(res, 200, { ok: true, added, updated, errors });
    }

    // ---- Export data karyawan ke CSV (bisa dibuka di Excel) ----
    if (pathName === '/api/employees/export' && req.method === 'GET') {
      if (!checkAdmin(req, config)) return sendJSON(res, 401, { error: 'Unauthorized' });
      const cols = ['Nama', 'No Telepon', 'No ID', 'Jabatan', 'Email', 'Tanggal Masuk', 'Status', 'Gaji Pokok', 'Upah Lembur Per Jam'];
      const esc = (v) => {
        const s = String(v === undefined || v === null ? '' : v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const lines = [cols.map(esc).join(',')];
      for (const e of config.employees) {
        lines.push([
          e.name, e.phone, e.idNumber || '', e.position || '', e.email || '',
          e.tanggalMasuk || '', e.status || 'aktif', e.gajiPokok || 0, e.upahLemburPerJam || 0,
        ].map(esc).join(','));
      }
      const csv = '﻿' + lines.join('\r\n'); // BOM biar Excel baca UTF-8 dengan benar
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="data-karyawan.csv"',
      });
      return res.end(csv);
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
    // Export rekap Ijin/Cuti ke .xlsx. Tanpa param date/status = semua data ("Semua Data" di UI).
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
      const xlsxBuffer = buildXlsx([{ name: 'Ijin Cuti', rows: [headerRow, ...dataRows] }]);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="ijin-cuti${date ? '-' + date : ''}${status ? '-' + status : ''}.xlsx"`,
      });
      return res.end(xlsxBuffer);
    }
    // Admin: daftar notifikasi admin (pengajuan cuti/ijin & kasbon baru) + jumlah belum dibaca.
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
      addNotification(l.phone, 'Pengajuan Cuti/Ijin Anda telah diterima.', 'leave_approved');
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
      addNotification(l.phone, 'Pengajuan Cuti/Ijin Anda telah ditolak.', 'leave_rejected');
      return sendJSON(res, 200, { ok: true });
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
    // Riwayat notifikasi milik karyawan sendiri (status pengajuan cuti/ijin & kasbon).
    if (pathName === '/api/my-notifications' && req.method === 'GET') {
      const phone = String(url.searchParams.get('phone') || '').trim();
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

      const kasbonList = readJSON(KASBON_FILE).filter((k) => k.status === 'disetujui' || k.status === 'lunas');
      const payments = readJSON(KASBON_PAYMENTS_FILE);
      const B = XLSX_STYLE.BOLD, BU = XLSX_STYLE.BOLD_UNDERLINE, BT = XLSX_STYLE.BOLD_TOPBORDER;
      const bold = (v) => ({ v, s: B });
      const headerCell = (v) => ({ v, s: BU });

      const sheets = selectedPhones.map((phone) => {
        const emp = config.employees.find((e) => e.phone === phone);
        const employeeName = emp ? emp.name : phone;
        const empKasbon = kasbonList.filter((k) => k.phone === phone);
        const kasbonIds = new Set(empKasbon.map((k) => k.id));
        const empPayments = payments.filter((p) => kasbonIds.has(p.kasbonId));
        const jenisByKasbonId = {};
        empKasbon.forEach((k) => { jenisByKasbonId[k.id] = k.jenis; });

        // Gabungkan jadi satu daftar transaksi (pinjam + bayar), urut tanggal lalu waktu dibuat,
        // dari SELURUH histori (tidak difilter periode dulu - buat hitung saldo berjalan).
        const transaksi = [];
        empKasbon.forEach((k) => transaksi.push({ tanggal: k.tanggal, createdAt: k.createdAt, tipe: 'pinjam', jenis: k.jenis, jumlah: k.jumlah }));
        empPayments.forEach((p) => transaksi.push({ tanggal: p.tanggal, createdAt: p.createdAt, tipe: 'bayar', jenis: jenisByKasbonId[p.kasbonId] || 'cicil', jumlah: p.jumlah }));
        transaksi.sort((a, b) => (a.tanggal + a.createdAt).localeCompare(b.tanggal + b.createdAt));

        let saldo = 0;
        const rows = [
          [bold('No ID'), ':', emp ? (emp.idNumber || '-') : '-'],
          [bold('Nama Karyawan'), ':', employeeName],
          [bold('Periode'), ':', `${formatTanggalSlash(from)} s/d ${formatTanggalSlash(to)}`],
          [],
          [headerCell('Tanggal'), headerCell('Kasbon: Cicil'), headerCell('Kasbon: Potlang'), headerCell('Bayar: Cicil'), headerCell('Bayar: Potlang'), headerCell('Sisa')],
        ];
        let adaBarisPeriode = false;
        transaksi.forEach((t) => {
          saldo += t.tipe === 'pinjam' ? t.jumlah : -t.jumlah;
          if (t.tanggal < from || t.tanggal > to) return; // hitung saldo tetap jalan, tapi baris cuma ditampilkan kalau masuk periode
          adaBarisPeriode = true;
          rows.push([
            formatTanggalSlash(t.tanggal),
            t.tipe === 'pinjam' && t.jenis === 'cicil' ? formatRupiahServer(t.jumlah) : '',
            t.tipe === 'pinjam' && t.jenis === 'potlang' ? formatRupiahServer(t.jumlah) : '',
            t.tipe === 'bayar' && t.jenis === 'cicil' ? formatRupiahServer(t.jumlah) : '',
            t.tipe === 'bayar' && t.jenis === 'potlang' ? formatRupiahServer(t.jumlah) : '',
            formatRupiahServer(Math.max(0, saldo)),
          ]);
        });
        if (!adaBarisPeriode) rows.push(['Tidak ada transaksi kasbon pada periode ini.']);

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
      const records = readJSON(RECORDS_FILE).filter((r) => r.dateKey === todayKey)
        .sort((a, b) => (a.timeHHMM < b.timeHHMM ? 1 : -1));
      const kasbonToday = readJSON(KASBON_FILE).filter((k) => k.tanggal === todayKey)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const karyawanMasuk = new Set(records.filter((r) => r.type === 'masuk').map((r) => r.employee)).size;
      const leavesToday = readJSON(LEAVES_FILE).filter((l) => l.status === 'approved' && l.startDate <= todayKey && todayKey <= l.endDate);
      return sendJSON(res, 200, {
        date: todayKey,
        totalKaryawan: config.employees.filter((e) => e.status !== 'nonaktif').length,
        karyawanMasuk,
        karyawanCuti: leavesToday.length,
        recentRecords: records.slice(0, 15).map((r) => ({
          employee: r.employee, type: r.type, timeHHMM: r.timeHHMM, nearestLocation: r.nearestLocation,
        })),
        kasbonToday: kasbonToday.map((k) => ({ employee: k.employee, jenis: k.jenis, jumlah: k.jumlah, status: k.status })),
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
