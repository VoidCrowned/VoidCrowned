// Coarse relative time. The text changes at most once a day per entry, so an
// hourly rebuild does not produce a commit every hour.

function dayNumber(date, timeZone) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date)
    .split('-')
    .map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

export function bucket(iso, now, timeZone) {
  const days = dayNumber(now, timeZone) - dayNumber(new Date(iso), timeZone);
  if (days <= 0) return 'today';
  if (days < 7) return `${days} d ago`;
  if (days < 30) return `${Math.floor(days / 7)} w ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} y ago`;
}
