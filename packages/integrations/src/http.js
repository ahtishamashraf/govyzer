import { IntegrationError } from '@govyzer/domain';

const REDACTED = '[redacted]';
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'apikey',
  'proxy-authorization',
]);

export function redactHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : value,
    ])
  );
}

export function redactBody(body, secretKeys = ['password', 'secret', 'token', 'api_key', 'apiKey']) {
  if (!body || typeof body !== 'object') return body;
  const output = Array.isArray(body) ? [...body] : { ...body };
  for (const key of Object.keys(output)) {
    if (secretKeys.some((secret) => key.toLowerCase().includes(secret.toLowerCase()))) {
      output[key] = REDACTED;
    } else if (output[key] && typeof output[key] === 'object') {
      output[key] = redactBody(output[key], secretKeys);
    }
  }
  return output;
}

/**
 * Fetch wrapper shared by every outbound adapter: bounded timeout, bounded retries with
 * exponential backoff, and a normalized error shape the job runner understands.
 */
export async function requestJson(
  url,
  { method = 'GET', headers = {}, body, timeoutMs = 15_000, retries = 2, provider = 'unknown', fetchImpl = fetch } = {}
) {
  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(url, {
        method,
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { raw: text };
      }

      const result = {
        ok: response.ok,
        status: response.status,
        body: parsed,
        rawBody: text,
        headers: Object.fromEntries(response.headers.entries()),
        durationMs: Date.now() - startedAt,
        correlationId:
          response.headers.get('x-request-id') ?? response.headers.get('x-correlation-id') ?? null,
      };

      if (!response.ok && response.status >= 500 && attempt < retries) {
        attempt += 1;
        await delay(attempt);
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      attempt += 1;
      await delay(attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new IntegrationError(`Request to ${provider} failed: ${lastError?.message ?? 'unknown error'}`, {
    provider,
    retryable: true,
  });
}

function delay(attempt) {
  return new Promise((resolve) => setTimeout(resolve, Math.min(2000 * 2 ** (attempt - 1), 10_000)));
}
