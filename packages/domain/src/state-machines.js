import { ConflictError } from './errors.js';

function machine(name, transitions, terminal = []) {
  return {
    name,
    states: Object.keys(transitions),
    terminal,
    next(state) {
      return transitions[state] ?? [];
    },
    can(from, to) {
      if (from === to) return true;
      return (transitions[from] ?? []).includes(to);
    },
    assert(from, to) {
      if (!this.can(from, to)) {
        throw new ConflictError(`Invalid ${name} transition: ${from} -> ${to}`, {
          from,
          to,
          allowed: transitions[from] ?? [],
        });
      }
      return true;
    },
  };
}

export const listingStateMachine = machine(
  'listing',
  {
    draft: ['internal_review', 'approved', 'archived', 'withdrawn'],
    internal_review: ['approved', 'rejected', 'draft', 'withdrawn'],
    rejected: ['draft', 'internal_review', 'archived'],
    approved: ['publishing', 'published', 'unpublished', 'withdrawn', 'draft', 'expired'],
    publishing: ['published', 'partially_published', 'approved', 'rejected'],
    published: ['partially_published', 'unpublished', 'expired', 'withdrawn'],
    partially_published: ['published', 'unpublished', 'expired', 'withdrawn'],
    unpublished: ['approved', 'publishing', 'archived', 'draft'],
    expired: ['draft', 'approved', 'archived'],
    withdrawn: ['draft', 'archived'],
    archived: [],
  },
  ['archived']
);

export const publicationStateMachine = machine('portal_publication', {
  pending: ['validating', 'queued', 'failed', 'rejected'],
  validating: ['queued', 'failed', 'rejected'],
  queued: ['publishing', 'failed'],
  publishing: ['published', 'failed', 'rejected'],
  published: ['publishing', 'unpublishing', 'failed'],
  failed: ['queued', 'validating', 'unpublished'],
  rejected: ['validating', 'queued', 'unpublished'],
  unpublishing: ['unpublished', 'failed'],
  unpublished: ['queued', 'validating'],
});

export const unitStockMachine = machine('unit_stock', {
  draft: ['unreleased', 'available', 'withdrawn'],
  unreleased: ['available', 'blocked', 'withdrawn'],
  available: ['on_hold', 'reserved', 'blocked', 'unavailable', 'withdrawn'],
  blocked: ['available', 'withdrawn', 'unavailable'],
  on_hold: ['available', 'reserved', 'blocked', 'cancelled'],
  reserved: ['booked', 'available', 'cancelled', 'sold'],
  booked: ['sold', 'cancelled', 'available'],
  sold: ['cancelled'],
  cancelled: ['available', 'withdrawn'],
  withdrawn: ['available', 'draft'],
  unavailable: ['available', 'withdrawn'],
});

/** Statuses from which a unit may still be acquired by a new reservation. */
export const RESERVABLE_UNIT_STATUSES = Object.freeze(['available', 'on_hold']);

export const reservationStateMachine = machine('reservation', {
  pending: ['confirmed', 'extended', 'expired', 'cancelled'],
  confirmed: ['extended', 'converted', 'cancelled', 'expired'],
  extended: ['confirmed', 'converted', 'cancelled', 'expired'],
  expired: ['cancelled'],
  cancelled: [],
  converted: ['cancelled'],
});

export const dealStateMachine = machine('deal', {
  draft: ['documentation', 'approval', 'lost', 'cancelled'],
  documentation: ['approval', 'signed', 'lost', 'cancelled'],
  approval: ['signed', 'documentation', 'lost', 'cancelled'],
  signed: ['won', 'cancelled', 'lost'],
  won: ['cancelled'],
  lost: ['draft'],
  cancelled: [],
});

/**
 * Lead stages are tenant configurable, so the machine is derived from the tenant's stage
 * definitions: any open stage may move to any other stage, closed stages may only reopen.
 */
export function buildLeadStageMachine(stageDefinitions) {
  const codes = stageDefinitions.map((stage) => stage.code);
  const openCodes = stageDefinitions
    .filter((stage) => stage.category === 'open')
    .map((stage) => stage.code);

  return {
    name: 'lead_stage',
    states: codes,
    can(from, to) {
      if (!codes.includes(to)) return false;
      if (from === to) return true;
      const fromStage = stageDefinitions.find((stage) => stage.code === from);
      if (!fromStage) return true;
      if (fromStage.category === 'open') return true;
      return openCodes.includes(to);
    },
    assert(from, to) {
      if (!this.can(from, to)) {
        throw new ConflictError(`Invalid lead stage transition: ${from} -> ${to}`, { from, to });
      }
      return true;
    },
  };
}
