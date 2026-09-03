import { CSRF_COOKIE } from '../core/cookies.js';
import { constantTimeEquals } from '../core/crypto.js';
import { ForbiddenError } from '@govyzer/domain';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF protection. It only applies when the request is authorized by
 * cookies; bearer tokens and API keys are not vulnerable to CSRF.
 */
export function csrfProtection() {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (req.get('authorization') || req.get('x-api-key') || req.get('x-display-token')) return next();

    const cookieToken = req.cookies?.[CSRF_COOKIE];
    if (!cookieToken) return next();

    const headerToken = req.get('x-csrf-token');
    if (!headerToken || !constantTimeEquals(cookieToken, headerToken)) {
      return next(new ForbiddenError('Invalid or missing CSRF token'));
    }
    return next();
  };
}
