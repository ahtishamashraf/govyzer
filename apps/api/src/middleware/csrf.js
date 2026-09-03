import { ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE } from '../core/cookies.js';
import { constantTimeEquals } from '../core/crypto.js';
import { ForbiddenError } from '@govyzer/domain';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Endpoints that never authorize from cookies. They are reached by machines (webhooks,
 * cron, tenant API keys) or by a display exchanging a one-time pairing code, so a CSRF
 * token is neither available nor meaningful there.
 */
const COOKIE_FREE_PREFIXES = ['/v1/webhooks', '/v1/cron', '/v1/public', '/v1/display'];

/**
 * Double-submit CSRF protection, applied only where a cookie could actually authorize a
 * state-changing request. Bearer tokens, API keys and display tokens are immune by
 * construction because a browser never attaches them automatically.
 */
export function csrfProtection() {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (req.get('authorization') || req.get('x-api-key') || req.get('x-display-token')) return next();
    if (COOKIE_FREE_PREFIXES.some((prefix) => req.path.startsWith(prefix))) return next();

    // Without a session cookie there is nothing for a cross-site request to ride on.
    const hasSessionCookie = Boolean(req.cookies?.[ACCESS_COOKIE] || req.cookies?.[REFRESH_COOKIE]);
    if (!hasSessionCookie) return next();

    const cookieToken = req.cookies?.[CSRF_COOKIE];
    if (!cookieToken) return next();

    const headerToken = req.get('x-csrf-token');
    if (!headerToken || !constantTimeEquals(cookieToken, headerToken)) {
      return next(new ForbiddenError('Invalid or missing CSRF token'));
    }
    return next();
  };
}
