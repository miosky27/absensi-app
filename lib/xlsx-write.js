// Penulis file .xlsx minimal tanpa library. Dipakai untuk export rekap, slip, dan template jadwal.
// Gaya sel (indeks xf): 0 normal, 1 tebal, 2 tebal+garis bawah, 3 tebal+garis atas, 4 isi biru, 5 isi hijau.
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
const XLSX_STYLE = { NORMAL: 0, BOLD: 1, BOLD_UNDERLINE: 2, BOLD_TOPBORDER: 3, FILL_BIRU: 4, FILL_HIJAU: 5 };

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
    `<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF00B0F0"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF92D050"/><bgColor indexed="64"/></patternFill></fill></fills>` +
    `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color indexed="64"/></top><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="6">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment/></xf>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>` +
    `<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>` +
    `<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>` +
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


module.exports = { buildXlsx, XLSX_STYLE };
