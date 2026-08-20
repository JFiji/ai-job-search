export const STATUS_COLORS = {
  "Drafted": "#64748b",
  "Active": "#3b82f6",
  "Interview": "#f59e0b",
  "Offer": "#8b5cf6",
  "Hired": "#22c55e",
  "Rejected/Closed": "#ef4444",
};

export function truncate(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export function filterRows(rows, { status, sector, search } = {}) {
  const term = (search || "").trim().toLowerCase();
  return rows.filter((row) => {
    if (status && row.bucket !== status) return false;
    if (sector && row.sector !== sector) return false;
    if (term) {
      const haystack = `${row.company} ${row.role} ${row.sector}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}

export function sortRowsNewestFirst(rows) {
  return [...rows].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.company.localeCompare(b.company);
  });
}

export function doughnutSlices(byBucket, colors) {
  const entries = Object.entries(byBucket).filter(([, count]) => count > 0);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return [];
  let angle = -90;
  return entries.map(([label, count]) => {
    const fraction = count / total;
    const startAngle = angle;
    const endAngle = angle + fraction * 360;
    angle = endAngle;
    return { label, count, color: colors[label] ?? "#94a3b8", startAngle, endAngle };
  });
}

export function barLengths(counts, maxWidth) {
  const max = Math.max(1, ...Object.values(counts));
  return Object.entries(counts).map(([label, count]) => ({
    label,
    count,
    width: (count / max) * maxWidth,
  }));
}
