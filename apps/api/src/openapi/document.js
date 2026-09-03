import { PERMISSIONS } from '@govyzer/domain';

const jsonResponse = (description, schema = { type: 'object' }) => ({
  description,
  content: { 'application/json': { schema } },
});

const errorResponse = (description) =>
  jsonResponse(description, {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          details: { type: 'array', nullable: true, items: { type: 'object' } },
        },
        required: ['code', 'message'],
      },
      request_id: { type: 'string', nullable: true },
    },
  });

const dataEnvelope = (schema) => ({
  type: 'object',
  properties: { data: schema, request_id: { type: 'string', nullable: true } },
  required: ['data'],
});

const listEnvelope = (itemSchema) => ({
  type: 'object',
  properties: {
    data: { type: 'array', items: itemSchema },
    meta: {
      type: 'object',
      properties: {
        page: { type: 'integer', nullable: true },
        per_page: { type: 'integer' },
        total: { type: 'integer', nullable: true },
        total_pages: { type: 'integer', nullable: true },
        cursor: { type: 'string', nullable: true },
        next_cursor: { type: 'string', nullable: true },
      },
    },
  },
});

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
  description: 'ULID identifier',
};

const paginationParams = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'per_page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 } },
  { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Free text search' },
];

const idempotencyHeader = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  schema: { type: 'string', maxLength: 190 },
  description: 'Replaying the same key with the same body returns the original response.',
};

/**
 * Builds the OpenAPI 3.1 document. `routes` comes from the live Express router, so a route
 * that exists without documentation (or documentation without a route) is a build failure.
 */
export function buildOpenApiDocument({ routes = [], version = '1.0.0', serverUrl = 'http://localhost:4000' } = {}) {
  const paths = {};

  const add = (path, method, operation) => {
    const openapiPath = path.replace(/:([A-Za-z_]+)/g, '{$1}');
    paths[openapiPath] = paths[openapiPath] ?? {};
    paths[openapiPath][method.toLowerCase()] = operation;
  };

  for (const route of routes) {
    const documented = DOCUMENTED[`${route.method} ${route.path}`];
    const tag = route.path.split('/')[2] ?? 'platform';
    const operation = documented ?? {
      summary: `${route.method} ${route.path}`,
      tags: [tag],
      responses: {
        200: jsonResponse('Successful response', dataEnvelope({ type: 'object' })),
        401: errorResponse('Authentication is required'),
        403: errorResponse('The actor lacks the permission or module entitlement'),
        404: errorResponse('Not found within this organization'),
        422: errorResponse('Validation failed'),
        429: errorResponse('Rate limited'),
      },
      parameters: route.path.includes(':id') ? [idParam] : undefined,
      security: route.path.startsWith('/v1/public') || route.path.startsWith('/v1/webhooks') ? [{ apiKey: [] }] : [{ bearerAuth: [] }, { cookieAuth: [] }],
    };
    add(route.path, route.method, operation);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Govyzer API',
      version,
      description:
        'Multi-tenant real estate CRM API. Every endpoint is scoped to one organization; ' +
        'authorization combines a module entitlement, a permission and a record scope.',
      contact: { name: 'Govyzer platform team' },
    },
    servers: [{ url: serverUrl, description: 'API server' }],
    tags: [
      { name: 'auth', description: 'Registration, sessions, invitations and profile' },
      { name: 'organization', description: 'Organization settings, branding, domains, roles and audit' },
      { name: 'users', description: 'Memberships, hierarchy and module access' },
      { name: 'contacts', description: 'Contacts, identifiers, roles and timelines' },
      { name: 'leads', description: 'Leads, requirements, assignment, pool and SLA' },
      { name: 'activities', description: 'Notes, tasks, meetings, viewings and notifications' },
      { name: 'listings', description: 'Ready listings, approvals and publication' },
      { name: 'portals', description: 'Portal accounts, mappings, publications and errors' },
      { name: 'offplan', description: 'Developers, projects, stock, holds, reservations and bookings' },
      { name: 'deals', description: 'Deals, offers and commission plans' },
      { name: 'documents', description: 'Templates, versions, generation and signatures' },
      { name: 'finance', description: 'Invoices, payments, receipts and commission lines' },
      { name: 'workflows', description: 'Automation definitions, versions and runs' },
      { name: 'integrations', description: 'Connections, API keys and outbound webhooks' },
      { name: 'ai', description: 'AI assistance with structured outputs and usage tracking' },
      { name: 'reports', description: 'Dashboards, reports and exports' },
      { name: 'sales-screen', description: 'Displays, playlists, events, points and targets' },
      { name: 'display', description: 'Display-scoped pairing, feed and heartbeat' },
      { name: 'webhooks', description: 'Inbound provider webhooks' },
      { name: 'public', description: 'Tenant API-key surface: feeds and lead intake' },
      { name: 'cron', description: 'Authenticated scheduled job endpoints' },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Short-lived access token' },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'gvz_at', description: 'Session cookie issued by the API; state-changing requests also need the x-csrf-token header' },
        apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'Tenant API key with explicit scopes' },
        displayToken: { type: 'apiKey', in: 'header', name: 'x-display-token', description: 'Display-scoped token, read-only against the approved feed' },
        cronSecret: { type: 'apiKey', in: 'header', name: 'x-cron-secret', description: 'Shared secret for scheduled invocations' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
            request_id: { type: 'string' },
          },
        },
        Permission: { type: 'string', enum: PERMISSIONS.map(([code]) => code) },
      },
    },
  };
}

