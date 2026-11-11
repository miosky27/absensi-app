// Tes otomatis perhitungan gaji & absensi. Tanpa dependency: pakai node:test bawaan Node.
// Jalankan: npm test
//
// Setiap tes menjalankan server asli di folder data sementara, mengisi data contoh langsung
// ke file JSON, lalu memeriksa hasil API. Periode yang dipakai sudah lewat (Sep-Okt 2026),
// jadi hasilnya tidak tergantung tanggal hari ini.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FROM = '2026-09-26';
const TO = '2026-10-25'; // 30 hari
const ADMIN_EMAIL = 'f.yazid27@gmail.com';
const ADMIN_PASSWORD = 'admin123';

function daysBetween(from, to) {
  const out = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

let seq = 0;
function rec(employee, type, dateKey, timeHHMM, extra = {}) {
  seq += 1;
  return {
    id: `t${seq}`, phone: '', employee, type, dateKey, timeHHMM,
    nearestLocation: 'Kantor Tes', withinRadius: true, distanceMeters: 0,
    shift: type === 'masuk' ? 'Shift 1' : null,
    shiftStart: type === 'masuk' ? '08:00' : null,
    shiftEnd: type === 'masuk' ? '16:00' : null,
    ...extra,
  };
}

async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'absensi-test-'));
  const port = 45000 + Math.floor(Math.random() * 4000);
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const login = await (await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })).json();
  const auth = { Authorization: 'Bearer ' + login.token };
  const file = (name) => path.join(dataDir, name);
  const read = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8'));
  const write = (name, data) => fs.writeFileSync(file(name), JSON.stringify(data, null, 2));

  // Konfigurasi dasar: 1 lokasi, Shift 1 08:00-16:00, gaji 3jt (100rb/hari), jatah off 5.
  const config = read('config.json');
  config.locations = [{
    name: 'Kantor Tes', lat: 0, lng: 0, radiusMeters: 100, maxDistanceMeters: 1000,
    shifts: [{ name: 'Shift 1', startTime: '08:00', endTime: '16:00' }, { name: 'Shift 2', startTime: '13:00', endTime: '21:00' }],
  }];
  config.employees = [];
  config.jatahOffPerPeriode = 5;
  config.pengaliPotonganOff = 2;
  config.uangMakanPerHari = 10000;
  config.uangTransportPerHari = 5000;
  config.toleransiTerlambatMenit = 15;
  write('config.json', config);

  const addEmployee = (name, phone, tanggalMasuk) => {
    const c = read('config.json');
    c.employees.push({
      phone, name, namaDepan: name, namaBelakang: '', idNumber: '', position: 'Staff', email: '',
      tanggalMasuk, status: 'aktif', photoFilename: null, gajiPokok: 3000000, upahLemburPerJam: 0,
      tunjanganFungsional: 0, tunjanganNatura: 0, dapatUangMakan: true,
    });
    write('config.json', c);
  };
  const get = async (p) => (await fetch(base + p, { headers: auth })).json();
  const send = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, headers: { ...auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const payrollOf = async (name, from = FROM, to = TO) => {
    const d = await get(`/api/payroll?from=${from}&to=${to}`);
    return { ...d, p: d.payroll.find((x) => x.employee === name) };
  };
  const stop = () => { proc.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  return { base, auth, read, write, addEmployee, get, send, payrollOf, stop };
}

test('aturan alpa, lupa absen, dan sakit untuk karyawan yang sudah lama bekerja', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  s.addEmployee('Andi', '0811', '2025-01-01');
  const days = daysBetween(FROM, TO);
  const records = [];
  // 30 hari: hari 0 lupa pulang, hari 1 lupa masuk, hari 2 sakit, hari 24-29 alpa (6 hari),
  // sisanya hadir lengkap tepat waktu.
  days.forEach((dk, i) => {
    if (i === 2 || i >= 24) return;
    if (i !== 1) records.push(rec('Andi', 'masuk', dk, '08:00'));
    if (i !== 0) records.push(rec('Andi', 'keluar', dk, '16:00'));
  });
  s.write('records.json', records);
  s.write('leaves.json', [{ id: 'l1', employee: 'Andi', type: 'sakit', startDate: days[2], endDate: days[2], status: 'approved', createdAt: '2026-09-01' }]);

  const { p } = await s.payrollOf('Andi');
  assert.equal(p.hariHadir, 23, 'lupa absen tetap dihitung hadir');
  assert.equal(p.lupaAbsenHari, 2);
  assert.equal(p.hariSakit, 1);
  assert.equal(p.hariTidakHadir, 6, 'sakit bukan alpa');
  assert.equal(p.offBerlebih, 1, '6 alpa - jatah 5 = 1');
  assert.equal(p.potonganOff, 200000, '1 hari x 2x upah harian 100rb');
  assert.equal(p.uangMakan, 23 * 10000, 'sakit tidak dapat uang makan, lupa absen dapat');
  assert.equal(p.uangTransport, 23 * 5000);
  assert.equal(p.lemburAwalJam + p.lemburAkhirJam, 0, 'lupa absen tidak menimbulkan lembur');
  assert.equal(p.potonganPulangCepat, 0, 'lupa absen tidak dianggap pulang cepat');

  // Tampilan harian: jam yang kosong diisi sesuai shift.
  const lupaPulang = await s.get(`/api/records?date=${days[0]}`);
  assert.deepEqual(lupaPulang.lupaAbsen.Andi, { type: 'keluar', jam: '16:00', shift: 'Shift 1' });
  const lupaMasuk = await s.get(`/api/records?date=${days[1]}`);
  assert.deepEqual(lupaMasuk.lupaAbsen.Andi, { type: 'masuk', jam: '08:00', shift: 'Shift 1' });
});

