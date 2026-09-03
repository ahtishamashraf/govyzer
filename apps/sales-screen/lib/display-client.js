'use client';

const TOKEN_KEY = 'gvz.display.token';
const CACHE_KEY = 'gvz.display.feed';

export function readToken() {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function storeToken(token) {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(CACHE_KEY);
}

/** Last successful feed, used to keep the wall readable through a short outage. */
export function readCachedFeed() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function cacheFeed(feed) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ feed, cached_at: Date.now() }));
  } catch {
    /* storage full or unavailable: the display keeps working without a cache */
  }
}

export async function pairDisplay({ code, appVersion = '1.0.0' }) {
  const response = await fetch('/api/bff/v1/display/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: code.trim().toUpperCase(),
      app_version: appVersion,
      device_fingerprint: `${window.screen.width}x${window.screen.height}:${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? 'Pairing failed');
  }
  return payload.data;
}

/**
 * Fetches the feed with an ETag. A 304 means nothing changed, which keeps the poll cheap
 * enough to run every few seconds on a television.
 */
export async function fetchFeed({ token, etag }) {
  const response = await fetch('/api/bff/v1/display/feed', {
    headers: { 'x-display-token': token, ...(etag ? { 'if-none-match': etag } : {}) },
    cache: 'no-store',
  });

  if (response.status === 304) return { unchanged: true, etag };
  if (response.status === 401 || response.status === 403) {
    const error = new Error('This display is no longer paired.');
    error.revoked = true;
    throw error;
  }
  if (!response.ok) throw new Error(`Feed request failed (${response.status})`);

  const payload = await response.json();
  return { feed: payload.data, etag: response.headers.get('etag') };
}

export async function sendHeartbeat({ token, appVersion = '1.0.0' }) {
  await fetch('/api/bff/v1/display/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-display-token': token },
    body: JSON.stringify({ app_version: appVersion }),
  }).catch(() => {});
}

export function formatMoney(value, currency = 'AED', locale = 'en-AE', compact = true) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 1 : 0,
  }).format(Number(value));
}

export function formatNumber(value, locale = 'en-AE') {
  return new Intl.NumberFormat(locale).format(Number(value ?? 0));
}
