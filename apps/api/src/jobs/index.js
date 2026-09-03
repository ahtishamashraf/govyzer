// Job handlers register themselves on import. Keeping the registration in one module
// means both the API process and the cron endpoints share the same handler table.
export const JOB_TYPES = Object.freeze({
  PORTAL_PUBLISH: 'portal.publish',
  PORTAL_UNPUBLISH: 'portal.unpublish',
  PORTAL_STATUS_REFRESH: 'portal.status_refresh',
  PORTAL_PULL_LEADS: 'portal.pull_leads',
  WEBHOOK_DELIVER: 'webhook.deliver',
  WEBHOOK_PROCESS: 'webhook.process',
  LEAD_SLA_CHECK: 'lead.sla_check',
  LEAD_AUTO_ASSIGN: 'lead.auto_assign',
  RESERVATION_EXPIRE: 'reservation.expire',
  HOLD_EXPIRE: 'hold.expire',
  REMINDER_DISPATCH: 'reminder.dispatch',
  WORKFLOW_RESUME: 'workflow.resume',
  WORKFLOW_RUN: 'workflow.run',
  DOCUMENT_GENERATE: 'document.generate',
  AI_ENRICH: 'ai.enrich',
  SALES_EVENT_AGGREGATE: 'sales_screen.aggregate',
  REPORT_RUN: 'report.run',
  DATA_RETENTION: 'data.retention',
  EXPORT_RUN: 'export.run',
});
