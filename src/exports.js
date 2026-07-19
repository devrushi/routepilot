// CSV and PDF export of a driver's categorized expenses and mileage log,
// tax-ready and scoped to a date range.
//
// No PDF library dependency (matching the rest of this zero-dependency
// repo): `renderPdf` hand-rolls a minimal but valid single/multi-page PDF —
// a Catalog/Pages/Page/Font/Contents object graph, an xref table and
// trailer, with left-aligned monospace-ish text laid out top-to-bottom and
// paginated when it overflows a page. It supports plain Latin-1 text only
// (no embedded fonts/Unicode) — sufficient for the ASCII-range data this
// module renders (dates, category labels, amounts, currency codes).

export class ExportError extends Error {
  constructor(message, code = 'EXPORT_INVALID') {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

function toDateOnly(at) {
  return new Date(at).toISOString().slice(0, 10);
}

function inRange(at, { from, to } = {}) {
  if (from !== undefined && at < from) return false;
  if (to !== undefined && at > to) return false;
  return true;
}

function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(header, rows) {
  return [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';
}

/**
 * CSV of categorized expenses: Date, Category, Amount, Currency.
 * @param {object[]} expenses Categorized expense records (see expenses.js) — needs `at`, `category`/`categoryLabel`, `amount`, `currency`.
 * @param {object} [options]
 * @param {number} [options.from] Inclusive start (ms since epoch).
 * @param {number} [options.to] Inclusive end (ms since epoch).
 */
export function generateExpenseCsv(expenses, options = {}) {
  if (!Array.isArray(expenses)) {
    throw new ExportError('expenses must be an array', 'EXPORT_EXPENSES');
  }
  const rows = expenses
    .filter((e) => inRange(e.at, options))
    .sort((a, b) => a.at - b.at)
    .map((e) => [toDateOnly(e.at), e.categoryLabel ?? e.category, e.amount, e.currency]);
  return toCsv(['Date', 'Category', 'Amount', 'Currency'], rows);
}

/**
 * CSV of mileage log entries: Date, Distance (mi), Purpose.
 * @param {object[]} mileageEntries Needs `at`, `distanceMiles`, and optionally `purpose`.
 * @param {object} [options] `{ from, to }` (see {@link generateExpenseCsv}).
 */
export function generateMileageCsv(mileageEntries, options = {}) {
  if (!Array.isArray(mileageEntries)) {
    throw new ExportError('mileageEntries must be an array', 'EXPORT_MILEAGE');
  }
  const rows = mileageEntries
    .filter((m) => inRange(m.at, options))
    .sort((a, b) => a.at - b.at)
    .map((m) => [toDateOnly(m.at), m.distanceMiles, m.purpose ?? '']);
  return toCsv(['Date', 'Distance (mi)', 'Purpose'], rows);
}

function escapePdfText(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function paginateLines(lines, linesPerPage) {
  const pages = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage));
  }
  return pages.length > 0 ? pages : [[]];
}

/**
 * Render plain text lines as a minimal, valid multi-page PDF (Buffer).
 * @param {string[]} lines
 * @param {object} [options]
 * @param {number} [options.width=612] Page width in points (US Letter default).
 * @param {number} [options.height=792] Page height in points.
 * @param {number} [options.margin=50]
 * @param {number} [options.fontSize=10]
 * @param {number} [options.lineHeight=14]
 * @returns {Buffer}
 */
export function renderPdf(lines, options = {}) {
  const { width = 612, height = 792, margin = 50, fontSize = 10, lineHeight = 14 } = options;
  const linesPerPage = Math.max(1, Math.floor((height - margin * 2) / lineHeight));
  const pages = paginateLines(Array.isArray(lines) ? lines : [], linesPerPage);
  const fontObjNum = 3 + pages.length * 2;

  const objects = [];
  objects[0] = `<< /Type /Catalog /Pages 2 0 R >>`;
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects[1] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;

  pages.forEach((pageLines, i) => {
    const pageObjNum = 3 + i * 2;
    const contentObjNum = 4 + i * 2;
    objects[pageObjNum - 1] =
      `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> ` +
      `/MediaBox [0 0 ${width} ${height}] /Contents ${contentObjNum} 0 R >>`;

    let stream = `BT\n/F1 ${fontSize} Tf\n${margin} ${height - margin} Td\n`;
    pageLines.forEach((line, idx) => {
      const text = escapePdfText(line);
      stream += idx === 0 ? `(${text}) Tj\n` : `0 -${lineHeight} Td\n(${text}) Tj\n`;
    });
    stream += `ET`;
    objects[contentObjNum - 1] = { stream };
  });

  objects[fontObjNum - 1] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let num = 1; num <= objects.length; num += 1) {
    offsets.push(pdf.length);
    const obj = objects[num - 1];
    if (obj && typeof obj === 'object' && obj.stream !== undefined) {
      pdf += `${num} 0 obj\n<< /Length ${obj.stream.length} >>\nstream\n${obj.stream}\nendstream\nendobj\n`;
    } else {
      pdf += `${num} 0 obj\n${obj}\nendobj\n`;
    }
  }

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

/**
 * Render a tax-ready PDF combining a driver's categorized expenses and
 * mileage log for a date range.
 * @param {object} [dataset]
 * @param {object[]} [dataset.expenses] See {@link generateExpenseCsv}.
 * @param {object[]} [dataset.mileageEntries] See {@link generateMileageCsv}.
 * @param {number} [dataset.from] Inclusive start (ms since epoch).
 * @param {number} [dataset.to] Inclusive end (ms since epoch).
 * @param {object} [options] Forwarded to {@link renderPdf}.
 * @returns {Buffer}
 */
export function generateTaxExportPdf(dataset = {}, options = {}) {
  const { expenses = [], mileageEntries = [], from, to } = dataset;
  if (!Array.isArray(expenses) || !Array.isArray(mileageEntries)) {
    throw new ExportError('expenses and mileageEntries must be arrays', 'EXPORT_DATASET');
  }

  const lines = ['RoutePilot Tax Export'];
  if (from !== undefined || to !== undefined) {
    lines.push(`Range: ${from !== undefined ? toDateOnly(from) : '...'} to ${to !== undefined ? toDateOnly(to) : '...'}`);
  }
  lines.push('');

  lines.push('Expenses');
  lines.push('Date        Category                       Amount  Currency');
  const expenseRows = expenses.filter((e) => inRange(e.at, { from, to })).sort((a, b) => a.at - b.at);
  if (expenseRows.length === 0) {
    lines.push('  (none)');
  } else {
    for (const e of expenseRows) {
      lines.push(`${toDateOnly(e.at)}  ${String(e.categoryLabel ?? e.category ?? '').padEnd(29)}  ${String(e.amount).padStart(8)}  ${e.currency}`);
    }
  }

  lines.push('');
  lines.push('Mileage Log');
  lines.push('Date        Distance (mi)  Purpose');
  const mileageRows = mileageEntries.filter((m) => inRange(m.at, { from, to })).sort((a, b) => a.at - b.at);
  if (mileageRows.length === 0) {
    lines.push('  (none)');
  } else {
    for (const m of mileageRows) {
      lines.push(`${toDateOnly(m.at)}  ${String(m.distanceMiles).padStart(13)}  ${m.purpose ?? ''}`);
    }
  }

  return renderPdf(lines, options);
}
