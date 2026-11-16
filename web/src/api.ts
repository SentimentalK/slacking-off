// Same-origin API client. Every `/api/*` answer is an `Envelope<T>`:
// `{ok, result?, error?}` (see `crates/proto/src/lib.rs`).

import type {
  AgentView,
  EventView,
  Pos,
  Projection,
  ProjectionObject,
} from './types';

export interface EnvelopeError {
  code: string;
  message: string;
  /** `ErrorCode::RateLimited` only: how long the caller should wait. */
  retry_after_seconds?: number | null;
}

export interface Envelope<T> {
  ok: boolean;
  result?: T;
  error?: EnvelopeError;
  /** The caller's own events since the previous response (contract §3). */
  events?: EventView[];
  state?: AgentView | null;
}

export class ApiError extends Error {
  readonly code: string;
  /** `retry_after_seconds` from a rate-limited answer, otherwise `null`. */
  readonly retryAfterSeconds: number | null;

  constructor(code: string, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A `T` plus the envelope's side channels (`events`, `state`). */
export interface EnvelopeResult<T> {
  result: T;
  events: EventView[];
  state: AgentView | null;
}

function unwrap<T>(body: unknown, path: string): T {
  if (body && typeof body === 'object' && 'ok' in body) {
    const envelope = body as Envelope<T>;
    if (!envelope.ok || envelope.result === undefined) {
      throw new ApiError(
        envelope.error?.code ?? 'unknown',
        envelope.error?.message ?? `${path} 返回失败`,
        envelope.error?.retry_after_seconds ?? null,
      );
    }
    return envelope.result;
  }
  // `/api/terrain` is specified as a bare `{width,height,rows}` object.
  return body as T;
}

export async function getJSON<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { accept: 'application/json' } });
  } catch {
    throw new ApiError('network', `${path} 连不上服务端`);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok && !(body && typeof body === 'object' && 'ok' in body)) {
    throw new ApiError(`http_${res.status}`, `${path} 返回 HTTP ${res.status}`);
  }
  return unwrap<T>(body, path);
}

const CSRF_COOKIE = 'loo_csrf';

function readCookie(name: string): string | null {
  for (const pair of document.cookie.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * One envelope-producing call. Non-GET mirrors the readable `loo_csrf` cookie
 * into `X-Loo-CSRF` (contract §1), exactly like `auth.ts`.
 */
async function envelopeRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<EnvelopeResult<T>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers['X-Loo-CSRF'] = csrf;
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network', `${path} 连不上服务端`);
  }

  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== 'object' || !('ok' in parsed)) {
    throw new ApiError(
      `http_${res.status}`,
      `${path} 返回 HTTP ${res.status}${text.trim() ? `: ${text.trim().slice(0, 120)}` : ''}`,
    );
  }

  const envelope = parsed as Envelope<T>;
  if (!envelope.ok || envelope.result === undefined) {
    throw new ApiError(
      envelope.error?.code ?? 'unknown',
      envelope.error?.message ?? `${path} 返回失败`,
      envelope.error?.retry_after_seconds ?? null,
    );
  }
  return {
    result: envelope.result,
    events: envelope.events ?? [],
    state: envelope.state ?? null,
  };
}

export function getEnvelope<T>(path: string): Promise<EnvelopeResult<T>> {
  return envelopeRequest<T>('GET', path);
}

export function postEnvelope<T>(path: string, body: unknown): Promise<EnvelopeResult<T>> {
  return envelopeRequest<T>('POST', path, body);
}

/** `POST` helper the play page uses; errors carry `code` and `retryAfterSeconds`. */
export async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const { result } = await postEnvelope<T>(path, body);
  return result;
}

export type WatchStatus = 'live' | 'reconnecting' | 'closed';

const WATCH_PATH = '/api/watch';
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 10_000;

const byYThenX = (a: ProjectionObject, b: ProjectionObject) =>
  a.pos.y - b.pos.y || a.pos.x - b.pos.x;

