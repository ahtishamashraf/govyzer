import { Router } from 'express';
import { z } from 'zod';
import { getDb, withTransaction } from '@govyzer/database';
import { newId, NotFoundError, ValidationError, DEFAULT_ROLES, PERMISSIONS } from '@govyzer/domain';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth, requireOrganization, requirePermission } from '../../middleware/auth.js';
import { handler } from '../../core/async-handler.js';
import { sendData, sendList, sendNoContent } from '../../core/responses.js';
import { recordAudit, auditFromRequest } from '../../core/audit.js';
import { idSchema, paginationSchema } from '@govyzer/validation';

const organizationUpdateSchema = z.object({
  name: z.string().min(2).max(180).optional(),
  legal_name: z.string().max(180).optional(),
  country: z.string().length(2).optional(),
  default_locale: z.enum(['en', 'ar']).optional(),
  default_currency: z.string().length(3).optional(),
  timezone: z.string().max(64).optional(),
  date_format: z.string().max(24).optional(),
  fiscal_year_start_month: z.coerce.number().int().min(1).max(12).optional(),
  reference_prefix: z.string().min(2).max(12).optional(),
  vat_percentage: z.coerce.number().min(0).max(100).optional(),
  commission_base: z.enum(['gross_before_vat', 'gross_after_vat', 'net_after_costs']).optional(),
  terminology: z.record(z.string(), z.string().max(80)).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

const brandingSchema = z.object({
  company_display_name: z.string().max(180).optional(),
  logo_light_url: z.string().url().max(512).nullable().optional(),
  logo_dark_url: z.string().url().max(512).nullable().optional(),
  favicon_url: z.string().url().max(512).nullable().optional(),
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  secondary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  font_family: z.string().max(120).optional(),
  login_headline: z.string().max(200).nullable().optional(),
  login_background_url: z.string().url().max(512).nullable().optional(),
  email_header_html: z.string().max(20000).nullable().optional(),
  email_footer_html: z.string().max(20000).nullable().optional(),
  document_header_html: z.string().max(20000).nullable().optional(),
  document_footer_html: z.string().max(20000).nullable().optional(),
  sales_screen_theme: z.string().max(40).optional(),
  sales_screen_theme_overrides: z.record(z.string(), z.string().max(60)).nullable().optional(),
});

const domainSchema = z.object({
  hostname: z
    .string()
    .min(4)
    .max(190)
    .regex(/^[a-z0-9.-]+$/, 'Enter a valid hostname'),
  type: z.enum(['subdomain', 'custom']).default('custom'),
  is_primary: z.boolean().default(false),
});

const branchSchema = z.object({
  name: z.string().min(1).max(160),
  code: z.string().min(1).max(40),
  address_line: z.string().max(240).optional(),
  city: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().max(190).optional(),
  timezone: z.string().max(64).optional(),
  is_active: z.boolean().default(true),
});

const teamSchema = z.object({
  name: z.string().min(1).max(160),
  code: z.string().min(1).max(40),
  branch_id: idSchema.optional(),
  department_id: idSchema.optional(),
  manager_membership_id: idSchema.optional(),
  leader_membership_id: idSchema.optional(),
  modules: z.array(z.enum(['ready', 'offplan', 'sales_screen'])).optional(),
  is_active: z.boolean().default(true),
});

const roleSchema = z.object({
  code: z.string().min(2).max(60).regex(/^[a-z0-9_]+$/),
  name: z.string().min(2).max(120),
  description: z.string().max(300).optional(),
  permissions: z.array(z.string().max(80)).min(1),
  priority: z.coerce.number().int().min(1).max(1000).default(100),
});

const customFieldSchema = z.object({
  entity_type: z.enum(['contact', 'lead', 'listing', 'unit', 'project', 'deal']),
  field_key: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/),
  label: z.object({ en: z.string().max(160), ar: z.string().max(160).optional() }),
  field_type: z.enum(['text', 'number', 'date', 'select', 'multiselect', 'boolean', 'url', 'currency']),
  options: z.array(z.object({ value: z.string().max(80), label: z.string().max(160) })).optional(),
  is_required: z.boolean().default(false),
  is_searchable: z.boolean().default(false),
  is_sensitive: z.boolean().default(false),
  position: z.coerce.number().int().min(0).default(0),
  is_active: z.boolean().default(true),
});

export function organizationRoutes() {
  const router = Router();
  router.use(authenticate(), requireAuth(), requireOrganization());

  router.get(
    '/',
    requirePermission('organization.read'),
    handler(async (req, res) => {
      const db = getDb();
      const organization = await db('organizations').where('id', req.actor.organizationId).first();
      const branding = await db('organization_branding').where('organization_id', req.actor.organizationId).first();
      const subscription = await db('organization_subscriptions')
        .leftJoin('subscription_plans', 'subscription_plans.id', 'organization_subscriptions.plan_id')
        .where('organization_subscriptions.organization_id', req.actor.organizationId)
        .orderBy('organization_subscriptions.created_at', 'desc')
        .first(
          'organization_subscriptions.status',
          'organization_subscriptions.seats',
          'organization_subscriptions.current_period_end',
          'organization_subscriptions.modules_override',
          'subscription_plans.code as plan_code',
          'subscription_plans.name as plan_name',
          'subscription_plans.limits',
          'subscription_plans.modules'
        );
      sendData(res, { organization, branding, subscription });
    })
  );

  router.patch(
    '/',
    requirePermission('organization.update'),
    validate({ body: organizationUpdateSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const before = await db('organizations').where('id', req.actor.organizationId).first();
      const payload = { ...req.validatedBody };
      if (payload.terminology) payload.terminology = JSON.stringify(payload.terminology);
      if (payload.settings) payload.settings = JSON.stringify(payload.settings);
      await db('organizations').where('id', req.actor.organizationId).update({ ...payload, updated_at: db.fn.now() });
      const after = await db('organizations').where('id', req.actor.organizationId).first();
      await recordAudit({ ...auditFromRequest(req), action: 'organization.updated', entityType: 'organization', entityId: after.id, before, after });
      sendData(res, after);
    })
  );

  router.get(
    '/branding',
    requirePermission('organization.read'),
    handler(async (req, res) => {
      const branding = await getDb()('organization_branding').where('organization_id', req.actor.organizationId).first();
      sendData(res, branding ?? null);
    })
  );

  router.patch(
    '/branding',
    requirePermission('organization.branding'),
    validate({ body: brandingSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const payload = { ...req.validatedBody };
      if (payload.sales_screen_theme_overrides !== undefined) {
        payload.sales_screen_theme_overrides = payload.sales_screen_theme_overrides
          ? JSON.stringify(payload.sales_screen_theme_overrides)
          : null;
      }
      const existing = await db('organization_branding').where('organization_id', req.actor.organizationId).first();
      if (existing) {
        await db('organization_branding').where('id', existing.id).update({ ...payload, updated_at: db.fn.now() });
      } else {
        await db('organization_branding').insert({ id: newId(), organization_id: req.actor.organizationId, ...payload });
      }
      const branding = await db('organization_branding').where('organization_id', req.actor.organizationId).first();
      await recordAudit({ ...auditFromRequest(req), action: 'organization.branding_updated', entityType: 'organization_branding', entityId: branding.id, before: existing, after: branding });
      sendData(res, branding);
    })
  );

  router.get(
    '/domains',
    requirePermission('organization.read'),
    handler(async (req, res) => {
      sendData(res, await getDb()('organization_domains').where('organization_id', req.actor.organizationId).orderBy('created_at'));
    })
  );

  router.post(
    '/domains',
    requirePermission('organization.domains'),
    validate({ body: domainSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const hostname = req.validatedBody.hostname.toLowerCase();
      const taken = await db('organization_domains').where('hostname', hostname).first('id');
      if (taken) throw new ValidationError('That hostname is already registered', [{ path: 'hostname', message: 'Already in use' }]);

      const id = newId();
      const verificationToken = `govyzer-verify=${newId().toLowerCase()}`;
      await db('organization_domains').insert({
        id,
        organization_id: req.actor.organizationId,
        hostname,
        type: req.validatedBody.type,
        is_primary: req.validatedBody.is_primary,
        status: req.validatedBody.type === 'custom' ? 'pending' : 'active',
        verification_method: 'dns_txt',
        verification_token: verificationToken,
        verified_at: req.validatedBody.type === 'custom' ? null : db.fn.now(),
      });
      const domain = await db('organization_domains').where('id', id).first();
      await recordAudit({ ...auditFromRequest(req), action: 'organization.domain_added', entityType: 'organization_domain', entityId: id, after: domain });
      sendData(res, { ...domain, dns_instructions: { type: 'TXT', name: `_govyzer.${hostname}`, value: verificationToken } }, { status: 201 });
    })
  );

  router.post(
    '/domains/:id/verify',
    requirePermission('organization.domains'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const domain = await db('organization_domains')
        .where({ id: req.validatedParams.id, organization_id: req.actor.organizationId })
        .first();
      if (!domain) throw new NotFoundError('Domain');

      const resolver = await import('node:dns/promises');
      let records = [];
      try {
        records = (await resolver.resolveTxt(`_govyzer.${domain.hostname}`)).flat();
      } catch {
        records = [];
      }
      const verified = records.some((record) => record.includes(domain.verification_token));
      await db('organization_domains')
        .where('id', domain.id)
        .update({ status: verified ? 'active' : 'pending', verified_at: verified ? db.fn.now() : null, updated_at: db.fn.now() });

      sendData(res, {
        verified,
        hostname: domain.hostname,
        expected_record: { type: 'TXT', name: `_govyzer.${domain.hostname}`, value: domain.verification_token },
        found_records: records.slice(0, 5),
      });
    })
  );

  router.get(
    '/branches',
    requirePermission('organization.read'),
    handler(async (req, res) => {
      sendData(res, await getDb()('branches').where('organization_id', req.actor.organizationId).whereNull('deleted_at').orderBy('name'));
    })
  );

  router.post(
    '/branches',
    requirePermission('organization.update'),
    validate({ body: branchSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const id = newId();
      await db('branches').insert({ id, organization_id: req.actor.organizationId, ...req.validatedBody, created_by: req.actor.membershipId });
      const branch = await db('branches').where('id', id).first();
      await recordAudit({ ...auditFromRequest(req), action: 'branch.created', entityType: 'branch', entityId: id, after: branch });
      sendData(res, branch, { status: 201 });
    })
  );

  router.get(
    '/teams',
    requirePermission('organization.read'),
    handler(async (req, res) => {
      sendData(res, await getDb()('teams').where('organization_id', req.actor.organizationId).whereNull('deleted_at').orderBy('name'));
    })
  );

  router.post(
    '/teams',
    requirePermission('organization.update'),
    validate({ body: teamSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const id = newId();
      const payload = { ...req.validatedBody };
      if (payload.modules) payload.modules = JSON.stringify(payload.modules);
      await db('teams').insert({ id, organization_id: req.actor.organizationId, ...payload });
      const team = await db('teams').where('id', id).first();
      await recordAudit({ ...auditFromRequest(req), action: 'team.created', entityType: 'team', entityId: id, after: team });
      sendData(res, team, { status: 201 });
    })
  );

  router.get(
    '/roles',
    requirePermission('roles.read'),
    handler(async (req, res) => {
      const db = getDb();
      const roles = await db('roles')
        .where((builder) => builder.where('organization_id', req.actor.organizationId).orWhere('organization_id', ''))
        .whereNull('deleted_at')
        .orderBy('priority');
      const permissionsByRole = await db('role_permissions')
        .join('permissions', 'permissions.id', 'role_permissions.permission_id')
        .whereIn('role_permissions.role_id', roles.map((role) => role.id))
        .select('role_permissions.role_id', 'permissions.code');
      const grouped = permissionsByRole.reduce((accumulator, row) => {
        accumulator[row.role_id] = [...(accumulator[row.role_id] ?? []), row.code];
        return accumulator;
      }, {});
      sendData(res, roles.map((role) => ({ ...role, permissions: grouped[role.id] ?? [] })));
    })
  );

  router.get(
    '/permissions',
    requirePermission('roles.read'),
    handler(async (req, res) => {
      sendData(
        res,
        PERMISSIONS.map(([code, module, description]) => ({ code, module, description }))
      );
    })
  );

  router.post(
    '/roles',
    requirePermission('roles.manage'),
    validate({ body: roleSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const known = new Set(PERMISSIONS.map(([code]) => code));
      const unknown = req.validatedBody.permissions.filter((code) => !known.has(code));
      if (unknown.length > 0) {
        throw new ValidationError('Unknown permissions requested', unknown.map((code) => ({ path: 'permissions', message: `Unknown permission ${code}` })));
      }
      const id = newId();
      await db('roles').insert({
        id,
        organization_id: req.actor.organizationId,
        code: req.validatedBody.code,
        name: req.validatedBody.name,
        description: req.validatedBody.description ?? null,
        is_system: false,
        priority: req.validatedBody.priority,
      });
      const permissionIds = await db('permissions').whereIn('code', req.validatedBody.permissions).pluck('id');
      await db('role_permissions').insert(permissionIds.map((permissionId) => ({ role_id: id, permission_id: permissionId })));
      const role = await db('roles').where('id', id).first();
      await recordAudit({ ...auditFromRequest(req), action: 'role.created', entityType: 'role', entityId: id, after: { ...role, permissions: req.validatedBody.permissions } });
      sendData(res, { ...role, permissions: req.validatedBody.permissions }, { status: 201 });
    })
  );

  router.patch(
    '/roles/:id',
    requirePermission('roles.manage'),
    validate({ params: z.object({ id: idSchema }), body: roleSchema.partial() }),
    handler(async (req, res) => {
      const db = getDb();
      const role = await db('roles').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).first();
      if (!role) throw new NotFoundError('Role');
      if (role.is_system) throw new ValidationError('System roles cannot be edited. Duplicate it into a custom role instead.');

      const { permissions, ...rest } = req.validatedBody;
      if (Object.keys(rest).length > 0) await db('roles').where('id', role.id).update({ ...rest, updated_at: db.fn.now() });
      if (permissions) {
        const permissionIds = await db('permissions').whereIn('code', permissions).pluck('id');
        await db('role_permissions').where('role_id', role.id).delete();
        await db('role_permissions').insert(permissionIds.map((permissionId) => ({ role_id: role.id, permission_id: permissionId })));
      }
      const updated = await db('roles').where('id', role.id).first();
      await recordAudit({ ...auditFromRequest(req), action: 'role.updated', entityType: 'role', entityId: role.id, before: role, after: updated });
      sendData(res, updated);
    })
  );

  router.get(
    '/custom-fields',
    requirePermission('organization.read'),
    validate({ query: paginationSchema.extend({ entity_type: z.string().max(40).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      let query = db('custom_field_definitions').where('organization_id', req.actor.organizationId).whereNull('deleted_at');
      if (req.validatedQuery.entity_type) query = query.where('entity_type', req.validatedQuery.entity_type);
      const rows = await query.orderBy(['entity_type', 'position']);
      sendList(res, rows, { page: 1, perPage: rows.length, total: rows.length });
    })
  );

  router.post(
    '/custom-fields',
    requirePermission('custom_fields.manage'),
    validate({ body: customFieldSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const id = newId();
      await db('custom_field_definitions').insert({
        id,
        organization_id: req.actor.organizationId,
        ...req.validatedBody,
        label: JSON.stringify(req.validatedBody.label),
        options: req.validatedBody.options ? JSON.stringify(req.validatedBody.options) : null,
      });
      const field = await db('custom_field_definitions').where('id', id).first();
      await recordAudit({ ...auditFromRequest(req), action: 'custom_field.created', entityType: 'custom_field_definition', entityId: id, after: field });
      sendData(res, field, { status: 201 });
    })
  );

  router.delete(
    '/custom-fields/:id',
    requirePermission('custom_fields.manage'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const updated = await db('custom_field_definitions')
        .where({ id: req.validatedParams.id, organization_id: req.actor.organizationId })
        .update({ deleted_at: db.fn.now() });
      if (updated === 0) throw new NotFoundError('Custom field');
      sendNoContent(res);
    })
  );

  router.get(
    '/audit-logs',
    requirePermission('audit.read'),
    validate({ query: paginationSchema.extend({ entity_type: z.string().max(60).optional(), entity_id: idSchema.optional(), action: z.string().max(80).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      const { page, per_page: perPage, entity_type: entityType, entity_id: entityId, action } = req.validatedQuery;
      let query = db('audit_logs').where('organization_id', req.actor.organizationId);
      if (entityType) query = query.where('entity_type', entityType);
      if (entityId) query = query.where('entity_id', entityId);
      if (action) query = query.where('action', action);
      const [{ total }] = await query.clone().clearOrder().count({ total: 'id' });
      const rows = await query.orderBy('created_at', 'desc').limit(perPage).offset((page - 1) * perPage);
      sendList(res, rows, { page, perPage, total: Number(total) });
    })
  );

  // ---------- Data export and deletion requests ----------
  router.get(
    '/data-requests',
    requirePermission('data.delete'),
    validate({ query: paginationSchema }),
    handler(async (req, res) => {
      const rows = await getDb()('data_deletion_requests')
        .where('organization_id', req.actor.organizationId)
        .orderBy('created_at', 'desc')
        .limit(req.validatedQuery.per_page);
      sendList(res, rows, { page: req.validatedQuery.page, perPage: req.validatedQuery.per_page, total: rows.length });
    })
  );

  router.post(
    '/data-requests',
    requirePermission('data.delete'),
    validate({
      body: z.object({
        entity_type: z.enum(['contact', 'lead']),
        entity_id: idSchema,
        reason: z.string().max(500).optional(),
      }),
    }),
    handler(async (req, res) => {
      const db = getDb();
      const table = req.validatedBody.entity_type === 'contact' ? 'contacts' : 'leads';
      const record = await db(table)
        .where({ id: req.validatedBody.entity_id, organization_id: req.actor.organizationId })
        .whereNull('deleted_at')
        .first('id');
      if (!record) throw new NotFoundError(req.validatedBody.entity_type);

      const id = newId();
      await db('data_deletion_requests').insert({
        id,
        organization_id: req.actor.organizationId,
        entity_type: req.validatedBody.entity_type,
        entity_id: req.validatedBody.entity_id,
        reason: req.validatedBody.reason ?? null,
        status: 'pending',
        requested_by_membership_id: req.actor.membershipId,
      });
      await recordAudit({ ...auditFromRequest(req), action: 'data.deletion_requested', entityType: req.validatedBody.entity_type, entityId: req.validatedBody.entity_id, after: { request_id: id } });
      sendData(res, await db('data_deletion_requests').where('id', id).first(), { status: 201 });
    })
  );

  /**
   * Executing a deletion request anonymizes the identity and soft-deletes the record.
   * Financial, audit and commission history is deliberately preserved.
   */
  router.post(
    '/data-requests/:id/approve',
    requirePermission('data.delete'),
    validate({ params: z.object({ id: idSchema }), body: z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().max(500).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      const request = await db('data_deletion_requests')
        .where({ id: req.validatedParams.id, organization_id: req.actor.organizationId })
        .first();
      if (!request) throw new NotFoundError('Data request');
      if (request.status !== 'pending') throw new ValidationError('This request has already been decided');

      if (req.validatedBody.decision === 'rejected') {
        await db('data_deletion_requests').where('id', request.id).update({
          status: 'rejected',
          approved_by_membership_id: req.actor.membershipId,
          approved_at: db.fn.now(),
          result: JSON.stringify({ reason: req.validatedBody.reason ?? null }),
        });
        return sendData(res, await db('data_deletion_requests').where('id', request.id).first());
      }

      const result = await withTransaction(db, async (trx) => {
        if (request.entity_type === 'contact') {
          const identifiers = await trx('contact_identifiers')
            .where({ organization_id: req.actor.organizationId, contact_id: request.entity_id })
            .update({ value_raw: '[erased]', value_normalized: `erased:${request.entity_id}:${newId()}`, deleted_at: trx.fn.now() });
          await trx('contacts').where({ id: request.entity_id, organization_id: req.actor.organizationId }).update({
            display_name: 'Erased contact',
            first_name: null,
            last_name: null,
            company_name: null,
            summary: null,
            status: 'erased',
            do_not_contact: true,
            deleted_at: trx.fn.now(),
          });
          await trx('notes')
            .where({ organization_id: req.actor.organizationId, entity_type: 'contact', entity_id: request.entity_id })
            .update({ body: '[erased]', deleted_at: trx.fn.now() });
          return { identifiers_erased: identifiers };
        }

        await trx('leads').where({ id: request.entity_id, organization_id: req.actor.organizationId }).update({
          notes: null,
          provider_payload: null,
          deleted_at: trx.fn.now(),
        });
        return { lead_erased: true };
      });

      await db('data_deletion_requests').where('id', request.id).update({
        status: 'executed',
        approved_by_membership_id: req.actor.membershipId,
        approved_at: db.fn.now(),
        executed_at: db.fn.now(),
        result: JSON.stringify(result),
      });
      await recordAudit({ ...auditFromRequest(req), action: 'data.deletion_executed', entityType: request.entity_type, entityId: request.entity_id, after: result });
      sendData(res, await db('data_deletion_requests').where('id', request.id).first());
    })
  );

  router.get(
    '/default-roles',
    requirePermission('roles.read'),
    handler(async (req, res) => sendData(res, DEFAULT_ROLES.map(({ code, name, priority, modules }) => ({ code, name, priority, modules }))))
  );

  return router;
}
