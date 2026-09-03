import { getDb } from '@govyzer/database';
import { newId, ValidationError } from '@govyzer/domain';
import { enqueueJob } from '../../core/jobs.js';
import { JOB_TYPES } from '../../jobs/index.js';
import { logger } from '../../core/logger.js';
import { sendMail, renderBrandedEmail } from '../../core/mailer.js';
import { sha256 } from '../../core/crypto.js';

const MAX_DEPTH = 5;

function parse(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function readPath(context, path) {
  return String(path)
    .split('.')
    .reduce((accumulator, key) => (accumulator == null ? undefined : accumulator[key]), context);
}

const OPERATORS = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
  not_in: (a, b) => Array.isArray(b) && !b.includes(a),
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  contains: (a, b) => String(a ?? '').toLowerCase().includes(String(b).toLowerCase()),
  is_null: (a) => a == null,
  is_not_null: (a) => a != null,
};

/** Evaluates an AND-list of {field, operator, value} conditions against the run context. */
export function evaluateConditions(conditions = [], context = {}) {
  const results = conditions.map((condition) => {
    const operator = OPERATORS[condition.operator ?? 'eq'];
    if (!operator) return { ...condition, matched: false, reason: 'unknown_operator' };
    const actual = readPath(context, condition.field);
    return { ...condition, actual, matched: Boolean(operator(actual, condition.value)) };
  });
  return { matched: results.every((result) => result.matched), results };
}

