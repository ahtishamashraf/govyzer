/** Walks the live Express router so documentation is generated from real routes. */
export function collectRoutes(app) {
  const routes = [];

  const walk = (stack, prefix = '') => {
    for (const layer of stack) {
      if (layer.route) {
        const path = normalize(prefix + layer.route.path);
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (!enabled || method === '_all') continue;
          routes.push({ method: method.toUpperCase(), path });
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + extractPrefix(layer));
      }
    }
  };

  walk(app._router?.stack ?? app.router?.stack ?? []);
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function normalize(path) {
  return path.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

function extractPrefix(layer) {
  if (!layer.regexp) return '';
  const source = layer.regexp.source;
  if (source === '^\\/?(?=\\/|$)') return '';
  const match = source
    .replace('^\\/', '/')
    .replace('\\/?(?=\\/|$)', '')
    .replace(/\\\//g, '/')
    .replace(/\(\?:\(\[\^\\\/]\+\?\)\)/g, ':param');
  return match.replace(/\$$/, '');
}
