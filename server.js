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

const PORT = process.env.PORT || 3000;

// ---------- Util: storage sederhana berbasis file JSON ----------
function ensureFile(file, defaultValue) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(defaultValue, null, 2));
}
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
if (!fs.existsSync(EMPLOYEE_PHOTOS_DIR)) fs.mkdirSync(EMPLOYEE_PHOTOS_DIR, { recursive: true });
ensureFile(RECORDS_FILE, []);
ensureFile(CONFIG_FILE, {
  // Beberapa lokasi kantor/cabang, masing-masing punya daftar shift sendiri.
  // Karyawan memilih sendiri shift yang mereka jalani saat absen masuk.
  locations: [
    {
      name: "Yogya Jatibarang",
      lat: -6.200000, lng: 108.316666, radiusMeters: 10,
      shifts: [
        { name: "Shift 1", startTime: "08:30", endTime: "16:30" },
        { name: "Shift 2", startTime: "12:30", endTime: "20:30" },
        { name: "Full Day", startTime: "08:30", endTime: "20:30" },
      ],
    },
    {
      name: "Yomart Karangampel",
      lat: -6.400000, lng: 108.416666, radiusMeters: 10,
      shifts: [
        { name: "Shift 1", startTime: "07:30", endTime: "15:30" },
      ],
    },
  ],
  // Daftar karyawan: login memakai nomor telepon
  employees: [
    { phone: "081234567890", name: "Contoh Karyawan 1", idNumber: "", position: "", photoFilename: null, gajiPokok: 0, upahLemburPerJam: 0 },
    { phone: "081234567891", name: "Contoh Karyawan 2", idNumber: "", position: "", photoFilename: null, gajiPokok: 0, upahLemburPerJam: 0 },
  ],
  adminPassword: process.env.ADMIN_PASSWORD || "admin123",
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
  }
  // Karyawan lama (sebelum fitur foto/No ID/jabatan) belum punya field-field ini.
  if (!Array.isArray(config.employees)) config.employees = [];
  for (const emp of config.employees) {
    if (emp.idNumber === undefined) { emp.idNumber = ''; changed = true; }
    if (emp.position === undefined) { emp.position = ''; changed = true; }
    if (emp.photoFilename === undefined) { emp.photoFilename = null; changed = true; }
    if (emp.gajiPokok === undefined) { emp.gajiPokok = 0; changed = true; }
    if (emp.upahLemburPerJam === undefined) { emp.upahLemburPerJam = 0; changed = true; }
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

// ---------- Perhitungan gaji (metode JADWAL: dibandingkan ke jam shift resmi) ----------
// Untuk tiap (karyawan, tanggal): shift acuan diambil dari record MASUK (karyawan memilih shift
// saat absen masuk). Dari situ dihitung:
// - lemburAwalMenit: datang sebelum jam shift mulai
// - terlambatMenit : datang sesudah jam shift mulai, dikurangi toleransi
// - lemburAkhirMenit: pulang sesudah jam shift selesai
// - pulangCepatMenit: pulang sebelum jam shift selesai (hanya jika ada record keluar hari itu)
function computePayrollDailyByEmployeeDate(records, toleransiMenit) {
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
  const result = {};
  for (const key of Object.keys(grouped)) {
    const g = grouped[key];
    const out = { lemburAwalMenit: 0, terlambatMenit: 0, lemburAkhirMenit: 0, pulangCepatMenit: 0, hadir: g.masuk !== null };
    if (g.masuk !== null && g.shiftStart !== null) {
      if (g.masuk < g.shiftStart) out.lemburAwalMenit = g.shiftStart - g.masuk;
      else if (g.masuk > g.shiftStart + toleransiMenit) out.terlambatMenit = g.masuk - g.shiftStart;
    }
    if (g.keluar !== null && g.shiftEnd !== null) {
      if (g.keluar > g.shiftEnd) out.lemburAkhirMenit = g.keluar - g.shiftEnd;
      else if (g.keluar < g.shiftEnd) out.pulangCepatMenit = g.shiftEnd - g.keluar;
    }
    result[key] = out;
  }
  return result;
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
function computePayrollSummary(records, config, from, to) {
  const totalHariPeriode = countDaysInclusive(from, to);
  const toleransi = config.toleransiTerlambatMenit || 0;
  const daily = computePayrollDailyByEmployeeDate(records, toleransi);

  const byEmployee = {};
  const empByName = {};
  for (const emp of config.employees) empByName[emp.name] = emp;

  for (const key of Object.keys(daily)) {
    const [employee] = key.split('|');
    if (!byEmployee[employee]) {
      byEmployee[employee] = {
        employee, hariHadir: 0, lemburAwalMenit: 0, terlambatMenit: 0, terlambatKali: 0,
        lemburAkhirMenit: 0, pulangCepatMenit: 0,
      };
    }
    const e = byEmployee[employee];
    const d = daily[key];
    if (d.hadir) e.hariHadir += 1;
    e.lemburAwalMenit += d.lemburAwalMenit;
    e.lemburAkhirMenit += d.lemburAkhirMenit;
    e.pulangCepatMenit += d.pulangCepatMenit;
    if (d.terlambatMenit > 0) { e.terlambatMenit += d.terlambatMenit; e.terlambatKali += 1; }
  }
  // Pastikan semua karyawan terdaftar muncul walau tidak ada record sama sekali di periode ini.
  for (const emp of config.employees) {
    if (!byEmployee[emp.name]) {
      byEmployee[emp.name] = { employee: emp.name, hariHadir: 0, lemburAwalMenit: 0, terlambatMenit: 0, terlambatKali: 0, lemburAkhirMenit: 0, pulangCepatMenit: 0 };
    }
  }

  const result = Object.values(byEmployee).map((e) => {
    const emp = empByName[e.employee] || {};
    const gajiPokok = Number(emp.gajiPokok) || 0;
    const gajiHarian = gajiPokok / 30;
    const upahJam = Number(emp.upahLemburPerJam) > 0 ? Number(emp.upahLemburPerJam) : gajiPokok / 240;

    const hariTidakHadir = Math.max(0, totalHariPeriode - e.hariHadir);
    const offBerlebih = Math.max(0, hariTidakHadir - (config.jatahOffPerPeriode || 0));

    const uangMakan = e.hariHadir * (config.uangMakanPerHari || 0);
    const uangTransport = e.hariHadir * (config.uangTransportPerHari || 0);
    const lemburAwalJam = Math.round((e.lemburAwalMenit / 60) * 100) / 100;
    const lemburAkhirJam = Math.round((e.lemburAkhirMenit / 60) * 100) / 100;
    const pulangCepatJam = Math.round((e.pulangCepatMenit / 60) * 100) / 100;
    const terlambatJam = Math.round((e.terlambatMenit / 60) * 100) / 100;

    const lemburAwalRp = Math.round(lemburAwalJam * upahJam);
    const lemburAkhirRp = Math.round(lemburAkhirJam * upahJam);
    const totalPendapatan = gajiPokok + uangMakan + lemburAwalRp + lemburAkhirRp;

    const kerajinanEligible = offBerlebih === 0 && e.terlambatKali <= (config.maksTerlambatUntukKerajinan ?? 2);
    const kerajinan = kerajinanEligible ? Math.round(totalPendapatan * 0.1) : 0;

    const potonganOff = Math.round(offBerlebih * gajiHarian * (config.pengaliPotonganOff || 0));
    const potonganTerlambat = Math.round(terlambatJam * upahJam);
    const potonganPulangCepat = Math.round(pulangCepatJam * upahJam);
    const totalPotongan = potonganOff + potonganTerlambat + potonganPulangCepat;

    const gajiBersih = totalPendapatan + kerajinan + uangTransport - totalPotongan;

    return {
      employee: e.employee,
      gajiPokok, upahPerJam: Math.round(upahJam),
      hariHadir: e.hariHadir, hariTidakHadir, offBerlebih,
      terlambatKali: e.terlambatKali, terlambatJam, pulangCepatJam, lemburAwalJam, lemburAkhirJam,
      uangMakan, uangTransport, lemburAwalRp, lemburAkhirRp, totalPendapatan,
      kerajinanEligible, kerajinan,
      potonganOff, potonganTerlambat, potonganPulangCepat, totalPotongan,
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
        withinRadius: d <= loc.radiusMeters,
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

// Kunci laporan: diturunkan dari password admin, supaya tidak perlu disimpan
// terpisah. Otomatis berubah kalau password admin diganti.
function reportKey(config) {
  return crypto.createHash('sha256').update(config.adminPassword + ':report-key').digest('hex').slice(0, 24);
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

// ---------- Request handler ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathName = url.pathname;
    const config = migrateConfig(readJSON(CONFIG_FILE));

    // CORS (untuk kemudahan jika frontend dipisah)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
        },
        today: {
          dateKey: todayKey,
          masuk: todayMasuk ? todayMasuk.timeHHMM : null,
          keluar: todayKeluar ? todayKeluar.timeHHMM : null,
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
        shifts: nearest.shifts,
      });
    }

    // ---- Login admin ----
    if (pathName === '/api/login' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (body.password === config.adminPassword) {
        return sendJSON(res, 200, { token: hashPassword(config.adminPassword) });
      }
      return sendJSON(res, 401, { error: 'Password salah' });
    }

    // ---- Absen (check-in / check-out) ----
    if (pathName === '/api/checkin' && req.method === 'POST') {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf8'));
      const { phone, type, lat, lng, photoBase64, deviceTime, shift } = body;

      if (!phone || !type || typeof lat !== 'number' || typeof lng !== 'number' || !photoBase64) {
        return sendJSON(res, 400, { error: 'Data tidak lengkap (nomor telepon, tipe, lokasi, foto wajib diisi)' });
      }
      const emp = config.employees.find((e) => e.phone === String(phone).trim());
      if (!emp) {
        return sendJSON(res, 400, { error: 'Nomor telepon tidak terdaftar. Hubungi admin untuk didaftarkan.' });
      }

      if (config.locations.length === 0) {
        return sendJSON(res, 400, { error: 'Belum ada lokasi kantor yang diatur. Hubungi admin.' });
      }
      const nearest = nearestLocation(lat, lng, config.locations);
      const withinRadius = nearest.withinRadius;

      // Shift wajib dipilih saat absen masuk; dicocokkan ke daftar shift lokasi terdekat.
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
        type, // 'masuk' | 'keluar'
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

      return sendJSON(res, 200, { from, to, summary, detail, payroll });
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
      // Jangan biarkan password kosong tak sengaja
      if (!updated.adminPassword) updated.adminPassword = config.adminPassword;
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
