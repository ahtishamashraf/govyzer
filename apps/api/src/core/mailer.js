import { loadServerConfig } from '@govyzer/config';
import { logger } from './logger.js';

/**
 * Minimal transactional mail dispatcher. The `log` driver is the local default so the
 * onboarding flows are testable without an SMTP account; SMTP is used in deployments.
 */
export async function sendMail({ to, subject, html, text, from = null, tags = {} }) {
  const { env } = loadServerConfig();
  const message = { to, from: from ?? env.MAIL_FROM, subject, html, text, tags };

  if (env.MAIL_DRIVER === 'log') {
    logger.info('mail_dispatched', { to, subject, driver: 'log', tags });
    return { delivered: true, driver: 'log', message };
  }

  const nodemailer = await import('nodemailer').catch(() => null);
  if (!nodemailer) {
    logger.warn('mail_driver_unavailable', { driver: env.MAIL_DRIVER, reason: 'nodemailer is not installed' });
    return { delivered: false, driver: env.MAIL_DRIVER, reason: 'nodemailer_not_installed' };
  }
  const transport = nodemailer.default.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });
  await transport.sendMail(message);
  logger.info('mail_dispatched', { to, subject, driver: 'smtp' });
  return { delivered: true, driver: 'smtp' };
}

export function renderBrandedEmail({ branding = {}, title, bodyHtml, actionUrl = null, actionLabel = null }) {
  const primary = branding.primary_color ?? '#0F5132';
  const company = branding.company_display_name ?? 'Govyzer';
  const button = actionUrl
    ? `<p style="margin:24px 0"><a href="${actionUrl}" style="background:${primary};color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${actionLabel ?? 'Open'}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:Inter,Arial,sans-serif;color:#111827">
  ${branding.email_header_html ?? ''}
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;padding:32px">
    <h1 style="font-size:20px;margin:0 0 16px">${title}</h1>
    <div style="font-size:14px;line-height:22px">${bodyHtml}</div>
    ${button}
    <p style="font-size:12px;color:#6b7280;margin-top:32px">${company}</p>
  </div>
  ${branding.email_footer_html ?? ''}
  </body></html>`;
}
