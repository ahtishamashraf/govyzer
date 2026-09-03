const CURRENCY_FORMATTERS = new Map();

export function formatMoney(value, currency = 'AED', locale = 'en-AE', { compact = false } = {}) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const key = `${locale}:${currency}:${compact}`;
  if (!CURRENCY_FORMATTERS.has(key)) {
    CURRENCY_FORMATTERS.set(
      key,
      new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        maximumFractionDigits: compact ? 1 : 0,
        notation: compact ? 'compact' : 'standard',
      })
    );
  }
  return CURRENCY_FORMATTERS.get(key).format(Number(value));
}

export function formatNumber(value, locale = 'en-AE') {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat(locale).format(Number(value));
}

export function formatDate(value, locale = 'en-AE', options = { dateStyle: 'medium' }) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Dubai', ...options }).format(date);
}

export function formatDateTime(value, locale = 'en-AE') {
  return formatDate(value, locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function relativeTime(value, locale = 'en') {
  if (!value) return '—';
  const date = new Date(value);
  const diffMs = date.getTime() - Date.now();
  const units = [
    ['year', 365 * 24 * 60 * 60 * 1000],
    ['month', 30 * 24 * 60 * 60 * 1000],
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
  ];
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, ms] of units) {
    if (Math.abs(diffMs) >= ms || unit === 'minute') {
      return formatter.format(Math.round(diffMs / ms), unit);
    }
  }
  return formatter.format(0, 'minute');
}

export function formatArea(value, unit = 'sqft', locale = 'en-AE') {
  if (value === null || value === undefined) return '—';
  return `${new Intl.NumberFormat(locale).format(Number(value))} ${unit}`;
}

export function titleCase(value) {
  return String(value ?? '')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function initials(name) {
  return String(name ?? '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}
