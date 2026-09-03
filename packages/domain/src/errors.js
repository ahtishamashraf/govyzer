export class DomainError extends Error {
  constructor(message, { code = 'domain_error', status = 400, details = null } = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.expose = true;
  }
}

export class ValidationError extends DomainError {
  constructor(message, details) {
    super(message, { code: 'validation_error', status: 422, details });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends DomainError {
  constructor(entity = 'Resource') {
    super(`${entity} was not found`, { code: 'not_found', status: 404 });
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'You do not have permission to perform this action', details = null) {
    super(message, { code: 'forbidden', status: 403, details });
    this.name = 'ForbiddenError';
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Authentication is required') {
    super(message, { code: 'unauthorized', status: 401 });
    this.name = 'UnauthorizedError';
  }
}

export class ConflictError extends DomainError {
  constructor(message, details = null) {
    super(message, { code: 'conflict', status: 409, details });
    this.name = 'ConflictError';
  }
}

export class RateLimitError extends DomainError {
  constructor(retryAfterSeconds = 60) {
    super('Too many requests', { code: 'rate_limited', status: 429 });
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class IntegrationError extends DomainError {
  constructor(message, { provider, retryable = true, details = null } = {}) {
    super(message, { code: 'integration_error', status: 502, details });
    this.name = 'IntegrationError';
    this.provider = provider;
    this.retryable = retryable;
  }
}