async function executeAction({ db, organizationId, action, context, run }) {
  const config = action.config ?? {};
  switch (action.action_type) {
    case 'notify_user':
    case 'notify_manager': {
      const membershipId =
        action.action_type === 'notify_manager'
          ? config.membership_id ?? context.lead?.manager_membership_id ?? context.deal?.manager_membership_id
          : config.membership_id ?? context.lead?.assigned_membership_id ?? context.deal?.agent_membership_id;
      if (!membershipId) return { skipped: true, reason: 'no_recipient' };
      await db('notifications').insert({
        id: newId(),
        organization_id: organizationId,
        membership_id: membershipId,
        type: `workflow.${run.workflow_id}`,
        title: config.title ?? 'Workflow notification',
        body: config.body ?? null,
        data: JSON.stringify({ workflow_run_id: run.id, entity_type: run.entity_type, entity_id: run.entity_id }),
        entity_type: run.entity_type,
        entity_id: run.entity_id,
        priority: config.priority ?? 'normal',
      });
      return { notified: membershipId };
    }

    case 'assign_lead': {
      if (run.entity_type !== 'lead') return { skipped: true, reason: 'not_a_lead' };
      const { assignLead } = await import('../leads/assignment.js');
      const lead = await db('leads').where({ id: run.entity_id, organization_id: organizationId }).first();
      if (!lead) return { skipped: true, reason: 'lead_missing' };
      const decision = await assignLead({
        trx: db,
        organizationId,
        lead,
        manualMembershipId: config.membership_id ?? null,
        reason: `workflow:${run.workflow_id}`,
      });
      return { assigned_to: decision.membershipId, reason: decision.reason };
    }

    case 'add_to_lead_pool': {
      if (run.entity_type !== 'lead') return { skipped: true, reason: 'not_a_lead' };
      await db('lead_pool_entries').insert({
        id: newId(),
        organization_id: organizationId,
        lead_id: run.entity_id,
        status: 'available',
        release_reason: config.reason ?? 'workflow release',
      });
      await db('leads').where('id', run.entity_id).update({ is_in_pool: true, assigned_membership_id: null, updated_at: db.fn.now() });
      return { pooled: true };
    }

    case 'create_task': {
      const id = newId();
      await db('tasks').insert({
        id,
        organization_id: organizationId,
        title: config.title ?? 'Follow up',
        description: config.description ?? null,
        entity_type: run.entity_type,
        entity_id: run.entity_id,
        assigned_membership_id: config.membership_id ?? context.lead?.assigned_membership_id ?? null,
        priority: config.priority ?? 'normal',
        task_type: config.task_type ?? 'follow_up',
        due_at: config.due_in_minutes ? new Date(Date.now() + Number(config.due_in_minutes) * 60_000) : null,
        created_by_workflow_run_id: run.id,
      });
      return { task_id: id };
    }

    case 'update_field': {
      const table = { lead: 'leads', deal: 'deals', listing: 'listings', contact: 'contacts' }[run.entity_type];
      if (!table || !config.field) return { skipped: true, reason: 'unsupported_entity' };
      const allowed = ['priority', 'score', 'next_action', 'status', 'substage', 'loss_reason', 'is_featured'];
      if (!allowed.includes(config.field)) throw new ValidationError(`Workflows cannot write the ${config.field} field`);
      await db(table).where({ id: run.entity_id, organization_id: organizationId }).update({ [config.field]: config.value, updated_at: db.fn.now() });
      return { updated: config.field };
    }

    case 'change_stage': {
      if (run.entity_type !== 'lead') return { skipped: true, reason: 'not_a_lead' };
      const { applyStageChange } = await import('../leads/service.js');
      const lead = await db('leads').where({ id: run.entity_id, organization_id: organizationId }).first();
      if (!lead) return { skipped: true, reason: 'lead_missing' };
      await applyStageChange({ trx: db, organizationId, actor: null, lead, stageCode: config.stage_code, reason: 'workflow' });
      return { stage: config.stage_code };
    }

    case 'send_email': {
      const to = config.to ?? context.contact?.email;
      if (!to) return { skipped: true, reason: 'no_recipient' };
      const branding = await db('organization_branding').where('organization_id', organizationId).first();
      await sendMail({
        to,
        subject: config.subject ?? 'Update from your agent',
        html: renderBrandedEmail({ branding: branding ?? {}, title: config.subject ?? 'Update', bodyHtml: `<p>${config.body ?? ''}</p>` }),
        text: config.body ?? '',
        tags: { workflow_run_id: run.id },
      });
      return { emailed: to };
    }

    case 'send_whatsapp': {
      // Outbound messages always go through an authorized, connected provider.
      const connection = await db('integration_connections')
        .where({ organization_id: organizationId, category: 'messaging', is_enabled: true, status: 'connected' })
        .first();
      if (!connection) return { skipped: true, reason: 'no_connected_messaging_provider' };
      await enqueueJob({
        organizationId,
        jobType: JOB_TYPES.WEBHOOK_PROCESS,
        payload: { kind: 'outbound_whatsapp', connection_id: connection.id, to: config.to ?? context.contact?.phone, body: config.body, workflow_run_id: run.id },
      });
      return { queued: true, provider: connection.provider };
    }

    case 'call_webhook': {
      const endpoint = config.endpoint_id
        ? await db('webhook_endpoints').where({ id: config.endpoint_id, organization_id: organizationId }).first()
        : null;
      if (!endpoint) return { skipped: true, reason: 'endpoint_not_found' };
      await db('webhook_deliveries').insert({
        id: newId(),
        organization_id: organizationId,
        endpoint_id: endpoint.id,
        event_type: `workflow.${run.workflow_id}`,
        status: 'pending',
        payload: JSON.stringify({ workflow_run_id: run.id, entity_type: run.entity_type, entity_id: run.entity_id, data: config.payload ?? {} }),
      });
      return { queued: true };
    }

    case 'add_points': {
      const membershipId = config.membership_id ?? context.lead?.assigned_membership_id ?? context.deal?.agent_membership_id;
      if (!membershipId) return { skipped: true, reason: 'no_recipient' };
      await db('points_ledger').insert({
        id: newId(),
        organization_id: organizationId,
        membership_id: membershipId,
        rule_code: config.rule_code ?? 'workflow_award',
        event_type: 'milestone_reached',
        source_entity_type: run.entity_type,
        source_entity_id: run.entity_id,
        points: Number(config.points ?? 0),
        idempotency_key: `workflow:${run.id}:${action.position}`,
        occurred_at: db.fn.now(),
      });
      return { points: Number(config.points ?? 0) };
    }

    case 'create_sales_event': {
      const { createSalesEvent } = await import('../sales-screen/service.js');
      const event = await createSalesEvent({
        db,
        organizationId,
        eventType: config.event_type ?? 'milestone_reached',
        sourceEntityType: run.entity_type,
        sourceEntityId: run.entity_id,
        idempotencyKey: `workflow:${run.id}:${action.position}`,
        displayPayload: config.display_payload ?? { headline: config.headline ?? 'Milestone reached' },
        membershipId: config.membership_id ?? null,
      });
      return { sales_event_id: event?.id ?? null };
    }

    case 'wait': {
      const resumeAt = new Date(Date.now() + Number(config.minutes ?? 60) * 60_000);
      await db('workflow_runs').where('id', run.id).update({ status: 'waiting', resume_at: resumeAt });
      await enqueueJob({
        organizationId,
        jobType: JOB_TYPES.WORKFLOW_RESUME,
        payload: { run_id: run.id, resume_from_position: action.position + 1 },
        runAfter: resumeAt,
        dedupeKey: `workflow-resume:${run.id}:${action.position}`,
      });
      return { waiting_until: resumeAt.toISOString(), halt: true };
    }

    default:
      return { skipped: true, reason: `unsupported_action:${action.action_type}` };
  }
}

