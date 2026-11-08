// Aplikasi Absensi Karyawan — server ringan tanpa dependensi eksternal
// Jalankan: node server.js
// Env opsional: PORT, ADMIN_PASSWORD

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const PUBLIC_DIR = path.join(ROOT, 'public');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const PORT = process.env.PORT || 3000;

// ---------- Util: storage sederhana berbasis file JSON ----------
function ensureFile(file, defaultValue) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(defaultValue, null, 2));
}
ensureFile(RECORDS_FILE, []);
ensureFile(CONFIG_FILE, {
  officeLat: -6.200000,
  officeLng: 106.816666,
  radiusMeters: 10,
  // Daftar karyawan: login memakai nomor telepon
  employees: [
    { phone: "081234567890", name: "Contoh Karyawan 1" },
    { phone: "081234567891", name: "Contoh Karyawan 2" },
  ],
  adminPassword: process.env.ADMIN_PASSWORD || "admin123",
  workStartTime: "08:00", // untuk hitung terlambat
  reportEmail: "f.yazid27@gmail.com",
});

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
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
    const config = readJSON(CONFIG_FILE);

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
        radiusMeters: config.radiusMeters,
      });
    }

    // ---- Cek nomor telepon terdaftar (sebelum ambil foto) ----
    if (pathName === '/api/check-phone' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const emp = config.employees.find((e) => e.phone === String(body.phone || '').trim());
      if (!emp) return sendJSON(res, 404, { error: 'Nomor telepon tidak terdaftar' });
      return sendJSON(res, 200, { name: emp.name });
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
      const { phone, type, lat, lng, photoBase64, deviceTime } = body;

      if (!phone || !type || typeof lat !== 'number' || typeof lng !== 'number' || !photoBase64) {
        return sendJSON(res, 400, { error: 'Data tidak lengkap (nomor telepon, tipe, lokasi, foto wajib diisi)' });
      }
      const emp = config.employees.find((e) => e.phone === String(phone).trim());
      if (!emp) {
        return sendJSON(res, 400, { error: 'Nomor telepon tidak terdaftar. Hubungi admin untuk didaftarkan.' });
      }

      const dist = distanceMeters(lat, lng, config.officeLat, config.officeLng);
      const withinRadius = dist <= config.radiusMeters;

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
        distanceMeters: Math.round(dist),
        withinRadius,
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
        distanceMeters: Math.round(dist),
        message: withinRadius
          ? 'Absen berhasil dan lokasi terverifikasi.'
          : `Absen tercatat, tetapi lokasi di luar radius kantor (jarak ${Math.round(dist)} m).`,
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

      const byEmployee = {};
      for (const emp of config.employees) {
        byEmployee[emp.name] = { employee: emp.name, hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0 };
      }
      for (const r of records) {
        if (!byEmployee[r.employee]) {
          byEmployee[r.employee] = { employee: r.employee, hariHadir: new Set(), totalAbsen: 0, diLuarRadius: 0, terlambat: 0 };
        }
        const e = byEmployee[r.employee];
        e.hariHadir.add(r.dateKey);
        e.totalAbsen += 1;
        if (!r.withinRadius) e.diLuarRadius += 1;
        if (r.type === 'masuk' && config.workStartTime && r.timeHHMM > config.workStartTime) {
          e.terlambat += 1;
        }
      }
      const summary = Object.values(byEmployee).map((e) => ({
        employee: e.employee,
        hariHadir: e.hariHadir.size,
        totalAbsen: e.totalAbsen,
        diLuarRadius: e.diLuarRadius,
        terlambat: e.terlambat,
      }));
      return sendJSON(res, 200, { month, summary, workStartTime: config.workStartTime });
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
