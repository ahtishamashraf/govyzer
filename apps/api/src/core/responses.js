/** Consistent success envelope. Every list response carries the same meta shape. */
export function sendData(res, data, { status = 200, meta = null } = {}) {
  const body = { data };
  if (meta) body.meta = meta;
  if (res.locals?.requestId) body.request_id = res.locals.requestId;
  return res.status(status).json(body);
}

export function sendList(res, items, { page, perPage, total, cursor = null, nextCursor = null } = {}) {
  return res.status(200).json({
    data: items,
    meta: {
      page: page ?? null,
      per_page: perPage ?? items.length,
      total: total ?? null,
      total_pages: total != null && perPage ? Math.ceil(total / perPage) : null,
      cursor,
      next_cursor: nextCursor,
    },
    request_id: res.locals?.requestId ?? null,
  });
}

export function sendNoContent(res) {
  return res.status(204).send();
}

export function buildErrorBody({ code, message, details = null, requestId = null }) {
  return {
    error: {
      code,
      message,
      details,
    },
    request_id: requestId,
  };
}