test('karyawan baru masuk di tengah periode: potongan 1x sebelum masuk, jatah off prorata', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  s.addEmployee('Budi', '0812', '2026-10-11'); // 15 hari terakhir periode
  s.write('records.json', []);
  const { p } = await s.payrollOf('Budi');
  assert.equal(p.hariTidakHadir, 30);
  assert.equal(p.offBerlebih, 15 + 13, '15 hari sebelum masuk + (15 - jatah 2)');
  assert.equal(p.potonganOff, 15 * 100000 + 13 * 200000);
});

test('lembur di Rekap Absensi sama dengan slip gaji', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  s.addEmployee('Citra', '0813', '2025-01-01');
  const dk = '2026-10-01';
  s.write('records.json', [
    rec('Citra', 'masuk', dk, '07:40'), // 20 menit lembur awal -> 0,5 jam
    rec('Citra', 'keluar', dk, '16:50'), // 50 menit lembur akhir -> 1 jam
  ]);
  const { p } = await s.payrollOf('Citra');
  assert.equal(p.lemburAwalJam, 0.5);
  assert.equal(p.lemburAkhirJam, 1);
  const rekap = await s.get(`/api/summary?from=${FROM}&to=${TO}`);
  assert.equal(rekap.summary.find((x) => x.employee === 'Citra').lemburJam, 1.5);
});

test('kunci periode menyimpan angka gaji dan memblokir edit absen', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  s.addEmployee('Dewi', '0814', '2025-01-01');
  s.write('records.json', [rec('Dewi', 'masuk', '2026-10-01', '08:00'), rec('Dewi', 'keluar', '2026-10-01', '16:00')]);
  const before = (await s.payrollOf('Dewi')).p;

  const lock = await s.send('POST', '/api/payroll/lock', { from: FROM, to: TO });
  assert.equal(lock.status, 200);

  // Data berubah di belakang layar -> slip periode terkunci tetap sama.
  const recs = s.read('records.json');
  recs.push(rec('Dewi', 'masuk', '2026-10-02', '08:00'));
  s.write('records.json', recs);
  const locked = await s.payrollOf('Dewi');
  assert.equal(locked.locked, true);
  assert.equal(locked.p.hariHadir, before.hariHadir);

  const manual = await s.send('POST', '/api/records/manual', {
    phone: '0814', type: 'keluar', dateKey: '2026-10-03', timeHHMM: '16:00',
  });
  assert.equal(manual.status, 400, 'absen di periode terkunci ditolak');

  const overlap = await s.send('POST', '/api/payroll/lock', { from: '2026-10-20', to: '2026-11-25' });
  assert.equal(overlap.status, 400, 'periode tumpang tindih ditolak');
});
