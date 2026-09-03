'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const BASE = '/api/bff';

function readCsrfToken() {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((entry) => entry.startsWith('gvz_csrf='));
  return match ? decodeURIComponent(match.split('=')[1]) : null;
}

export class ApiError extends Error {
  constructor(message, { status, code, details, requestId } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

/** Single entry point for browser → API calls. Always same-origin, always with cookies. */
export async function apiFetch(path, { method = 'GET', body, headers = {}, signal, raw = false } = {}) {
  const csrf = readCsrfToken();
  const response = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    signal,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) return null;
  if (raw) return response;

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(payload?.error?.message ?? `Request failed with ${response.status}`, {
      status: response.status,
      code: payload?.error?.code,
      details: payload?.error?.details,
      requestId: payload?.request_id,
    });
  }
  return payload;
}

/** Refreshes the session once when an access token has expired, then retries. */
export async function apiFetchWithRefresh(path, options) {
  try {
    return await apiFetch(path, options);
  } catch (error) {
    if (error.status !== 401) throw error;
    await apiFetch('/v1/auth/refresh', { method: 'POST' });
    return apiFetch(path, options);
  }
}

export function useApi(path, { enabled = true, deps = [] } = {}) {
  const [state, setState] = useState({ data: null, meta: null, loading: enabled, error: null });
  const controller = useRef(null);

  const load = useCallback(async () => {
    if (!enabled || !path) {
      setState({ data: null, meta: null, loading: false, error: null });
      return;
    }
    controller.current?.abort();
    controller.current = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const payload = await apiFetchWithRefresh(path, { signal: controller.current.signal });
      setState({ data: payload?.data ?? null, meta: payload?.meta ?? null, loading: false, error: null });
    } catch (error) {
      if (error.name === 'AbortError') return;
      setState({ data: null, meta: null, loading: false, error });
    }
    // Extra deps are supplied by the caller so a changing query string refetches.
  }, [path, enabled, ...deps]);

  useEffect(() => {
    load();
    return () => controller.current?.abort();
  }, [load]);

  return { ...state, reload: load };
}

export function useMutation(mutator) {
  const [state, setState] = useState({ loading: false, error: null });
  const run = useCallback(
    async (...args) => {
      setState({ loading: true, error: null });
      try {
        const result = await mutator(...args);
        setState({ loading: false, error: null });
        return result;
      } catch (error) {
        setState({ loading: false, error });
        throw error;
      }
    },
    [mutator]
  );
  return { ...state, run };
}

export function buildQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach((entry) => search.append(key, entry));
    else search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export function useSession() {
  const { data, loading, error, reload } = useApi('/v1/auth/me');
  const value = useMemo(() => {
    if (!data) return null;
    return {
      ...data,
      permissionSet: new Set(data.permissions ?? []),
      can: (permission) => (data.user?.is_platform_admin ? true : (data.permissions ?? []).includes(permission)),
      hasModule: (module) => (data.user?.is_platform_admin ? true : (data.modules ?? []).includes(module)),
    };
  }, [data]);
  return { session: value, loading, error, reload };
}
