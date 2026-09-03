/**
 * Vercel Function entry point. The same Express application runs locally through
 * `src/server.js` and on Vercel through this handler, so behaviour cannot drift.
 */
import { createApp } from '../src/app.js';

const app = createApp();

export default function handler(req, res) {
  return app(req, res);
}

export const config = { maxDuration: 60 };
