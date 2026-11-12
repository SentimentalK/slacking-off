// Account API client (contract §1). Same origin only: the session rides in
// `loo_session` (HttpOnly) and every mutating call mirrors the readable
// `loo_csrf` cookie in `X-Loo-CSRF`.
//
// A 401 clears the cached identity and sends the browser to `/login`; the
// login and register forms opt out so a wrong password stays on the form as a
// red message instead of reloading it.

import { useEffect, useState } from 'preact/hooks';
import { navigate } from './router';
import type { AccountResponse, AuthMe, TokenCreateResponse } from './types';

const AUTH_EVENT = 'loo:auth';
const CSRF_COOKIE = 'loo_csrf';

export class AuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

interface Envelope<T> {
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** `false` keeps a 401 on the current page (login) instead of redirecting. */
  redirectOn401?: boolean;
}

function readCookie(name: string): string | null {
  for (const pair of document.cookie.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** Cached identity: `undefined` = not looked up yet, `null` = signed out. */
let cached: AuthMe | null | undefined;
let inflight: Promise<AuthMe | null> | null = null;

function setSession(next: AuthMe | null): void {
  cached = next;
  window.dispatchEvent(new Event(AUTH_EVENT));
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers['X-Loo-CSRF'] = csrf;
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new AuthError('network', `${path} 连不上服务端`, 0);
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  const envelope = body && typeof body === 'object' && 'ok' in body ? (body as Envelope<T>) : null;
  if (!response.ok || (envelope && !envelope.ok)) {
    const error = new AuthError(
      envelope?.error?.code ?? `http_${response.status}`,
      envelope?.error?.message ?? (text.trim() || `HTTP ${response.status}`),
      response.status,
    );
    if (response.status === 401 && options.redirectOn401 !== false) {
      setSession(null);
      const path = window.location.pathname.replace(/\/+$/, '') || '/';
      if (path !== '/login' && path !== '/register') navigate('/login');
    }
    throw error;
  }
  if (!envelope) {
    throw new AuthError('protocol', `${path} 返回的不是 JSON 信封`, response.status);
  }
  return envelope.result as T;
}

export function register(username: string, password: string): Promise<AuthMe> {
  return request<AuthMe>('/api/auth/register', {
    method: 'POST',
    body: { username, password },
    redirectOn401: false,
  }).then((me) => {
    setSession(me);
    return me;
  });
}

export function login(username: string, password: string): Promise<AuthMe> {
  return request<AuthMe>('/api/auth/login', {
    method: 'POST',
    body: { username, password },
    redirectOn401: false,
  }).then((me) => {
    setSession(me);
    return me;
  });
}

export async function logout(): Promise<void> {
  await request<Record<string, never>>('/api/auth/logout', { method: 'POST' });
  setSession(null);
}

export function me(options: { redirectOn401?: boolean } = {}): Promise<AuthMe> {
  return request<AuthMe>('/api/auth/me', options);
}

export function account(): Promise<AccountResponse> {
  return request<AccountResponse>('/api/account');
}

export function createToken(): Promise<TokenCreateResponse> {
  return request<TokenCreateResponse>('/api/account/token', { method: 'POST' });
}

export function revokeToken(): Promise<void> {
  return request<Record<string, never>>('/api/account/token/revoke', { method: 'POST' }).then(
    () => undefined,
  );
}

/**
 * Resolve the cached identity once per page load. A 404 means the server runs
 * in dev mode (accounts do not exist), which reads as signed out here.
 */
export function loadSession(): Promise<AuthMe | null> {
  if (cached !== undefined) return Promise.resolve(cached);
  if (!inflight) {
    inflight = me({ redirectOn401: false })
      .catch(() => null)
      .then((next) => {
        cached = next;
        return next;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export interface AuthState {
  username: string | null;
  loading: boolean;
}

/** Shared identity state for the nav; refreshes after login, logout and 401. */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>(() => ({
    username: cached?.username ?? null,
    loading: cached === undefined,
  }));

  useEffect(() => {
    let alive = true;
    const publish = () => {
      if (!alive) return;
      setState({ username: cached?.username ?? null, loading: cached === undefined });
    };
    window.addEventListener(AUTH_EVENT, publish);
    if (cached === undefined) {
      void loadSession().then(publish);
    } else {
      publish();
    }
    return () => {
      alive = false;
      window.removeEventListener(AUTH_EVENT, publish);
    };
  }, []);

  return state;
}
