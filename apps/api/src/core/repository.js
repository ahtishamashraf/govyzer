import { getDb } from '@govyzer/database';
import { newId, NotFoundError, ConflictError } from '@govyzer/domain';

/**
 * Repository factory. Every method requires an organization id and applies it to the
 * query, so a missing tenant filter is a programming error that fails loudly rather than
 * a silent cross-tenant read.
 */
export function createRepository(table, { softDelete = true, tenantColumn = 'organization_id', versioned = false } = {}) {
  function requireTenant(organizationId) {
    if (!organizationId) {
      throw new Error(`Repository ${table} was called without an organization id`);
    }
    return organizationId;
  }

  function base(organizationId, trx) {
    const db = trx ?? getDb();
    const query = db(table).where(`${table}.${tenantColumn}`, requireTenant(organizationId));
    return softDelete ? query.whereNull(`${table}.deleted_at`) : query;
  }

  return {
    table,
    softDelete,
    query: base,
    raw: (trx) => (trx ?? getDb())(table),

    async findById(organizationId, id, { trx, columns = '*' } = {}) {
      if (!id) return null;
      const row = await base(organizationId, trx).where(`${table}.id`, id).first(columns);
      return row ?? null;
    },

    async findByIdOrFail(organizationId, id, options = {}) {
      const row = await this.findById(organizationId, id, options);
      if (!row) throw new NotFoundError(table.replace(/_/g, ' '));
      return row;
    },

    async findOne(organizationId, where, { trx } = {}) {
      const row = await base(organizationId, trx).where(where).first();
      return row ?? null;
    },

    async findMany(organizationId, where = {}, { trx, limit = 200, orderBy = 'created_at', direction = 'desc' } = {}) {
      return base(organizationId, trx).where(where).orderBy(orderBy, direction).limit(limit);
    },

    async insert(organizationId, values, { trx, actorMembershipId = null } = {}) {
      const db = trx ?? getDb();
      const id = values.id ?? newId();
      const row = {
        id,
        [tenantColumn]: requireTenant(organizationId),
        ...values,
      };
      if (actorMembershipId && 'created_by' in row === false) {
        row.created_by = actorMembershipId;
        row.updated_by = actorMembershipId;
      }
      await db(table).insert(row);
      return this.findById(organizationId, id, { trx });
    },

    async insertMany(organizationId, rows, { trx, chunkSize = 200 } = {}) {
      const db = trx ?? getDb();
      const prepared = rows.map((values) => ({
        id: values.id ?? newId(),
        [tenantColumn]: requireTenant(organizationId),
        ...values,
      }));
      for (let index = 0; index < prepared.length; index += chunkSize) {
        await db(table).insert(prepared.slice(index, index + chunkSize));
      }
      return prepared.map((row) => row.id);
    },

    /**
     * Updates a row. When the table carries a `version` column an expected version can be
     * supplied for optimistic concurrency; a mismatch raises a conflict instead of
     * silently overwriting another user's edit.
     */
    async update(organizationId, id, values, { trx, expectedVersion = null, actorMembershipId = null } = {}) {
      const db = trx ?? getDb();
      const payload = { ...values, updated_at: db.fn.now() };
      if (actorMembershipId) payload.updated_by = actorMembershipId;

      let query = db(table)
        .where(`${table}.${tenantColumn}`, requireTenant(organizationId))
        .where(`${table}.id`, id);
      if (softDelete) query = query.whereNull(`${table}.deleted_at`);

      if (versioned) {
        if (expectedVersion != null) query = query.where(`${table}.version`, expectedVersion);
        payload.version = db.raw('`version` + 1');
      }

      const updated = await query.update(payload);
      if (updated === 0) {
        const exists = await this.findById(organizationId, id, { trx });
        if (exists && versioned && expectedVersion != null) {
          throw new ConflictError('This record was changed by someone else. Reload and try again.', {
            expected_version: expectedVersion,
            current_version: exists.version,
          });
        }
        throw new NotFoundError(table.replace(/_/g, ' '));
      }
      return this.findById(organizationId, id, { trx });
    },

    async softDeleteById(organizationId, id, { trx, actorMembershipId = null } = {}) {
      if (!softDelete) return this.hardDelete(organizationId, id, { trx });
      const db = trx ?? getDb();
      const payload = { deleted_at: db.fn.now() };
      if (actorMembershipId) payload.updated_by = actorMembershipId;
      const deleted = await db(table)
        .where(`${table}.${tenantColumn}`, requireTenant(organizationId))
        .where(`${table}.id`, id)
        .whereNull(`${table}.deleted_at`)
        .update(payload);
      if (deleted === 0) throw new NotFoundError(table.replace(/_/g, ' '));
      return true;
    },

    async hardDelete(organizationId, id, { trx } = {}) {
      const db = trx ?? getDb();
      await db(table)
        .where(`${table}.${tenantColumn}`, requireTenant(organizationId))
        .where(`${table}.id`, id)
        .delete();
      return true;
    },

    async count(organizationId, where = {}, { trx } = {}) {
      const [row] = await base(organizationId, trx).where(where).count({ total: '*' });
      return Number(row.total ?? 0);
    },

    /** Offset pagination for tables, always constrained to the tenant. */
    async paginate(organizationId, { where = {}, page = 1, perPage = 25, orderBy = 'created_at', direction = 'desc', modify = null, trx, columns = null } = {}) {
      const buildQuery = () => {
        let query = base(organizationId, trx).where(where);
        if (modify) query = modify(query) ?? query;
        return query;
      };
      const [{ total }] = await buildQuery().clearSelect().clearOrder().count({ total: `${table}.id` });
      const rows = await buildQuery()
        .select(columns ?? `${table}.*`)
        .orderBy(`${table}.${orderBy}`, direction)
        .limit(perPage)
        .offset((page - 1) * perPage);
      return { rows, total: Number(total ?? 0), page, perPage };
    },
  };
}

/**
 * Applies the actor's record scope to a query. Called by every list endpoint that returns
 * records owned by individual members.
 */
export function applyRecordScope(query, actor, { table, assignedColumn = null, ownerColumn = 'created_by', teamColumn = 'team_id', branchColumn = 'branch_id' } = {}) {
  if (actor?.isPlatformAdmin) return query;
  const scope = actor?.recordScope ?? 'own';
  const column = (name) => (table ? `${table}.${name}` : name);

  switch (scope) {
    case 'organization':
      return query;
    case 'branch':
      return actor.branchId ? query.where(column(branchColumn), actor.branchId) : query;
    case 'team':
      return query.where((builder) => {
        if (actor.teamId) builder.orWhere(column(teamColumn), actor.teamId);
        if (assignedColumn) builder.orWhere(column(assignedColumn), actor.membershipId);
        builder.orWhere(column(ownerColumn), actor.membershipId);
      });
    case 'assigned':
      return query.where((builder) => {
        if (assignedColumn) builder.orWhere(column(assignedColumn), actor.membershipId);
        builder.orWhere(column(ownerColumn), actor.membershipId);
      });
    case 'own':
    default:
      return query.where(column(ownerColumn), actor.membershipId);
  }
}
