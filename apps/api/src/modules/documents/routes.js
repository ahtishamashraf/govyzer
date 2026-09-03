import { Router } from 'express';
import { z } from 'zod';
import { getDb, withTransaction } from '@govyzer/database';
import { newId, NotFoundError } from '@govyzer/domain';
import { documentTemplateSchema, documentGenerateSchema, idSchema, paginationSchema } from '@govyzer/validation';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth, requireOrganization, requirePermission } from '../../middleware/auth.js';
import { handler } from '../../core/async-handler.js';
import { sendData, sendList } from '../../core/responses.js';
import { createDownloadUrl, isStorageConfigured } from '../../core/storage.js';
import { renderTemplate } from './renderer.js';
import * as service from './service.js';

export function documentRoutes() {
  const router = Router();
  router.use(authenticate(), requireAuth(), requireOrganization());

  router.get(
    '/templates',
    requirePermission('documents.read'),
    handler(async (req, res) => {
      const db = getDb();
      const templates = await db('document_templates').where('organization_id', req.actor.organizationId).whereNull('deleted_at').orderBy('category');
      const versions = templates.length
        ? await db('document_template_versions').where('organization_id', req.actor.organizationId).whereIn('template_id', templates.map((template) => template.id)).orderBy('version_number', 'desc')
        : [];
      sendData(
        res,
        templates.map((template) => ({
          ...template,
          versions: versions.filter((version) => version.template_id === template.id).map(({ body_html: body, ...rest }) => rest),
          current_version: versions.find((version) => version.id === template.current_version_id) ?? null,
        }))
      );
    })
  );

  router.post(
    '/templates',
    requirePermission('documents.templates'),
    validate({ body: documentTemplateSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const templateId = newId();
      const versionId = newId();
      const { body_html: bodyHtml, variables, conditional_sections: sections, change_note: changeNote, ...template } = req.validatedBody;

      await withTransaction(db, async (trx) => {
        await trx('document_templates').insert({
          id: templateId,
          organization_id: req.actor.organizationId,
          ...template,
          current_version_id: versionId,
          is_sample: false,
          created_by: req.actor.membershipId,
        });
        await trx('document_template_versions').insert({
          id: versionId,
          organization_id: req.actor.organizationId,
          template_id: templateId,
          version_number: 1,
          body_html: bodyHtml ?? '',
          variables: JSON.stringify(variables ?? []),
          conditional_sections: sections ? JSON.stringify(sections) : null,
          status: 'draft',
          change_note: changeNote ?? 'initial version',
          created_by: req.actor.membershipId,
        });
      });
      sendData(res, await db('document_templates').where('id', templateId).first(), { status: 201 });
    })
  );

  router.post(
    '/templates/:id/versions',
    requirePermission('documents.templates'),
    validate({ params: z.object({ id: idSchema }), body: documentTemplateSchema.partial().extend({ body_html: z.string().max(500_000) }) }),
    handler(async (req, res) => {
      const db = getDb();
      const template = await db('document_templates').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).whereNull('deleted_at').first();
      if (!template) throw new NotFoundError('Document template');
      const [{ max_version: maxVersion }] = await db('document_template_versions').where('template_id', template.id).max({ max_version: 'version_number' });

      const versionId = newId();
      await db('document_template_versions').insert({
        id: versionId,
        organization_id: req.actor.organizationId,
        template_id: template.id,
        version_number: Number(maxVersion ?? 0) + 1,
        body_html: req.validatedBody.body_html,
        variables: JSON.stringify(req.validatedBody.variables ?? []),
        status: 'draft',
        change_note: req.validatedBody.change_note ?? null,
        created_by: req.actor.membershipId,
      });
      await db('document_templates').where('id', template.id).update({ current_version_id: versionId, updated_at: db.fn.now() });
      sendData(res, await db('document_template_versions').where('id', versionId).first(), { status: 201 });
    })
  );

  router.post(
    '/templates/versions/:id/approve',
    requirePermission('documents.templates'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const version = await db('document_template_versions').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).first();
      if (!version) throw new NotFoundError('Template version');
      await db('document_template_versions').where('id', version.id).update({
        status: 'approved',
        approved_by_membership_id: req.actor.membershipId,
        approved_at: db.fn.now(),
      });
      await db('document_templates').where('id', version.template_id).update({ is_sample: false, updated_at: db.fn.now() });
      sendData(res, await db('document_template_versions').where('id', version.id).first());
    })
  );

  router.post(
    '/templates/:id/preview',
    requirePermission('documents.read'),
    validate({ params: z.object({ id: idSchema }), body: z.object({ variables: z.record(z.string(), z.unknown()).default({}) }) }),
    handler(async (req, res) => {
      const db = getDb();
      const template = await db('document_templates').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).first();
      if (!template) throw new NotFoundError('Document template');
      const version = await db('document_template_versions').where('id', template.current_version_id).first();
      sendData(res, renderTemplate(version?.body_html ?? '', req.validatedBody.variables));
    })
  );

  router.get(
    '/',
    requirePermission('documents.read'),
    validate({ query: paginationSchema.extend({ entity_type: z.string().max(40).optional(), entity_id: idSchema.optional(), document_type: z.string().max(60).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      let query = db('generated_documents').where('organization_id', req.actor.organizationId).whereNull('deleted_at');
      if (req.validatedQuery.entity_type) query = query.where('entity_type', req.validatedQuery.entity_type);
      if (req.validatedQuery.entity_id) query = query.where('entity_id', req.validatedQuery.entity_id);
      if (req.validatedQuery.document_type) query = query.where('document_type', req.validatedQuery.document_type);
      const rows = await query.orderBy('created_at', 'desc').limit(req.validatedQuery.per_page);
      sendList(res, rows, { page: req.validatedQuery.page, perPage: req.validatedQuery.per_page, total: rows.length });
    })
  );

  router.post(
    '/generate',
    requirePermission('documents.generate'),
    validate({ body: documentGenerateSchema }),
    handler(async (req, res) => {
      sendData(res, await service.generateDocument({ organizationId: req.actor.organizationId, actor: req.actor, payload: req.validatedBody }), { status: 201 });
    })
  );

  router.get(
    '/:id/download',
    requirePermission('documents.read'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const document = await db('generated_documents').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).whereNull('deleted_at').first();
      if (!document) throw new NotFoundError('Document');
      if (!document.storage_key || !isStorageConfigured()) {
        return sendData(res, { download_url: null, reason: 'This document was generated before file storage was configured.' });
      }
      sendData(res, { download_url: await createDownloadUrl(document.storage_key, { fileName: `${document.reference}.pdf` }), expires_in: 900 });
    })
  );

  router.post(
    '/:id/signature',
    requirePermission('documents.generate'),
    validate({
      params: z.object({ id: idSchema }),
      body: z.object({
        provider: z.enum(['manual', 'docusign']).default('manual'),
        signers: z.array(z.object({ name: z.string().max(180), email: z.string().email() })).default([]),
      }),
    }),
    handler(async (req, res) => {
      const db = getDb();
      const document = await db('generated_documents').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).first();
      if (!document) throw new NotFoundError('Document');

      const id = newId();
      await db('signature_requests').insert({
        id,
        organization_id: req.actor.organizationId,
        document_id: document.id,
        provider: req.validatedBody.provider,
        status: 'pending',
        signers: JSON.stringify(req.validatedBody.signers),
        sent_at: db.fn.now(),
      });
      await db('generated_documents').where('id', document.id).update({ signature_status: 'pending', updated_at: db.fn.now() });
      sendData(res, await db('signature_requests').where('id', id).first(), { status: 201 });
    })
  );

  return router;
}