/** Hand written operations for the endpoints worth documenting in detail. */
const DOCUMENTED = {
  'POST /v1/auth/register': {
    summary: 'Register an organization and its owner',
    tags: ['auth'],
    security: [],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['organization_name', 'organization_slug', 'first_name', 'last_name', 'email', 'password'],
            properties: {
              organization_name: { type: 'string', maxLength: 180 },
              organization_slug: { type: 'string', pattern: '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$' },
              first_name: { type: 'string' },
              last_name: { type: 'string' },
              email: { type: 'string', format: 'email' },
              password: { type: 'string', minLength: 12 },
              modules: { type: 'array', items: { type: 'string', enum: ['ready', 'offplan', 'sales_screen'] } },
            },
          },
          example: {
            organization_name: 'Luxora Properties',
            organization_slug: 'luxora-properties',
            first_name: 'Amira',
            last_name: 'Haddad',
            email: 'amira@luxora.ae',
            password: 'AStrongPassphrase!2026',
            modules: ['ready', 'offplan', 'sales_screen'],
          },
        },
      },
    },
    responses: {
      201: jsonResponse('The organization, owner membership and session', dataEnvelope({ type: 'object' })),
      409: errorResponse('An account with this email already exists'),
      422: errorResponse('Validation failed'),
    },
  },

  'POST /v1/auth/login': {
    summary: 'Sign in and receive a rotating session',
    tags: ['auth'],
    security: [],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' }, organization_id: { type: 'string' } } },
          example: { email: 'amira@luxora.ae', password: 'AStrongPassphrase!2026' },
        },
      },
    },
    responses: {
      200: jsonResponse('Actor, permissions and access token', dataEnvelope({ type: 'object' })),
      401: errorResponse('Email address or password is incorrect'),
    },
  },

  'POST /v1/leads': {
    summary: 'Create a lead, deduplicating the contact identity',
    description:
      'A repeat mobile number or email never discards the enquiry: the contact is matched and a new lead is attached to it.',
    tags: ['leads'],
    parameters: [idempotencyHeader],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          example: {
            module: 'ready',
            purpose: 'buy',
            source_code: 'property_finder',
            estimated_value: 2500000,
            contact: {
              first_name: 'Omar',
              last_name: 'Al Habtoor',
              identifiers: [
                { identifier_type: 'phone', value: '0501112233', is_primary: true },
                { identifier_type: 'email', value: 'omar@example.ae' },
              ],
            },
            requirements: [{ purpose: 'buy', module: 'ready', bedrooms_min: 2, budget_max: 2600000, property_types: ['apartment'] }],
          },
        },
      },
    },
    responses: {
      201: jsonResponse('The created lead, its contact and whether the contact was deduplicated', dataEnvelope({ type: 'object' })),
      409: errorResponse('The idempotency key was reused with a different body'),
      422: errorResponse('Validation failed'),
    },
  },

  'GET /v1/leads': {
    summary: 'List leads within the caller record scope',
    tags: ['leads'],
    parameters: [
      ...paginationParams,
      { name: 'module', in: 'query', schema: { type: 'string', enum: ['ready', 'offplan'] } },
      { name: 'stage_code', in: 'query', schema: { type: 'string' } },
      { name: 'assigned_membership_id', in: 'query', schema: { type: 'string' } },
      { name: 'in_pool', in: 'query', schema: { type: 'boolean' } },
    ],
    responses: { 200: jsonResponse('A page of leads', listEnvelope({ type: 'object' })) },
  },

  'POST /v1/listings/:id/publish': {
    summary: 'Validate and publish a listing to the selected portals',
    description: 'Validation runs per portal first; only listings that pass are queued for publication.',
    tags: ['listings'],
    parameters: [idParam, idempotencyHeader],
    requestBody: {
      required: true,
      content: { 'application/json': { example: { portal_account_ids: ['01J8ZC9K7Q0R4TQ2N4M9V6X1AB'], validate_only: false } } },
    },
    responses: {
      200: jsonResponse('Per portal validation results and the queued publications'),
      409: errorResponse('Only an approved listing can be published'),
    },
  },

  'POST /v1/offplan/reservations': {
    summary: 'Reserve a unit atomically',
    description:
      'The unit row is locked and its status is flipped with a conditional update, so two agents reserving the same unit can never both succeed.',
    tags: ['offplan'],
    parameters: [idempotencyHeader],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          example: {
            unit_id: '01J8ZC9K7Q0R4TQ2N4M9V6X1AB',
            contact_id: '01J8ZC9K7Q0R4TQ2N4M9V6X1CD',
            lead_id: '01J8ZC9K7Q0R4TQ2N4M9V6X1EF',
            unit_price: 2350000,
            reservation_amount: 50000,
            expires_in_hours: 72,
          },
        },
      },
    },
    responses: {
      201: jsonResponse('The reservation'),
      409: errorResponse('The unit is not available, is held by another agent, or was taken moments ago'),
    },
  },

  'POST /v1/deals/:id/stage': {
    summary: 'Move a deal through its lifecycle',
    description: 'Winning a deal snapshots the commission split immutably and emits the events the Sales Screen consumes.',
    tags: ['deals'],
    parameters: [idParam],
    requestBody: { required: true, content: { 'application/json': { example: { stage: 'won', reason: 'Contract signed' } } } },
    responses: {
      200: jsonResponse('The deal and, when won, its commission snapshot'),
      403: errorResponse('deals.win is required to win a deal'),
      409: errorResponse('Invalid stage transition'),
    },
  },

  'POST /v1/public/leads': {
    summary: 'Create a lead from an external system (Zapier action)',
    tags: ['public'],
    security: [{ apiKey: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          example: { external_id: 'zap-1024', name: 'Sara Nasser', phone: '0509998877', email: 'sara@example.ae', source: 'zapier', property_reference: 'LUX-LS-2601-000042', message: 'Requesting a viewing this week' },
        },
      },
    },
    responses: {
      201: jsonResponse('The created lead identifiers'),
      200: jsonResponse('The previously created lead when the external id repeats'),
      403: errorResponse('The API key lacks the leads.create scope'),
    },
  },

  'POST /v1/display/pair': {
    summary: 'Exchange a one-time pairing code for a display-scoped session',
    tags: ['display'],
    security: [],
    requestBody: { required: true, content: { 'application/json': { example: { code: 'K7QM3XZ9', app_version: '1.0.0' } } } },
    responses: {
      201: jsonResponse('A revocable display token and poll interval'),
      401: errorResponse('The code is invalid or expired'),
      409: errorResponse('The code was already used'),
    },
  },

  'GET /v1/display/feed': {
    summary: 'Read the approved presentation feed for this display',
    description: 'Supports ETags: an unchanged feed returns 304 so a television can poll every few seconds cheaply.',
    tags: ['display'],
    security: [{ displayToken: [] }],
    responses: {
      200: jsonResponse('Slides, metrics, leaderboards and approved events with no client PII'),
      304: { description: 'The feed has not changed' },
      401: errorResponse('The display session was revoked'),
    },
  },

  'POST /v1/cron/jobs': {
    summary: 'Process one bounded batch of queued jobs',
    tags: ['cron'],
    security: [{ cronSecret: [] }],
    responses: { 200: jsonResponse('Claimed, completed, failed and skipped counts'), 401: errorResponse('Invalid cron secret') },
  },
};

export { DOCUMENTED as DOCUMENTED_OPERATIONS };
