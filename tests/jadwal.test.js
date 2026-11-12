const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseJadwalXlsx, jadwalUntukKaryawan } = require('../lib/jadwal');

const sampleBuf = fs.readFileSync(path.join(__dirname, 'fixtures', 'jadwal-oktober-2026-contoh.xlsx'));

test('membaca nama, keterangan, dan catatan dari file jadwal contoh', () => {
  const d = parseJadwalXlsx(sampleBuf, '2026-10');
  assert.deepEqual(d.rows.map((r) => r.name), ['Supreti Adilah', 'Hani Hanafi', 'Rina Marlina']);
  assert.deepEqual(d.legend, [
    { warna: '00B0F0', arti: 'Membuat Laporan Penjualan' },
    { warna: '92D050', arti: 'Bertanggung Jawab atas Kebersihan Outlet' },
  ]);
  assert.deepEqual(d.notes, [
    'JAM MASUK ADALAH PUKUL 6:30',
    'Note : 31 Oktober Toko tutup 1 jam lebih awal untuk General Cleaning',
  ]);
  assert.deepEqual(d.warnings, []);
});

test('libur (X) dan tugas dari warna terbaca per tanggal', () => {
  const d = parseJadwalXlsx(sampleBuf, '2026-10');
  const supreti = d.rows.find((r) => r.name === 'Supreti Adilah');
  const libur = Object.keys(supreti.days).filter((k) => supreti.days[k].libur).map((k) => Number(k.slice(8)));
  assert.deepEqual(libur, [4, 8, 16, 24, 27]);
  assert.deepEqual(supreti.days['2026-10-02'], { shift: 'FL', tugas: 'Bertanggung Jawab atas Kebersihan Outlet' });
  assert.deepEqual(supreti.days['2026-10-01'], { shift: 'P', tugas: 'Membuat Laporan Penjualan' });
});

test('label hari yang salah di file ditandai dengan hari yang benar menurut kalender', () => {
  const d = parseJadwalXlsx(sampleBuf, '2026-10');
  assert.equal(d.mismatches.length, 18);
  assert.equal(d.mismatches[0].tanggal, '2026-10-14');
  assert.equal(d.mismatches[0].labelFile, 'KM');
  assert.equal(d.mismatches[0].benar, 'RB');
  // Tanggal 1-13 cocok dengan kalender.
  assert.ok(!d.mismatches.some((m) => Number(m.tanggal.slice(8)) <= 13));
});

test('jadwal per karyawan memakai hari dari kalender dan hanya tanggal yang berisi', () => {
  const d = parseJadwalXlsx(sampleBuf, '2026-10');
  const list = jadwalUntukKaryawan(d, '  SUPRETI   adilah ');
  assert.equal(list[0].tanggal, '2026-10-01');
  assert.equal(list[0].hari, 'Kamis');
  assert.equal(list[0].shiftLabel, 'Pagi 06:40-14:30');
  const libur = list.find((x) => x.tanggal === '2026-10-04');
  assert.equal(libur.libur, true);
  assert.equal(list.length, 28);
  assert.deepEqual(jadwalUntukKaryawan(d, 'Tidak Ada'), []);
});

test('menolak bulan yang tidak valid dan file tanpa baris tanggal', () => {
  assert.throws(() => parseJadwalXlsx(sampleBuf, '2026-13'), /Bulan tidak valid/);
  assert.throws(() => parseJadwalXlsx(sampleBuf, '2026/10'), /Bulan tidak valid/);
});

test('menolak file yang berisi tanggal lebih dari jumlah hari di bulan itu', () => {
  // File Oktober (31 hari) dibaca sebagai November (30 hari).
  assert.throws(() => parseJadwalXlsx(sampleBuf, '2026-11'), /hanya punya 30 hari/);
});
