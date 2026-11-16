// Coarse relative time. The text changes at most once a day per entry, so an
// hourly rebuild does not produce a commit every hour.

export function bucket(iso, now) {
  const days = Math.floor((now - new Date(iso)) / 86400000);
  if (days < 1) return 'today'; // anything under 24 hours
  if (days < 7) return `${days} d ago`;
  if (days < 30) return `${Math.floor(days / 7)} w ago`;
  if (days < 365) return `${Math.floor(days / 30)} m ago`;
  return `${Math.floor(days / 365)} y ago`;
}
