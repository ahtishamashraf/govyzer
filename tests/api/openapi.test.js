import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { getApp } from '../helpers/api.js';
import { collectRoutes } from '../../apps/api/src/openapi/routes.js';
import { buildOpenApiDocument } from '../../apps/api/src/openapi/document.js';

/** The committed document must describe exactly the routes the API actually exposes. */
describe('OpenAPI document', () => {
  const routes = collectRoutes(getApp());
  const generated = buildOpenApiDocument({ routes });
  const committed = YAML.parse(readFileSync(new URL('../../docs/api/openapi.yaml', import.meta.url), 'utf8'));

  it('is OpenAPI 3.1 with servers, tags and security schemes', () => {
    expect(committed.openapi).toBe('3.1.0');
    expect(committed.servers.length).toBeGreaterThan(0);
    expect(Object.keys(committed.components.securitySchemes)).toEqual(
      expect.arrayContaining(['bearerAuth', 'cookieAuth', 'apiKey', 'displayToken', 'cronSecret'])
    );
  });

  it('documents every live route', () => {
    const live = new Set(routes.map((route) => `${route.method} ${route.path.replace(/:([A-Za-z_]+)/g, '{$1}')}`));
    const documented = new Set(
      Object.entries(committed.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`))
    );
    const missing = [...live].filter((route) => !documented.has(route));
    expect(missing).toEqual([]);
  });

  it('does not document routes that no longer exist', () => {
    const live = new Set(routes.map((route) => `${route.method} ${route.path.replace(/:([A-Za-z_]+)/g, '{$1}')}`));
    const documented = Object.entries(committed.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`));
    const stale = documented.filter((route) => !live.has(route));
    expect(stale).toEqual([]);
  });

  it('covers every module with a tag', () => {
    const tags = committed.tags.map((tag) => tag.name);
    expect(tags).toEqual(expect.arrayContaining(['auth', 'leads', 'listings', 'offplan', 'deals', 'sales-screen', 'display', 'public', 'cron']));
  });

  it('includes request examples for the flows integrators start with', () => {
    expect(generated.paths['/v1/leads'].post.requestBody.content['application/json'].example.contact).toBeTruthy();
    expect(generated.paths['/v1/public/leads'].post.requestBody.content['application/json'].example.external_id).toBeTruthy();
    expect(generated.paths['/v1/display/pair'].post.requestBody.content['application/json'].example.code).toBeTruthy();
  });
});
