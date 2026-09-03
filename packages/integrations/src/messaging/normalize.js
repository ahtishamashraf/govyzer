import { z } from 'zod';

/**
 * One normalized message contract for every channel. Whatsyncs and the official WhatsApp
 * Business Cloud adapter both produce exactly this shape, so the CRM is never coupled to
 * a single provider.
 */
export const normalizedMessageSchema = z.object({
  provider: z.string().min(1),
  channel: z.enum(['whatsapp', 'email', 'sms', 'call', 'other']),
  external_message_id: z.string().min(1),
  external_thread_id: z.string().min(1).nullable(),
  direction: z.enum(['inbound', 'outbound']),
  from_identifier: z.string().nullable(),
  to_identifier: z.string().nullable(),
  message_type: z.enum(['text', 'image', 'document', 'audio', 'video', 'location', 'template', 'system']).default('text'),
  body: z.string().nullable(),
  attachments: z
    .array(z.object({ url: z.string().nullable(), mime_type: z.string().nullable(), file_name: z.string().nullable(), size_bytes: z.number().nullable() }))
    .default([]),
  status: z.enum(['received', 'queued', 'sent', 'delivered', 'read', 'failed']).default('received'),
  sent_at: z.date().nullable(),
  delivered_at: z.date().nullable(),
  read_at: z.date().nullable(),
  account_identity: z.string().nullable(),
  provider_metadata: z.record(z.string(), z.unknown()).default({}),
});

export function normalizedMessage(values) {
  return normalizedMessageSchema.parse(values);
}

export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).length <= 13) {
    return new Date(String(value).length === 10 ? numeric * 1000 : numeric);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
