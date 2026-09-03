import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '@govyzer/database';
import { newId, NotFoundError, ValidationError } from '@govyzer/domain';
import { mediaUploadSchema, mediaReorderSchema, idSchema } from '@govyzer/validation';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth, requireOrganization, requirePermission } from '../../middleware/auth.js';
import { handler } from '../../core/async-handler.js';
import { sendData, sendNoContent } from '../../core/responses.js';
import { validateUpload, buildStorageKey, createUploadUrl, createDownloadUrl, deleteObject, isStorageConfigured } from '../../core/storage.js';
import { recordAudit, auditFromRequest } from '../../core/audit.js';

export function mediaRoutes() {
  const router = Router();
  router.use(authenticate(), requireAuth(), requireOrganization());

  /** Step 1: the client asks for a short-lived presigned PUT URL. */
  router.post(
    '/uploads',
    requirePermission('listings.manage_media'),
    validate({ body: mediaUploadSchema }),
    handler(async (req, res) => {
      if (!isStorageConfigured()) {
        throw new ValidationError('File storage is not configured for this deployment. Set S3_BUCKET and the S3 credentials.');
      }
      const payload = req.validatedBody;
      validateUpload(payload);

      const db = getDb();
      const key = buildStorageKey({
        organizationId: req.actor.organizationId,
        entityType: payload.entity_type,
        entityId: payload.entity_id,
        fileName: payload.file_name,
      });
      const upload = await createUploadUrl({ key, mimeType: payload.mime_type, sizeBytes: payload.size_bytes });

      const id = newId();
      await db('media_assets').insert({
        id,
        organization_id: req.actor.organizationId,
        entity_type: payload.entity_type,
        entity_id: payload.entity_id,
        asset_type: payload.asset_type,
        storage_key: key,
        file_name: payload.file_name,
        mime_type: payload.mime_type,
        size_bytes: payload.size_bytes,
        checksum: payload.checksum ?? null,
        status: 'pending_upload',
        position: 999,
        created_by: req.actor.membershipId,
        updated_by: req.actor.membershipId,
      });
      sendData(res, { media_asset_id: id, storage_key: key, upload }, { status: 201 });
    })
  );

  /** Step 2: the client confirms the upload finished so the asset becomes visible. */
  router.post(
    '/uploads/:id/complete',
    requirePermission('listings.manage_media'),
    validate({ params: z.object({ id: idSchema }), body: z.object({ position: z.coerce.number().int().min(0).optional(), is_primary: z.boolean().optional(), caption: z.string().max(300).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      const asset = await db('media_assets').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).whereNull('deleted_at').first();
      if (!asset) throw new NotFoundError('Media asset');

      const updates = { status: 'ready', updated_at: db.fn.now(), updated_by: req.actor.membershipId };
      if (req.validatedBody.position != null) updates.position = req.validatedBody.position;
      if (req.validatedBody.caption) updates.caption = req.validatedBody.caption;
      if (req.validatedBody.is_primary) {
        await db('media_assets')
          .where({ organization_id: req.actor.organizationId, entity_type: asset.entity_type, entity_id: asset.entity_id })
          .update({ is_primary: false });
        updates.is_primary = true;
      }
      await db('media_assets').where('id', asset.id).update(updates);
      sendData(res, await db('media_assets').where('id', asset.id).first());
    })
  );

  router.get(
    '/',
    requirePermission('listings.read'),
    validate({ query: z.object({ entity_type: z.string().max(30), entity_id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const rows = await db('media_assets')
        .where({
          organization_id: req.actor.organizationId,
          entity_type: req.validatedQuery.entity_type,
          entity_id: req.validatedQuery.entity_id,
        })
        .whereNull('deleted_at')
        .orderBy('position');

      const withUrls = [];
      for (const row of rows) {
        withUrls.push({ ...row, url: isStorageConfigured() ? await createDownloadUrl(row.storage_key, { expiresIn: 900 }) : null });
      }
      sendData(res, withUrls);
    })
  );

  router.post(
    '/reorder',
    requirePermission('listings.manage_media'),
    validate({ body: mediaReorderSchema }),
    handler(async (req, res) => {
      const db = getDb();
      for (const item of req.validatedBody.items) {
        await db('media_assets')
          .where({ id: item.id, organization_id: req.actor.organizationId })
          .update({ position: item.position, ...(item.is_primary != null ? { is_primary: item.is_primary } : {}), updated_at: db.fn.now() });
      }
      sendData(res, { updated: req.validatedBody.items.length });
    })
  );

  router.delete(
    '/:id',
    requirePermission('listings.manage_media'),
    validate({ params: z.object({ id: idSchema }) }),
    handler(async (req, res) => {
      const db = getDb();
      const asset = await db('media_assets').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).whereNull('deleted_at').first();
      if (!asset) return sendNoContent(res);
      await db('media_assets').where('id', asset.id).update({ deleted_at: db.fn.now(), updated_by: req.actor.membershipId });
      if (isStorageConfigured()) await deleteObject(asset.storage_key).catch(() => {});
      await recordAudit({ ...auditFromRequest(req), action: 'media.deleted', entityType: 'media_asset', entityId: asset.id, before: asset });
      sendNoContent(res);
    })
  );

  return router;
}
