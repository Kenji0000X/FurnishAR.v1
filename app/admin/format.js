/**
 * The three formatters the console's pages all need.
 *
 * They used to be private to AdminConsole. Splitting the console into six
 * routes would otherwise have meant three copies of "how big is this file"
 * drifting apart — and a size the Stores page rounds differently from the
 * Usage page is the kind of thing that makes an operator doubt both numbers.
 */

export function timeAgo(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.round((then - Date.now()) / 1000);
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(seconds, 'second');
}

/**
 * The bucket's own limit is 100 MB (0005_raise_model_limit.sql), but a model
 * that big will take minutes on the 3G-ish connections this is built for, so
 * the console flags well before the hard ceiling — this is a "worth a second
 * look" line, not the actual limit.
 */
export const OVERSIZED_BYTES = 40 * 1024 * 1024;
export const isOversized = bytes => Number(bytes) > OVERSIZED_BYTES;

export function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const power = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / 1024 ** power;
  return `${value < 10 && power > 0 ? value.toFixed(1) : Math.round(value)} ${units[power]}`;
}

/** Turns a store name into the slug the shop will live at. */
export const slugify = value =>
  String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * A duration in days, the way people say it: "142 days", "1 year 24 days".
 * Used for how long a 3D model has gone unused (0012). A year is 365 days
 * here, the same year as the database's cleanup threshold.
 */
export function spanOf(days) {
  const n = Math.max(0, Math.floor(Number(days) || 0));
  if (n < 1) return 'today';
  const years = Math.floor(n / 365);
  const rest = n % 365;
  const part = (count, unit) => `${count} ${unit}${count === 1 ? '' : 's'}`;
  if (!years) return part(n, 'day');
  return rest ? `${part(years, 'year')} ${part(rest, 'day')}` : part(years, 'year');
}