/**
 * Turn a `delta` frame into a full projection using the previous full one.
 * A frame that is full (field missing), or a delta that does not directly
 * follow `last`, is taken as is: the server only sends deltas on consecutive
 * ticks, and the first frame of a connection is always full.
 */
export function mergeFrame(last: Projection | null, frame: Projection): Projection {
  if (frame.objects_mode !== 'delta' || !last || frame.tick !== last.tick + 1) {
    return frame;
  }
  const table = new Map<string, ProjectionObject>();
  const key = (pos: Pos) => `${pos.x},${pos.y}`;
  for (const object of last.objects) table.set(key(object.pos), object);
  for (const pos of frame.objects_removed ?? []) table.delete(key(pos));
  for (const object of frame.objects) table.set(key(object.pos), object);
  const { objects_mode: _mode, objects_removed: _removed, ...rest } = frame;
  return { ...rest, objects: [...table.values()].sort(byYThenX) };
}

/**
 * Subscribe to the live projection stream.
 *
 * `EventSource` retries on its own, but a half-open SSE stream can stay stuck,
 * so every `error` closes the source and reopens it with the last seen tick as
 * an explicit `?lastEventId=` (the server also accepts the header; the query
 * parameter survives the manual `new EventSource()` that cannot set headers).
 */
export function watch(
  onProjection: (projection: Projection) => void,
  onStatus: (status: WatchStatus) => void,
): () => void {
  let source: EventSource | null = null;
  let lastEventId: string | null = null;
  let attempt = 0;
  let timer = 0;
  let stopped = false;
  // The last full object table on this connection. Cleared on every
  // reconnect: the server's first frame on a connection is always full.
  let last: Projection | null = null;

  const scheduleRetry = () => {
    if (stopped) return;
    last = null;
    onStatus('reconnecting');
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempt);
    attempt += 1;
    timer = window.setTimeout(open, delay);
  };

  const open = () => {
    if (stopped) return;
    const es = new EventSource(
      lastEventId === null
        ? WATCH_PATH
        : `${WATCH_PATH}?lastEventId=${encodeURIComponent(lastEventId)}`,
    );
    source = es;
    last = null;

    es.addEventListener('open', () => {
      if (stopped || source !== es) return;
      last = null;
      attempt = 0;
      onStatus('live');
    });

    es.addEventListener('hello', () => {
      if (stopped || source !== es) return;
      attempt = 0;
      onStatus('live');
    });

    es.addEventListener('tick', (event) => {
      if (stopped || source !== es) return;
      const message = event as MessageEvent<string>;
      if (message.lastEventId) lastEventId = message.lastEventId;
      attempt = 0;
      onStatus('live');
      try {
        const frame = JSON.parse(message.data) as Projection;
        if (frame.objects_mode === 'delta' && (!last || frame.tick !== last.tick + 1)) {
          // The server only sends a delta on the tick after the one this
          // connection already has. Without that base the board would silently
          // lose objects, so force a fresh connection (whose first frame is
          // always full) instead of rendering a partial world.
          last = null;
          es.close();
          source = null;
          scheduleRetry();
          return;
        }
        const merged = mergeFrame(last, frame);
        last = merged;
        onProjection(merged);
      } catch {
        // A malformed frame is dropped; the next tick supersedes it.
      }
    });

    es.addEventListener('error', () => {
      if (stopped || source !== es) return;
      last = null;
      es.close();
      source = null;
      scheduleRetry();
    });
  };

  // A page kept in the back/forward cache would otherwise hold its stream open
  // and use up the browser's per-host connection slots.
  const onHide = () => {
    window.clearTimeout(timer);
    source?.close();
    source = null;
    last = null;
  };
  const onShow = (event: PageTransitionEvent) => {
    if (!event.persisted || stopped || source) return;
    attempt = 0;
    open();
  };
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);

  open();

  return () => {
    stopped = true;
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('pageshow', onShow);
    window.clearTimeout(timer);
    source?.close();
    source = null;
    onStatus('closed');
  };
}
