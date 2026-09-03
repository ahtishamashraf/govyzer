import { z } from 'zod';
import { requestJson } from '../http.js';
import { normalizedMessage, toDate } from './normalize.js';

/**
 * Google and Microsoft use documented, stable OAuth 2.0 and REST endpoints; both are
 * configured entirely from tenant credentials so nothing is hardcoded per customer.
 */
const GOOGLE = Object.freeze({
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  gmailBase: 'https://gmail.googleapis.com/gmail/v1',
  calendarBase: 'https://www.googleapis.com/calendar/v3',
  scopes: {
    email: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
    calendar: ['https://www.googleapis.com/auth/calendar.events'],
  },
});

const MICROSOFT = Object.freeze({
  authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  graphBase: 'https://graph.microsoft.com/v1.0',
  scopes: {
    email: ['offline_access', 'Mail.Read', 'Mail.Send'],
    calendar: ['offline_access', 'Calendars.ReadWrite'],
  },
});

const oauthCredentialSchema = z.object({
  client_id: z.string().min(4),
  client_secret: z.string().min(4),
  redirect_uri: z.string().url(),
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_at: z.coerce.date().optional(),
});

class OAuthAdapter {
  constructor({ code, name, category, provider }) {
    this.code = code;
    this.name = name;
    this.category = category;
    this.provider = provider;
    this.credentialSchema = oauthCredentialSchema;
  }

  getCapabilities() {
    return {
      oauth: true,
      readMessages: this.category === 'email',
      sendMessages: this.category === 'email',
      readEvents: this.category === 'calendar',
      writeEvents: this.category === 'calendar',
    };
  }

  validateConfiguration(config = {}) {
    const result = oauthCredentialSchema.safeParse(config);
    return result.success
      ? { valid: true, values: result.data, errors: [] }
      : {
          valid: false,
          values: null,
          errors: result.error.issues.map((issue) => ({
            code: 'invalid_configuration',
            field: issue.path.join('.') || null,
            message: issue.message,
            retryable: false,
            severity: 'error',
          })),
        };
  }

  buildAuthorizeUrl({ credentials, state, scopes = null }) {
    const config = this.provider === 'google' ? GOOGLE : MICROSOFT;
    const scopeList = scopes ?? config.scopes[this.category];
    const params = new URLSearchParams({
      client_id: credentials.client_id,
      redirect_uri: credentials.redirect_uri,
      response_type: 'code',
      scope: scopeList.join(' '),
      state,
      access_type: 'offline',
      prompt: 'consent',
    });
    return `${config.authorizeUrl}?${params.toString()}`;
  }

