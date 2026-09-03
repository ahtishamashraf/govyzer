import { DomainError } from '@govyzer/domain';
import { logger } from '../core/logger.js';
import { buildErrorBody } from '../core/responses.js';

const MYSQL_ERROR_MAP = {
  ER_DUP_ENTRY: { status: 409, code: 'duplicate_record', message: 'A record with these values already exists' },
  ER_NO_REFERENCED_ROW_2: { status: 422, code: 'invalid_reference', message: 'A referenced record does not exist' },
  ER_ROW_IS_REFERENCED_2: { status: 409, code: 'record_in_use', message: 'This record is referenced by other data' },
  ER_LOCK_WAIT_TIMEOUT: { status: 503, code: 'lock_timeout', message: 'The record is busy, please retry' },
};

export function notFoundHandler() {
  return (req, res) => {
    res.status(404).json(
      buildErrorBody({
        code: 'route_not_found',
        message: `No route matches ${req.method} ${req.path}`,
        requestId: res.locals?.requestId ?? null,
      })
    );
  };
}

export function errorHandler() {
  // Express identifies an error handler by its four-argument signature.
  // eslint-disable-next-line no-unused-vars
  return (error, req, res, next) => {
    const requestId = res.locals?.requestId ?? null;

    if (error instanceof DomainError) {
      if (error.status >= 500) {
        logger.error('domain_error', { code: error.code, message: error.message, request_id: requestId });
      }
      return res
        .status(error.status)
        .json(buildErrorBody({ code: error.code, message: error.message, details: error.details, requestId }));
    }

    const mapped = MYSQL_ERROR_MAP[error?.code];
    if (mapped) {
      logger.warn('database_error', { code: error.code, request_id: requestId });
      return res.status(mapped.status).json(buildErrorBody({ ...mapped, requestId }));
    }

    if (error?.type === 'entity.parse.failed') {
      return res
        .status(400)
        .json(buildErrorBody({ code: 'invalid_json', message: 'Request body is not valid JSON', requestId }));
    }
    if (error?.message?.startsWith('Origin ')) {
      return res.status(403).json(buildErrorBody({ code: 'origin_not_allowed', message: error.message, requestId }));
    }

    logger.error('unhandled_error', {
      message: error?.message,
      stack: error?.stack?.split('\n').slice(0, 6).join('\n'),
      path: req.path,
      request_id: requestId,
    });
    return res.status(500).json(
      buildErrorBody({
        code: 'internal_error',
        message: 'An unexpected error occurred',
        requestId,
      })
    );
  };
}
