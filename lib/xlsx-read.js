// Pembaca file .xlsx tanpa library tambahan. File .xlsx adalah zip berisi XML.
// Dipakai untuk import karyawan dan jadwal kerja. Selain nilai sel, modul ini juga membaca
// warna isi sel (fill) dari styles.xml, supaya warna tugas di jadwal bisa dikenali.
const zlib = require('zlib');

function unzipEntries(buf) {
  const files = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Bukan file Excel (.xlsx) yang valid');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    files[name] = method === 8 ? zlib.inflateRawSync(raw) : raw;
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function xmlDecode(t) {
  return String(t).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&');
}

// "FF00B0F0" (ARGB) -> "00B0F0". Putih dan tanpa warna dianggap null.
function normalizeRgb(hex) {
  const rgb = String(hex).slice(-6).toUpperCase();
  return rgb === 'FFFFFF' ? null : rgb;
}

function colLettersToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n; // 1 = A
}

// Membaca sheet pertama: daftar sel { row, col (1 = A), v (teks atau angka, null kalau kosong), fill (RGB atau null) }.
function readSheetCells(buf) {
  const files = unzipEntries(buf);
  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    const xml = files['xl/sharedStrings.xml'].toString('utf8');
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(xmlDecode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
    }
  }

  // Warna per gaya sel: fills -> cellXfs (indeks gaya dipakai di atribut s="" pada sel).
  const fillByXf = [];
  if (files['xl/styles.xml']) {
    const sx = files['xl/styles.xml'].toString('utf8');
    const fillsBlock = (sx.match(/<fills[^>]*>([\s\S]*?)<\/fills>/) || [])[1] || '';
    const fills = [];
    for (const m of fillsBlock.matchAll(/<fill>([\s\S]*?)<\/fill>/g)) {
      const fg = m[1].match(/<fgColor[^>]*rgb="([0-9A-Fa-f]{6,8})"/);
      const pattern = (m[1].match(/patternType="(\w+)"/) || [])[1];
      fills.push(fg && pattern && pattern !== 'none' ? normalizeRgb(fg[1]) : null);
    }
    const xfBlock = (sx.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/) || [])[1] || '';
    for (const m of xfBlock.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)) {
      const f = (m[1].match(/fillId="(\d+)"/) || [])[1];
      fillByXf.push(f !== undefined && fills[Number(f)] !== undefined ? fills[Number(f)] : null);
    }
  }

  const sheetName = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) throw new Error('Sheet tidak ditemukan di file Excel');
  const xml = files[sheetName].toString('utf8');

  const cells = [];
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1];
    const inner = m[2] || '';
    const ref = attrs.match(/\br="([A-Z]+)(\d+)"/);
    if (!ref) continue;
    const t = (attrs.match(/\bt="(\w+)"/) || [])[1];
    const s = Number((attrs.match(/\bs="(\d+)"/) || [])[1] || 0);
    let v = null;
    if (t === 's') {
      const vi = inner.match(/<v>(\d+)<\/v>/);
      v = vi ? shared[Number(vi[1])] : null;
    } else if (t === 'inlineStr') {
      v = xmlDecode([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
    } else if (t === 'str' || t === 'e') {
      const vi = inner.match(/<v>([\s\S]*?)<\/v>/);
      v = vi ? xmlDecode(vi[1]) : null;
    } else {
      const vi = inner.match(/<v>([^<]*)<\/v>/);
      if (vi && vi[1] !== '') v = Number(vi[1]);
    }
    if (typeof v === 'string') v = v.trim() === '' ? null : v.trim();
    cells.push({ row: Number(ref[2]), col: colLettersToIndex(ref[1]), v, fill: fillByXf[s] || null });
  }
  return cells;
}

module.exports = { unzipEntries, xmlDecode, readSheetCells, colLettersToIndex };
