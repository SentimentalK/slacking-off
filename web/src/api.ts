// Same-origin API client. Every `/api/*` answer is an `Envelope<T>`:
// `{ok, result?, error?}` (see `crates/proto/src/lib.rs`).

import type { Pos, Projection, ProjectionObject } from './types';

export interface Envelope<T> {
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

export class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

function unwrap<T>(body: unknown, path: string): T {
  if (body && typeof body === 'object' && 'ok' in body) {
    const envelope = body as Envelope<T>;
    if (!envelope.ok || envelope.result === undefined) {
      throw new ApiError(
        envelope.error?.code ?? 'unknown',
        envelope.error?.message ?? `${path} 返回失败`,
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

  open();

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    source?.close();
    source = null;
    onStatus('closed');
  };
}
