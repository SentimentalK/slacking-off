// `/play` transport: every wire call the page makes lives here, so the page
// itself only deals with `PlayState` and the envelope's `events`.

import { ApiError, getEnvelope, postEnvelope } from '../api';
import type { EnvelopeResult } from '../api';
import type {
  ActionQueued,
  JoinResponse,
  LeaveResponse,
  PlayAgentResponse,
  PlayState,
} from '../types';
import type { PlayAction } from './actions';

/** Poll cadence: the page is visible. */
export const VISIBLE_POLL_MS = 1000;
/** Poll cadence: `document.hidden` is true (task §Play). */
export const HIDDEN_POLL_MS = 5000;

/** A 401 on any `/api/play/*` call means "signed out", not "broken". */
export function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'not_authenticated';
}

export async function loadMe(): Promise<PlayAgentResponse> {
  const { result } = await getEnvelope<PlayAgentResponse>('/api/play/agent');
  return result;
}

export async function createHuman(nick: string, color: number): Promise<PlayAgentResponse> {
  const { result } = await postEnvelope<PlayAgentResponse>('/api/play/agent', { nick, color });
  return result;
}

export function loadState(): Promise<EnvelopeResult<PlayState>> {
  return getEnvelope<PlayState>('/api/play/state');
}

export function joinWorld(): Promise<EnvelopeResult<JoinResponse>> {
  return postEnvelope<JoinResponse>('/api/play/join', {});
}

/** One command per menu button; shapes follow contract-J §4. */
export function submit(action: PlayAction): Promise<EnvelopeResult<ActionQueued>> {
  switch (action.kind) {
    case 'move':
      return postEnvelope<ActionQueued>('/api/play/move', {
        spec: { Steps: { dir: action.dir, count: 1 } },
      });
    case 'build':
      return postEnvelope<ActionQueued>('/api/play/build', {
        kind: action.build,
        target: action.target,
      });
    case 'demolish':
      return postEnvelope<ActionQueued>('/api/play/demolish', { target: action.target });
    case 'door':
      return postEnvelope<ActionQueued>('/api/play/door', {
        target: action.target,
        open: action.open,
      });
    case 'attack':
      return postEnvelope<ActionQueued>('/api/play/attack', { dir: action.dir });
    case 'defend':
      return postEnvelope<ActionQueued>('/api/play/defend', { dir: action.dir });
    case 'upgrade':
      return postEnvelope<ActionQueued>('/api/play/upgrade', { target: action.target });
    case 'downgrade':
      return postEnvelope<ActionQueued>('/api/play/downgrade', { target: action.target });
    case 'use':
      return postEnvelope<ActionQueued>('/api/play/use', {});
  }
}

export function cancelAction(): Promise<EnvelopeResult<ActionQueued>> {
  return postEnvelope<ActionQueued>('/api/play/cancel', {});
}

export function leaveWorld(): Promise<EnvelopeResult<LeaveResponse>> {
  return postEnvelope<LeaveResponse>('/api/play/leave', {});
}

/**
 * What the player should read for a failed command. Rate limiting is the one
 * code with a machine-readable hint, so it gets a specific sentence.
 */
export function commandMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'rate_limited') {
      const seconds = error.retryAfterSeconds ?? 1;
      return `请求过快，${seconds} 秒后再试`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : '请求失败';
}