/** Executes one workflow version against one entity, from `startPosition` onwards. */
export async function runWorkflow({ db = getDb(), organizationId, runId = null, workflowId = null, versionId = null, entityType, entityId, triggerPayload = {}, depth = 0, startPosition = 0, isTestRun = false, idempotencyKey = null }) {
  if (depth > MAX_DEPTH) {
    logger.warn('workflow_depth_exceeded', { workflow_id: workflowId, entity_id: entityId });
    return { skipped: true, reason: 'max_depth_exceeded' };
  }

  let run = runId ? await db('workflow_runs').where('id', runId).first() : null;
  let version = run
    ? await db('workflow_versions').where('id', run.workflow_version_id).first()
    : await db('workflow_versions').where('id', versionId).first();
  if (!version) return { skipped: true, reason: 'version_missing' };

  const workflow = await db('workflow_definitions').where('id', version.workflow_id).first();
  if (!workflow) return { skipped: true, reason: 'workflow_missing' };

  const context = await buildContext({ db, organizationId, entityType, entityId, triggerPayload });
  const conditions = parse(version.conditions, []) ?? [];
  const evaluation = evaluateConditions(conditions, context);

  if (!run) {
    // Loop protection: bound how often one workflow can act on one entity per day.
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [{ total }] = await db('workflow_runs')
      .where({ organization_id: organizationId, workflow_id: workflow.id, entity_id: entityId })
      .where('started_at', '>=', dayStart)
      .count({ total: 'id' });
    if (Number(total) >= Number(workflow.max_runs_per_entity_per_day ?? 20)) {
      return { skipped: true, reason: 'run_limit_reached' };
    }

    const id = newId();
    await db('workflow_runs').insert({
      id,
      organization_id: organizationId,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      version_number: version.version_number,
      trigger_type: workflow.trigger_type,
      entity_type: entityType,
      entity_id: entityId,
      status: evaluation.matched ? 'running' : 'skipped',
      idempotency_key: idempotencyKey ?? sha256(`${workflow.id}:${entityId}:${JSON.stringify(triggerPayload)}`).slice(0, 60),
      depth,
      trigger_payload: JSON.stringify(triggerPayload),
      condition_result: JSON.stringify(evaluation),
      is_test_run: isTestRun,
    });
    run = await db('workflow_runs').where('id', id).first();
  }

  if (!evaluation.matched) {
    await db('workflow_runs').where('id', run.id).update({ status: 'skipped', finished_at: db.fn.now() });
    return { run_id: run.id, skipped: true, reason: 'conditions_not_met', evaluation };
  }

  const actions = (parse(version.actions, []) ?? []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const executed = [];

  for (const action of actions) {
    if ((action.position ?? 0) < startPosition) continue;
    const startedAt = Date.now();
    try {
      const output = isTestRun
        ? { dry_run: true, action_type: action.action_type, config: action.config ?? {} }
        : await executeAction({ db, organizationId, action, context, run });
      await db('workflow_action_runs').insert({
        id: newId(),
        organization_id: organizationId,
        run_id: run.id,
        position: action.position ?? 0,
        action_type: action.action_type,
        status: output?.skipped ? 'skipped' : 'completed',
        input: JSON.stringify(action.config ?? {}),
        output: JSON.stringify(output ?? {}),
        duration_ms: Date.now() - startedAt,
      });
      executed.push({ action: action.action_type, output });
      if (output?.halt) return { run_id: run.id, halted: true, executed };
    } catch (error) {
      await db('workflow_action_runs').insert({
        id: newId(),
        organization_id: organizationId,
        run_id: run.id,
        position: action.position ?? 0,
        action_type: action.action_type,
        status: 'failed',
        input: JSON.stringify(action.config ?? {}),
        error_message: String(error.message).slice(0, 1000),
        duration_ms: Date.now() - startedAt,
      });
      await db('workflow_runs').where('id', run.id).update({
        status: 'failed',
        failure_reason: String(error.message).slice(0, 1000),
        finished_at: db.fn.now(),
      });
      return { run_id: run.id, failed: true, error: error.message, executed };
    }
  }

  await db('workflow_runs').where('id', run.id).update({ status: 'completed', finished_at: db.fn.now() });
  return { run_id: run.id, completed: true, executed, evaluation };
}

async function buildContext({ db, organizationId, entityType, entityId, triggerPayload }) {
  const context = { trigger: triggerPayload, now: new Date().toISOString() };
  if (entityType === 'lead') {
    const lead = await db('leads').where({ id: entityId, organization_id: organizationId }).first();
    context.lead = lead ?? null;
    if (lead?.contact_id) {
      const contact = await db('contacts').where('id', lead.contact_id).first();
      const identifiers = await db('contact_identifiers').where({ organization_id: organizationId, contact_id: lead.contact_id });
      context.contact = contact
        ? {
            ...contact,
            email: identifiers.find((identifier) => identifier.identifier_type === 'email')?.value_raw ?? null,
            phone: identifiers.find((identifier) => ['phone', 'whatsapp'].includes(identifier.identifier_type))?.value_raw ?? null,
          }
        : null;
    }
  }
  if (entityType === 'deal') context.deal = await db('deals').where({ id: entityId, organization_id: organizationId }).first();
  if (entityType === 'listing') context.listing = await db('listings').where({ id: entityId, organization_id: organizationId }).first();
  if (entityType === 'reservation') context.reservation = await db('reservations').where({ id: entityId, organization_id: organizationId }).first();
  return context;
}

/** Finds the enabled workflows for a trigger and queues one run per workflow. */
export async function dispatchTrigger({ db = getDb(), organizationId, triggerType, entityType, entityId, payload = {}, depth = 0 }) {
  const workflows = await db('workflow_definitions')
    .where({ organization_id: organizationId, trigger_type: triggerType, is_enabled: true, status: 'published' })
    .whereNull('deleted_at');

  const queued = [];
  for (const workflow of workflows) {
    if (workflow.entity_type && workflow.entity_type !== entityType) continue;
    if (!workflow.current_version_id) continue;
    const jobId = await enqueueJob({
      organizationId,
      jobType: JOB_TYPES.WORKFLOW_RUN,
      payload: {
        workflow_id: workflow.id,
        version_id: workflow.current_version_id,
        entity_type: entityType,
        entity_id: entityId,
        trigger_payload: payload,
        depth,
      },
      dedupeKey: `workflow:${workflow.id}:${entityId}:${sha256(JSON.stringify(payload)).slice(0, 24)}`,
      trx: db,
    });
    queued.push(jobId);
  }
  return queued;
}