  async exchangeCode({ credentials, code, fetchImpl }) {
    const config = this.provider === 'google' ? GOOGLE : MICROSOFT;
    const body = new URLSearchParams({
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      redirect_uri: credentials.redirect_uri,
      grant_type: 'authorization_code',
      code,
    }).toString();

    const response = await requestJson(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      provider: this.code,
      fetchImpl,
    });
    if (!response.ok) {
      return { ok: false, status: 'token_exchange_failed', errors: [{ code: `http_${response.status}`, message: response.body?.error_description ?? `HTTP ${response.status}`, retryable: false, severity: 'error', field: null }] };
    }
    return {
      ok: true,
      status: 'connected',
      tokens: {
        access_token: response.body.access_token,
        refresh_token: response.body.refresh_token ?? null,
        expires_at: new Date(Date.now() + Number(response.body.expires_in ?? 3600) * 1000),
        scope: response.body.scope ?? null,
      },
    };
  }

  async refreshTokens({ credentials, fetchImpl }) {
    const config = this.provider === 'google' ? GOOGLE : MICROSOFT;
    const body = new URLSearchParams({
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      grant_type: 'refresh_token',
      refresh_token: credentials.refresh_token ?? '',
    }).toString();
    const response = await requestJson(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      provider: this.code,
      fetchImpl,
    });
    return response.ok
      ? { ok: true, tokens: { access_token: response.body.access_token, expires_at: new Date(Date.now() + Number(response.body.expires_in ?? 3600) * 1000) } }
      : { ok: false, status: 'refresh_failed', errors: [{ code: `http_${response.status}`, message: 'Token refresh failed', retryable: true, severity: 'error', field: null }] };
  }

  async testConnection({ credentials = {}, fetchImpl } = {}) {
    if (!credentials.access_token) return { ok: false, status: 'not_authorized', message: 'Complete the OAuth flow to connect this account' };
    const url =
      this.provider === 'google'
        ? `${GOOGLE.gmailBase}/users/me/profile`
        : `${MICROSOFT.graphBase}/me`;
    const response = await requestJson(url, {
      headers: { authorization: `Bearer ${credentials.access_token}` },
      provider: this.code,
      retries: 1,
      fetchImpl,
    });
    return response.ok
      ? { ok: true, status: 'connected', identity: response.body?.emailAddress ?? response.body?.mail ?? response.body?.userPrincipalName ?? null }
      : { ok: false, status: 'connection_failed', errors: [{ code: `http_${response.status}`, message: `HTTP ${response.status}`, retryable: response.status >= 500, severity: 'error', field: null }] };
  }

  normalizeEmail(message) {
    if (this.provider === 'google') {
      const headers = Object.fromEntries(
        (message.payload?.headers ?? []).map((header) => [header.name.toLowerCase(), header.value])
      );
      return normalizedMessage({
        provider: this.code,
        channel: 'email',
        external_message_id: String(message.id),
        external_thread_id: String(message.threadId ?? message.id),
        direction: (message.labelIds ?? []).includes('SENT') ? 'outbound' : 'inbound',
        from_identifier: headers.from ?? null,
        to_identifier: headers.to ?? null,
        message_type: 'text',
        body: message.snippet ?? null,
        attachments: [],
        status: 'received',
        sent_at: toDate(message.internalDate),
        delivered_at: null,
        read_at: (message.labelIds ?? []).includes('UNREAD') ? null : toDate(message.internalDate),
        account_identity: headers.delivered_to ?? null,
        provider_metadata: { subject: headers.subject ?? null, label_ids: message.labelIds ?? [] },
      });
    }
    return normalizedMessage({
      provider: this.code,
      channel: 'email',
      external_message_id: String(message.id),
      external_thread_id: String(message.conversationId ?? message.id),
      direction: message.isDraft ? 'outbound' : message.from?.emailAddress?.address ? 'inbound' : 'outbound',
      from_identifier: message.from?.emailAddress?.address ?? null,
      to_identifier: message.toRecipients?.[0]?.emailAddress?.address ?? null,
      message_type: 'text',
      body: message.bodyPreview ?? null,
      attachments: [],
      status: 'received',
      sent_at: toDate(message.sentDateTime),
      delivered_at: toDate(message.receivedDateTime),
      read_at: message.isRead ? toDate(message.receivedDateTime) : null,
      account_identity: null,
      provider_metadata: { subject: message.subject ?? null },
    });
  }

  async createCalendarEvent({ credentials, event, fetchImpl }) {
    if (!credentials.access_token) return { ok: false, status: 'not_authorized' };
    if (this.provider === 'google') {
      const response = await requestJson(`${GOOGLE.calendarBase}/calendars/primary/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credentials.access_token}` },
        body: {
          summary: event.title,
          location: event.location,
          description: event.description,
          start: { dateTime: new Date(event.starts_at).toISOString(), timeZone: event.timezone ?? 'Asia/Dubai' },
          end: { dateTime: new Date(event.ends_at).toISOString(), timeZone: event.timezone ?? 'Asia/Dubai' },
          attendees: (event.attendees ?? []).map((email) => ({ email })),
        },
        provider: this.code,
        fetchImpl,
      });
      return response.ok
        ? { ok: true, externalId: response.body.id, htmlLink: response.body.htmlLink ?? null }
        : { ok: false, status: 'failed', errors: [{ code: `http_${response.status}`, message: 'Calendar event creation failed', retryable: response.status >= 500, severity: 'error', field: null }] };
    }
    const response = await requestJson(`${MICROSOFT.graphBase}/me/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credentials.access_token}` },
      body: {
        subject: event.title,
        location: { displayName: event.location ?? '' },
        body: { contentType: 'text', content: event.description ?? '' },
        start: { dateTime: new Date(event.starts_at).toISOString(), timeZone: event.timezone ?? 'Asia/Dubai' },
        end: { dateTime: new Date(event.ends_at).toISOString(), timeZone: event.timezone ?? 'Asia/Dubai' },
        attendees: (event.attendees ?? []).map((email) => ({ emailAddress: { address: email }, type: 'required' })),
      },
      provider: this.code,
      fetchImpl,
    });
    return response.ok
      ? { ok: true, externalId: response.body.id, htmlLink: response.body.webLink ?? null }
      : { ok: false, status: 'failed', errors: [{ code: `http_${response.status}`, message: 'Calendar event creation failed', retryable: response.status >= 500, severity: 'error', field: null }] };
  }
}

