// Weekly gross-vs-net profit chart for the driver dashboard.
//
// "Gross" is total earnings before expenses; "net" is gross minus expenses.
// Bucketing is the part worth unit testing — SVG string-building is not
// (there's no meaningful assertion beyond "it didn't throw" / "it contains
// an <svg> tag"), so the two are kept as separate, independently callable
// functions: `bucketWeeklyProfit` (pure data) and `renderWeeklyProfitChartSvg`
// (hand-rolled SVG, no charting library — the repo has none and this is
// simple enough not to need one).

export class AnalyticsError extends Error {
  constructor(message, code = 'ANALYTICS_INVALID') {
    super(message);
    this.name = 'AnalyticsError';
    this.code = code;
  }
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Monday 00:00 UTC of the week containing `timestamp`.
function weekStartUtc(timestamp) {
  const d = new Date(timestamp);
  const utcMidnight = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const daysSinceMonday = (utcMidnight.getUTCDay() + 6) % 7;
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() - daysSinceMonday);
  return utcMidnight;
}

// ISO 8601 week key, e.g. "2024-W07" (Thursday-anchored per the ISO week-date rule).
function isoWeekKey(timestamp) {
  const monday = weekStartUtc(timestamp);
  const thursday = new Date(monday);
  thursday.setUTCDate(thursday.getUTCDate() + 3);
  const firstThursdayYearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstMonday = weekStartUtc(firstThursdayYearStart.getTime());
  const weekNumber = 1 + Math.round((monday.getTime() - firstMonday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${thursday.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

function validateRecords(records, field) {
  if (!Array.isArray(records)) {
    throw new AnalyticsError(`${field} must be an array`, 'ANALYTICS_RECORDS');
  }
  for (const r of records) {
    if (!r || typeof r.at !== 'number' || !Number.isFinite(r.at) || typeof r.amount !== 'number' || !Number.isFinite(r.amount)) {
      throw new AnalyticsError(`Each ${field} record needs a finite { at, amount }`, 'ANALYTICS_RECORDS');
    }
  }
  return records;
}

/**
 * Bucket earnings and expenses into ISO weeks, computing gross/expenses/net
 * per week.
 * @param {object} input
 * @param {Array<{at:number, amount:number}>} [input.earnings] Timestamped gross earnings.
 * @param {Array<{at:number, amount:number}>} [input.expenses] Timestamped expense amounts.
 * @returns {Array<{week:string, weekStart:string, gross:number, expenses:number, net:number}>} Sorted oldest week first.
 */
export function bucketWeeklyProfit(input = {}) {
  const { earnings = [], expenses = [] } = input;
  validateRecords(earnings, 'earnings');
  validateRecords(expenses, 'expenses');

  const buckets = new Map();
  function bucketFor(at) {
    const week = isoWeekKey(at);
    if (!buckets.has(week)) {
      buckets.set(week, { week, weekStart: weekStartUtc(at).toISOString().slice(0, 10), gross: 0, expenses: 0 });
    }
    return buckets.get(week);
  }

  for (const e of earnings) bucketFor(e.at).gross += e.amount;
  for (const e of expenses) bucketFor(e.at).expenses += e.amount;

  return [...buckets.values()]
    .map((b) => ({
      week: b.week,
      weekStart: b.weekStart,
      gross: roundMoney(b.gross),
      expenses: roundMoney(b.expenses),
      net: roundMoney(b.gross - b.expenses),
    }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

function escapeXml(value) {
  return String(value).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

/**
 * Render a weekly gross-vs-net bar chart as a self-contained SVG string.
 * @param {ReturnType<typeof bucketWeeklyProfit>} buckets
 * @param {object} [options]
 * @param {number} [options.width=600]
 * @param {number} [options.height=300]
 * @returns {string}
 */
export function renderWeeklyProfitChartSvg(buckets, options = {}) {
  const { width = 600, height = 300 } = options;
  const padding = 40;
  const baseline = height - padding;

  if (!Array.isArray(buckets) || buckets.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Weekly gross vs net profit (no data)"></svg>`;
  }

  const maxValue = Math.max(1, ...buckets.flatMap((b) => [b.gross, b.net]));
  const groupWidth = (width - padding * 2) / buckets.length;
  const barWidth = Math.max(1, groupWidth / 3);
  const scaleY = (height - padding * 2) / maxValue;

  const bars = buckets
    .map((b, i) => {
      const x = padding + i * groupWidth;
      const grossHeight = Math.max(0, b.gross) * scaleY;
      const netHeight = Math.max(0, b.net) * scaleY;
      return [
        `<rect x="${x}" y="${baseline - grossHeight}" width="${barWidth}" height="${grossHeight}" fill="#4C6EF5"><title>${escapeXml(b.week)} gross: ${b.gross}</title></rect>`,
        `<rect x="${x + barWidth + 2}" y="${baseline - netHeight}" width="${barWidth}" height="${netHeight}" fill="#12B886"><title>${escapeXml(b.week)} net: ${b.net}</title></rect>`,
        `<text x="${x + barWidth}" y="${baseline + 14}" font-size="10" text-anchor="middle">${escapeXml(b.week)}</text>`,
      ].join('');
    })
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Weekly gross vs net profit">
  <line x1="${padding}" y1="${baseline}" x2="${width - padding}" y2="${baseline}" stroke="#999" />
  ${bars}
</svg>`;
}
