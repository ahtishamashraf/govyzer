import { ValidationError } from '@govyzer/domain';

function formatIssues(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    code: issue.code,
    message: issue.message,
  }));
}

/** Validates and replaces req.body / req.query / req.params with the parsed values. */
export function validate({ body = null, query = null, params = null }) {
  return (req, res, next) => {
    try {
      if (params) {
        const result = params.safeParse(req.params);
        if (!result.success) throw new ValidationError('Invalid path parameters', formatIssues(result.error));
        req.validatedParams = result.data;
      }
      if (query) {
        const result = query.safeParse(req.query);
        if (!result.success) throw new ValidationError('Invalid query parameters', formatIssues(result.error));
        req.validatedQuery = result.data;
      }
      if (body) {
        const result = body.safeParse(req.body ?? {});
        if (!result.success) throw new ValidationError('Invalid request body', formatIssues(result.error));
        req.validatedBody = result.data;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
