#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import YAML from 'yaml';
import { createApp } from '../src/app.js';
import { collectRoutes } from '../src/openapi/routes.js';
import { buildOpenApiDocument } from '../src/openapi/document.js';

const app = createApp();
const routes = collectRoutes(app);
const document = buildOpenApiDocument({ routes, serverUrl: process.env.API_PUBLIC_URL ?? 'http://localhost:4000' });

const target = resolve(process.cwd(), process.argv[2] ?? '../../docs/api/openapi.yaml');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, YAML.stringify(document), 'utf8');

const operations = Object.values(document.paths).reduce((total, methods) => total + Object.keys(methods).length, 0);
console.log(`Wrote ${target} with ${Object.keys(document.paths).length} paths and ${operations} operations.`);
process.exit(0);
