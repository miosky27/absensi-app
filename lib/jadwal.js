// Jadwal kerja karyawan: membaca file Excel jadwal bulanan.
//
// Format file yang didukung (lihat jadwal Outlet Indramayu sebagai contoh):
// - Baris tanggal 1..N (bisa dipecah jadi beberapa blok, misalnya 1-16 lalu 17-31).
// - Di bawah tanggal ada baris singkatan hari (SN, SL, RB, KM, JM, SB, MG). Label ini
//   hanya dicek; yang dipakai untuk tanggal adalah kalender.
// - Tiap baris karyawan: nama di kolom Nama, lalu sel per tanggal. Isi sel:
//     P / FL     = kode shift (P = Pagi 06:40-14:30, FL = Full 06:30-17:00)
//     X          = libur
//     warna sel  = jenis tugas, artinya ditulis di bagian keterangan (legenda) di luar tabel
//     kosong     = tidak ada jadwal
// - Keterangan (legenda): sel berwarna kosong di luar kolom tanggal, dengan teks tugas di sebelahnya.
// - Catatan: teks lain di luar tabel (misalnya "Note : ...", "JAM MASUK ..."). Disimpan apa adanya.

const { readSheetCells } = require('./xlsx-read');

const SHIFT_CODES = {
  P: { label: 'Pagi', jam: '06:40-14:30' },
  FL: { label: 'Full', jam: '06:30-17:00' },
};

// Singkatan hari di file -> hari dalam seminggu (0 = Minggu).
const WEEKDAY_CODES = { MG: 0, SN: 1, SL: 2, RB: 3, KM: 4, JM: 5, SB: 6 };
const WEEKDAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const WEEKDAY_CODE_BY_INDEX = Object.fromEntries(Object.entries(WEEKDAY_CODES).map(([code, idx]) => [idx, code]));

const isDayNumber = (c) => typeof c.v === 'number' && Number.isInteger(c.v) && c.v >= 1 && c.v <= 31;
const isWeekdayCode = (v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(WEEKDAY_CODES, v.toUpperCase());

function normalizeName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function daysInMonthOf(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function dateKeyOf(month, day) {
  return `${month}-${String(day).padStart(2, '0')}`;
}

// Hari dalam seminggu untuk tanggal tertentu (0 = Minggu), dihitung dari kalender.
function weekdayOf(month, day) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).getUTCDay();
}