export const gmailAdapter = new OAuthAdapter({ code: 'gmail', name: 'Gmail', category: 'email', provider: 'google' });
export const outlookAdapter = new OAuthAdapter({ code: 'outlook', name: 'Microsoft Outlook', category: 'email', provider: 'microsoft' });
export const googleCalendarAdapter = new OAuthAdapter({ code: 'google_calendar', name: 'Google Calendar', category: 'calendar', provider: 'google' });
export const microsoftCalendarAdapter = new OAuthAdapter({ code: 'microsoft_calendar', name: 'Microsoft Calendar', category: 'calendar', provider: 'microsoft' });

/** Generic inbound email ingestion (forwarding address / IMAP bridge posts JSON). */
export const genericEmailAdapter = {
  code: 'generic_email',
  name: 'Generic Email Ingestion',
  category: 'email',
  credentialSchema: z.object({ ingest_secret: z.string().min(8) }),
  getCapabilities: () => ({ oauth: false, readMessages: true, sendMessages: false }),
  validateConfiguration(config = {}) {
    const result = this.credentialSchema.safeParse(config);
    return result.success ? { valid: true, values: result.data, errors: [] } : { valid: false, values: null, errors: result.error.issues.map((issue) => ({ code: 'invalid_configuration', field: issue.path.join('.'), message: issue.message, retryable: false, severity: 'error' })) };
  },
  normalizeInbound(payload) {
    return [
      normalizedMessage({
        provider: 'generic_email',
        channel: 'email',
        external_message_id: String(payload.message_id ?? payload.id ?? ''),
        external_thread_id: String(payload.thread_id ?? payload.message_id ?? ''),
        direction: 'inbound',
        from_identifier: payload.from ?? null,
        to_identifier: Array.isArray(payload.to) ? payload.to[0] : payload.to ?? null,
        message_type: 'text',
        body: payload.text ?? payload.html ?? null,
        attachments: (payload.attachments ?? []).map((attachment) => ({
          url: attachment.url ?? null,
          mime_type: attachment.mime_type ?? null,
          file_name: attachment.file_name ?? null,
          size_bytes: attachment.size_bytes ?? null,
        })),
        status: 'received',
        sent_at: toDate(payload.date ?? payload.sent_at),
        delivered_at: null,
        read_at: null,
        account_identity: null,
        provider_metadata: { subject: payload.subject ?? null },
      }),
    ];
  },
};

/** Telephony/call-log provider contract. Any PBX able to POST call records fits it. */
export const genericTelephonyAdapter = {
  code: 'generic_telephony',
  name: 'Telephony / Call Logs',
  category: 'telephony',
  credentialSchema: z.object({ ingest_secret: z.string().min(8), recording_base_url: z.string().url().optional() }),
  getCapabilities: () => ({ callLogs: true, recordings: true, clickToCall: false }),
  validateConfiguration(config = {}) {
    const result = this.credentialSchema.safeParse(config);
    return result.success ? { valid: true, values: result.data, errors: [] } : { valid: false, values: null, errors: result.error.issues.map((issue) => ({ code: 'invalid_configuration', field: issue.path.join('.'), message: issue.message, retryable: false, severity: 'error' })) };
  },
  normalizeCall(payload) {
    return {
      provider: 'generic_telephony',
      external_id: String(payload.id ?? payload.call_id ?? ''),
      direction: payload.direction === 'outbound' ? 'outbound' : 'inbound',
      from_number: payload.from ?? null,
      to_number: payload.to ?? null,
      duration_seconds: Number(payload.duration ?? payload.duration_seconds ?? 0),
      status: payload.status ?? 'completed',
      recording_url: payload.recording_url ?? null,
      started_at: toDate(payload.started_at ?? payload.timestamp) ?? new Date(),
      agent_identifier: payload.agent ?? payload.extension ?? null,
      raw: payload,
    };
  },
};

export { GOOGLE as GOOGLE_ENDPOINTS, MICROSOFT as MICROSOFT_ENDPOINTS };
