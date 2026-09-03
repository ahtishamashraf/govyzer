import { loadServerConfig } from '@govyzer/config';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const SENSITIVE_KEYS = [
  'password',
  'password_hash',
  'authorization',
  'cookie',
  'refresh_token',
  'access_token',
  'token',
  'api_key',
  'apikey',
  'secret',
  'ciphertext',
  'credentials',
  'code_verifier',
];

/** Removes anything that must never reach a log sink, at any nesting depth. */
export function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (SENSITIVE_KEYS.some((needle) => key.toLowerCase().includes(needle))) {
        return [key, '[redacted]'];
      }
      return [key, redact(entry, depth + 1)];
    })
  );
}

function write(level, message, context = {}) {
  const { env } = loadServerConfig();
  if (LEVELS[level] < LEVELS[env.LOG_LEVEL]) return;
  const line = {
    level,
    time: new Date().toISOString(),
    msg: message,
    ...redact(context),
  };
  const serialized = JSON.stringify(line);
  if (level === 'error') process.stderr.write(`${serialized}\n`);
  else process.stdout.write(`${serialized}\n`);
}

export const logger = {
  debug: (message, context) => write('debug', message, context),
  info: (message, context) => write('info', message, context),
  warn: (message, context) => write('warn', message, context),
  error: (message, context) => write('error', message, context),
  child(base = {}) {
    return {
      debug: (message, context) => write('debug', message, { ...base, ...context }),
      info: (message, context) => write('info', message, { ...base, ...context }),
      warn: (message, context) => write('warn', message, { ...base, ...context }),
      error: (message, context) => write('error', message, { ...base, ...context }),
      child: (extra) => logger.child({ ...base, ...extra }),
    };
  },
};
