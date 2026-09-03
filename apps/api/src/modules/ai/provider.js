import { loadServerConfig } from '@govyzer/config';
import { logger } from '../../core/logger.js';

let client = null;

/** Lazily constructs the OpenAI client so the API boots fine without an API key. */
async function getClient() {
  const { env } = loadServerConfig();
  if (!env.OPENAI_API_KEY) return null;
  if (client) return client;
  const { default: OpenAI } = await import('openai');
  client = new OpenAI({ apiKey: env.OPENAI_API_KEY, ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}) });
  return client;
}

export function isAiEnabled() {
  const { env } = loadServerConfig();
  return env.AI_ENABLED && Boolean(env.OPENAI_API_KEY);
}

function zodToJsonSchema(schema) {
  // Minimal converter for the object shapes used by the AI features.
  const def = schema._def;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape();
      const properties = {};
      const required = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!value.isOptional()) required.push(key);
      }
      return { type: 'object', properties, required, additionalProperties: false };
    }
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def.type) };
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodNullable':
    case 'ZodOptional':
      return zodToJsonSchema(def.innerType);
    case 'ZodDefault':
      return zodToJsonSchema(def.innerType);
    default:
      return {};
  }
}

/**
 * Runs a structured completion. The response is validated against the supplied zod schema
 * before it is ever returned to the caller, and never written to authoritative fields
 * without a human confirming it.
 */
export async function structuredCompletion({ system, user, schema, schemaName = 'result', temperature = 0.2, maxTokens = null }) {
  const { env } = loadServerConfig();
  const openai = await getClient();
  if (!openai) {
    return { ok: false, reason: 'ai_disabled', message: 'AI is not configured on this deployment' };
  }

  const startedAt = Date.now();
  try {
    const response = await openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature,
      max_tokens: maxTokens ?? env.OPENAI_MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName, strict: true, schema: zodToJsonSchema(schema) },
      },
    });

    const content = response.choices?.[0]?.message?.content ?? '{}';
    const parsed = schema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      logger.warn('ai_schema_validation_failed', { feature: schemaName, issues: parsed.error.issues.length });
      return { ok: false, reason: 'invalid_structure', message: 'The model returned an unexpected structure' };
    }

    return {
      ok: true,
      data: parsed.data,
      usage: {
        model: env.OPENAI_MODEL,
        prompt_tokens: response.usage?.prompt_tokens ?? 0,
        completion_tokens: response.usage?.completion_tokens ?? 0,
        total_tokens: response.usage?.total_tokens ?? 0,
        duration_ms: Date.now() - startedAt,
      },
    };
  } catch (error) {
    logger.warn('ai_request_failed', { schema: schemaName, error: error.message });
    return { ok: false, reason: 'provider_error', message: error.message, usage: { duration_ms: Date.now() - startedAt } };
  }
}
