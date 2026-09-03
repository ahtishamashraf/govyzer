import { randomUUID } from 'node:crypto';

/** Attaches a request id and a tenant-safe logging context to every request. */
export function requestContext() {
  return (req, res, next) => {
    const requestId = req.get('x-request-id') ?? randomUUID();
    req.requestId = requestId;
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    req.startedAt = Date.now();
    next();
  };
}

export function actorFromRequest(req) {
  return req.actor ?? null;
}

export function organizationId(req) {
  return req.actor?.organizationId ?? null;
}
