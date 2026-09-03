/**
 * Same-origin BFF proxy. The browser only ever talks to the CRM's own origin, so session
 * cookies keep working on tenant subdomains and custom domains without third-party
 * cookie access. Server secrets never reach the browser.
 */
const API_URL = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'host',
  'content-length',
]);

async function proxy(request, context) {
  const params = await context.params;
  const path = (params.path ?? []).join('/');
  const url = new URL(request.url);
  const target = `${API_URL.replace(/\/$/, '')}/${path}${url.search}`;

  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  }
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));

  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
    cache: 'no-store',
  };
  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = await request.arrayBuffer();
    init.duplex = 'half';
  }

  let response;
  try {
    response = await fetch(target, init);
  } catch (error) {
    return Response.json(
      { error: { code: 'api_unreachable', message: `The API is not reachable at ${API_URL}` } },
      { status: 502 }
    );
  }

  const outHeaders = new Headers();
  for (const [key, value] of response.headers.entries()) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === 'set-cookie') continue;
    outHeaders.set(key, value);
  }
  // Node's fetch collapses multiple Set-Cookie headers; getSetCookie keeps them separate.
  const cookies = response.headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) outHeaders.append('set-cookie', cookie);

  return new Response(response.body, { status: response.status, headers: outHeaders });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const PUT = proxy;
export const DELETE = proxy;
export const dynamic = 'force-dynamic';
