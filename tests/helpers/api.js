import request from 'supertest';
import { createApp } from '../../apps/api/src/app.js';

let app = null;

export function getApp() {
  if (!app) app = createApp();
  return app;
}

/** Signs in and returns an agent-like helper that carries the bearer token. */
export async function signIn({ email, password }) {
  const response = await request(getApp()).post('/v1/auth/login').send({ email, password });
  if (response.status !== 200) {
    throw new Error(`Sign in failed for ${email}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  const token = response.body.data.access_token;
  return {
    token,
    body: response.body.data,
    get: (path) => request(getApp()).get(path).set('authorization', `Bearer ${token}`),
    post: (path) => request(getApp()).post(path).set('authorization', `Bearer ${token}`),
    patch: (path) => request(getApp()).patch(path).set('authorization', `Bearer ${token}`),
    delete: (path) => request(getApp()).delete(path).set('authorization', `Bearer ${token}`),
  };
}

export function anonymous() {
  return request(getApp());
}
