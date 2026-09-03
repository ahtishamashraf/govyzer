import { loadServerConfig } from '@govyzer/config';

export const ACCESS_COOKIE = 'gvz_at';
export const REFRESH_COOKIE = 'gvz_rt';
export const CSRF_COOKIE = 'gvz_csrf';

function baseOptions() {
  const { env } = loadServerConfig();
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SECURE ? 'none' : 'lax',
    path: '/',
    ...(env.SESSION_COOKIE_DOMAIN ? { domain: env.SESSION_COOKIE_DOMAIN } : {}),
  };
}

export function setAuthCookies(res, { accessToken, refreshToken, csrfToken }) {
  const { env } = loadServerConfig();
  res.cookie(ACCESS_COOKIE, accessToken, { ...baseOptions(), maxAge: env.JWT_ACCESS_TTL_SECONDS * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseOptions(),
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
  // Readable by the browser so the SPA can echo it back in the CSRF header.
  res.cookie(CSRF_COOKIE, csrfToken, { ...baseOptions(), httpOnly: false });
}

export function clearAuthCookies(res) {
  const options = { ...baseOptions(), maxAge: 0 };
  res.clearCookie(ACCESS_COOKIE, options);
  res.clearCookie(REFRESH_COOKIE, options);
  res.clearCookie(CSRF_COOKIE, { ...options, httpOnly: false });
}
