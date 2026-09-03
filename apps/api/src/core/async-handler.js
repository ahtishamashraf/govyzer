/** Wraps an async route handler so rejected promises reach the error middleware. */
export function handler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