// Membaca file jadwal (buffer .xlsx) untuk bulan "YYYY-MM".
// Mengembalikan data jadwal siap disimpan, atau melempar Error dengan pesan yang bisa ditampilkan admin.
function parseJadwalXlsx(buf, month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) throw new Error('Bulan tidak valid (format YYYY-MM)');
  const cells = readSheetCells(buf);
  const warnings = [];

  const byRow = new Map();
  const cellAt = new Map();
  for (const c of cells) {
    if (!byRow.has(c.row)) byRow.set(c.row, []);
    byRow.get(c.row).push(c);
    cellAt.set(`${c.row}:${c.col}`, c);
  }
  const rowNums = [...byRow.keys()].sort((a, b) => a - b);

  // Baris tanggal: baris yang punya minimal 3 angka tanggal.
  const headerRows = rowNums.filter((r) => byRow.get(r).filter(isDayNumber).length >= 3);
  if (headerRows.length === 0) throw new Error('Baris tanggal (1, 2, 3, ...) tidak ditemukan di file. Pastikan format sesuai contoh.');

  const daysInMonth = daysInMonthOf(month);
  const legendByFill = new Map();
  const legend = [];
  const notes = [];
  const unknownFills = new Set();
  const mismatches = [];
  const employees = new Map(); // nama (asli) -> { name, days }
  let maxDay = 0;
  const pendingEntries = [];

  headerRows.forEach((headerRow, idx) => {
    const blockEnd = idx + 1 < headerRows.length ? headerRows[idx + 1] - 1 : Infinity;
    const headerCells = byRow.get(headerRow);
    const dayCols = new Map(); // kolom -> tanggal
    for (const c of headerCells) if (isDayNumber(c)) dayCols.set(c.col, c.v);
    if (dayCols.size) maxDay = Math.max(maxDay, ...dayCols.values());
    const dayColSet = new Set(dayCols.keys());

    // Kolom nama: kolom bertuliskan "Nama" di baris tanggal, atau kolom A.
    const namaCell = headerCells.find((c) => typeof c.v === 'string' && c.v.toLowerCase() === 'nama');
    const nameCol = namaCell ? namaCell.col : 1;

    const blockRows = rowNums.filter((r) => r > headerRow && r <= blockEnd);

    // Baris singkatan hari: dipakai untuk cek label hari di file.
    const abbrRow = blockRows.find((r) => {
      const cs = byRow.get(r).filter((c) => dayColSet.has(c.col) && isWeekdayCode(c.v));
      return cs.length >= 3;
    });
    if (abbrRow !== undefined) {
      for (const c of byRow.get(abbrRow)) {
        if (!dayColSet.has(c.col) || !isWeekdayCode(c.v)) continue;
        const day = dayCols.get(c.col);
        const labelFile = String(c.v).toUpperCase();
        const benar = WEEKDAY_CODE_BY_INDEX[weekdayOf(month, day)];
        if (labelFile !== benar) mismatches.push({ tanggal: dateKeyOf(month, day), labelFile, benar });
      }
    }

    const rowKinds = new Map();
    for (const r of blockRows) {
      if (r === abbrRow) { rowKinds.set(r, 'abbr'); continue; }
      const rc = byRow.get(r);
      const nameCell = rc.find((c) => c.col === nameCol && typeof c.v === 'string');
      const hasDayCell = rc.some((c) => dayColSet.has(c.col) && (c.v !== null || c.fill));
      if (nameCell && hasDayCell && !isWeekdayCode(nameCell.v)) rowKinds.set(r, 'karyawan');
      else rowKinds.set(r, 'lainnya');
    }

    // Legenda: sel berwarna kosong di luar kolom tanggal, dengan teks di sel lain pada baris yang sama.
    for (const r of blockRows) {
      if (rowKinds.get(r) !== 'lainnya') continue;
      const rc = byRow.get(r);
      const swatch = rc.find((c) => c.fill && c.v === null && !dayColSet.has(c.col));
      const text = rc.find((c) => c !== swatch && typeof c.v === 'string' && !dayColSet.has(c.col));
      if (swatch && text) {
        if (!legendByFill.has(swatch.fill)) {
          legendByFill.set(swatch.fill, text.v);
          legend.push({ warna: swatch.fill, arti: text.v });
        }
        rowKinds.set(r, 'legenda');
      }
    }

    // Catatan: teks di luar tabel yang bukan legenda (misalnya "Note : ...", "JAM MASUK ...").
    for (const r of blockRows) {
      if (rowKinds.get(r) !== 'lainnya') continue;
      const texts = byRow.get(r).filter((c) => typeof c.v === 'string').map((c) => c.v);
      for (const t of texts) notes.push(t);
    }

    // Isi jadwal per karyawan dikerjakan setelah semua blok dibaca, karena keterangan warna bisa ada di blok mana pun.
    pendingEntries.push(() => {
    for (const r of blockRows) {
      if (rowKinds.get(r) !== 'karyawan') continue;
      const rc = byRow.get(r);
      const nameCell = rc.find((c) => c.col === nameCol);
      const name = String(nameCell.v).replace(/\s+/g, ' ').trim();
      const key = normalizeName(name);
      if (!employees.has(key)) employees.set(key, { name, days: {} });
      const emp = employees.get(key);

      for (const [col, day] of dayCols) {
        const c = cellAt.get(`${r}:${col}`);
        if (!c || (c.v === null && !c.fill)) continue;
        const entry = {};
        const txt = c.v === null ? '' : String(c.v).toUpperCase();
        if (txt === 'X') entry.libur = true;
        else if (SHIFT_CODES[txt]) entry.shift = txt;
        else if (c.v !== null) entry.teks = String(c.v);
        if (c.fill && !entry.libur) {
          if (legendByFill.has(c.fill)) entry.tugas = legendByFill.get(c.fill);
          else { entry.warna = c.fill; unknownFills.add(c.fill); }
        }
        if (Object.keys(entry).length) emp.days[dateKeyOf(month, day)] = entry;
      }
    }
    });
  });
  for (const run of pendingEntries) run();

  if (maxDay > daysInMonth) {
    throw new Error(`File berisi tanggal ${maxDay}, tetapi ${month} hanya punya ${daysInMonth} hari. Periksa bulan yang dipilih.`);
  }
  if (maxDay < daysInMonth) warnings.push(`File hanya berisi tanggal 1-${maxDay}, bulan ini punya ${daysInMonth} hari.`);
  if (unknownFills.size) warnings.push(`Ada warna sel yang tidak ada di keterangan: ${[...unknownFills].join(', ')}. Tambahkan keterangannya di file.`);
  if (employees.size === 0) warnings.push('Tidak ada baris karyawan yang terbaca.');

  return {
    month,
    rows: [...employees.values()],
    legend,
    notes: [...new Set(notes)],
    mismatches,
    warnings,
  };
}

// Jadwal satu karyawan untuk satu bulan, dengan keterangan shift dan tugas. Hanya tanggal yang punya isi.
function jadwalUntukKaryawan(monthData, employeeName) {
  const key = normalizeName(employeeName);
  const row = monthData.rows.find((r) => normalizeName(r.name) === key);
  if (!row) return [];
  return Object.keys(row.days).sort().map((dateKey) => {
    const entry = row.days[dateKey];
    const day = Number(dateKey.slice(8, 10));
    const weekday = weekdayOf(monthData.month, day);
    return {
      tanggal: dateKey,
      hari: WEEKDAY_NAMES[weekday],
      shift: entry.shift || null,
      shiftLabel: entry.shift ? `${SHIFT_CODES[entry.shift].label} ${SHIFT_CODES[entry.shift].jam}` : null,
      libur: !!entry.libur,
      tugas: entry.tugas || null,
      teks: entry.teks || null,
    };
  });
}

module.exports = {
  SHIFT_CODES,
  WEEKDAY_CODES,
  WEEKDAY_NAMES,
  parseJadwalXlsx,
  jadwalUntukKaryawan,
  normalizeName,
};
