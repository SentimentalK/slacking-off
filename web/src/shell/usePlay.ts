import { useEffect, useRef, useState } from 'preact/hooks';
import type { PlayAction } from '../play/actions';
import {
  HIDDEN_POLL_MS,
  VISIBLE_POLL_MS,
  cancelAction,
  commandMessage,
  createHuman,
  isAuthError,
  joinWorld,
  leaveWorld,
  loadMe,
  loadState,
  submit,
} from '../play/client';
import type {
  ActionState,
  EventView,
  PlayMe,
  PlayState,
  SessionOutcome,
} from '../types';
import { zhAction, zhReason } from '../eventText';

const EVENT_LIMIT = 50;

const RESULT_EVENT_RE = /^(success|failed_deadline|failed_recovery|left|abandoned)(?:, score (\d+))?/;

export type Phase = 'loading' | 'signedOut' | 'noAgent' | 'ready' | 'failed';

export interface Outcome {
  outcome: SessionOutcome;
  score: number | null;
}

export type CommandResult = { ok: true; notice?: string } | { ok: false; message: string };

/** `EventView` has no `kind`, so the ending is read from its own text. */
function resultFromEvents(events: EventView[], nick: string): Outcome | null {
  const prefix = `${nick} left the world: `;
  for (const event of events) {
    if (!event.text.startsWith(prefix)) continue;
    const match = RESULT_EVENT_RE.exec(event.text.slice(prefix.length));
    if (!match) continue;
    return {
      outcome: match[1] as SessionOutcome,
      score: match[2] === undefined ? null : Number(match[2]),
    };
  }
  return null;
}

function mergeEvents(previous: EventView[], incoming: EventView[]): EventView[] {
  if (incoming.length === 0) return previous;
  const seen = new Set(previous.map((event) => `${event.tick}:${event.seq}`));
  const fresh = incoming.filter((event) => !seen.has(`${event.tick}:${event.seq}`));
  if (fresh.length === 0) return previous;
  const merged = [...fresh, ...previous];
  merged.sort((a, b) => b.tick - a.tick || b.seq - a.seq);
  return merged.slice(0, EVENT_LIMIT);
}

/** An accepted command waiting for the server to settle it. */
export interface PendingAction {
  label: string;
  effectiveTick: number;
}

export type PendingTone = 'rejected' | 'executing' | 'pending' | 'idle';

export interface PendingBar {
  tone: PendingTone;
  title: string;
  detail: string;
}

/**
 * The bar under the scene: one line of truth per state. A failed command wins
 * over a running action, which wins over a queued one, which wins over "idle",
 * so the player never reads an older success next to a fresh rejection.
 */
function pendingBar(
  error: string | null,
  executing: ActionState | null,
  pending: PendingAction | null,
  countdown: string,
): PendingBar {
  if (error) return { tone: 'rejected', title: `被拒绝：${zhReason(error)}`, detail: '' };
  if (executing) {
    return {
      tone: 'executing',
      title: `正在执行：${zhAction(executing.description)}`,
      detail: `剩 ${executing.remaining} 回合`,
    };
  }
  if (pending) {
    return {
      tone: 'pending',
      title: `已提交：${pending.label}`,
      detail: `下一次结算执行 · ${countdown}`,
    };
  }
  return { tone: 'idle', title: '没有待执行动作', detail: `下一次结算 · ${countdown}` };
}

export function usePlay(active: boolean) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<PlayMe | null>(null);
  const [state, setState] = useState<PlayState | null>(null);
  const [prev, setPrev] = useState<PlayState | null>(null);
  const [arrivedAt, setArrivedAt] = useState(0);
  const [events, setEvents] = useState<EventView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msLeft, setMsLeft] = useState(0);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const busyRef = useRef(false);
  const stateRef = useRef<PlayState | null>(null);
  const deadlineRef = useRef(0);

  const applyState = (next: PlayState, incoming: EventView[]) => {
    const before = stateRef.current;
    if (!before || before.tick !== next.tick) {
      setPrev(before);
      setArrivedAt(performance.now());
    }
    stateRef.current = next;
    setState(next);
    // The server settled the queued command: its tick reached `effective_tick`,
    // so the bar must stop claiming "已提交".
    setPending((current) => (current && next.tick >= current.effectiveTick ? null : current));
    if (incoming.length > 0) setEvents((previous) => mergeEvents(previous, incoming));
    deadlineRef.current = performance.now() + next.ms_to_next_tick;
    setMsLeft(next.ms_to_next_tick);
    if (next.agent?.outcome) {
      setOutcome({ outcome: next.agent.outcome, score: next.agent.score });
    } else if (!next.joined) {
      const result = resultFromEvents(incoming, next.me.nick);
      if (result) setOutcome(result);
    }
  };

  useEffect(() => {
    let alive = true;
    loadMe()
      .then((response) => {
        if (!alive) return;
        if (response.agent) {
          setMe(response.agent);
          setPhase('ready');
        } else {
          setPhase('noAgent');
        }
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        if (isAuthError(caught)) {
          setPhase('signedOut');
        } else {
          setLoadError(commandMessage(caught));
          setPhase('failed');
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  // One recursive timeout, skipped while a request is open.
  useEffect(() => {
    if (!active || !me) return;
    let stopped = false;
    let timer = 0;
    let pollInFlight = false;

    const delay = () => (document.hidden ? HIDDEN_POLL_MS : VISIBLE_POLL_MS);

    const schedule = (ms: number) => {
      if (stopped) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(run, ms);
    };

    const run = async () => {
      if (stopped) return;
      if (busyRef.current || pollInFlight) {
        schedule(delay());
        return;
      }
      pollInFlight = true;
      try {
        const envelope = await loadState();
        if (stopped) return;
        applyState(envelope.result, envelope.events);
      } catch (caught) {
        if (stopped) return;
        if (isAuthError(caught)) {
          stopped = true;
          setMe(null);
          setPhase('signedOut');
          return;
        }
        setError(commandMessage(caught));
      } finally {
        pollInFlight = false;
        if (!stopped) schedule(delay());
      }
    };

    const onVisibility = () => {
      if (stopped || pollInFlight) return;
      schedule(document.hidden ? HIDDEN_POLL_MS : 0);
    };

    document.addEventListener('visibilitychange', onVisibility);
    schedule(0);

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // `applyState` only touches setters and refs; `me` and `active` are the keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, active]);

  // Local countdown, corrected by every fresh `ms_to_next_tick`.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!stateRef.current) return;
      setMsLeft(Math.max(0, deadlineRef.current - performance.now()));
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  const withBusy = async (task: () => Promise<CommandResult>): Promise<CommandResult> => {
    if (busyRef.current) return { ok: false, message: '动作在途，稍等' };
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      return await task();
    } catch (caught) {
      if (isAuthError(caught)) {
        setMe(null);
        setPhase('signedOut');
        return { ok: false, message: '登录已失效' };
      }
      const message = commandMessage(caught);
      setError(message);
      return { ok: false, message };
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const refresh = async () => {
    const envelope = await loadState();
    applyState(envelope.result, envelope.events);
  };

  const runAction = (action: PlayAction) =>
    withBusy(async () => {
      const envelope = await submit(action);
      if (envelope.events.length > 0) {
        setEvents((previous) => mergeEvents(previous, envelope.events));
      }
      setPending({ label: action.label, effectiveTick: envelope.result.effective_tick });
      await refresh();
      return { ok: true };
    });

  const doJoin = () =>
    withBusy(async () => {
      const envelope = await joinWorld();
      const placement = envelope.result.placement;
      const notice =
        'Waiting' in placement
          ? `排队中，前面还有 ${placement.Waiting.ahead} 人`
          : '已入场，开始找马桶吧';
      setOutcome(null);
      await refresh();
      return { ok: true, notice };
    });

  const doCancel = () =>
    withBusy(async () => {
      await cancelAction();
      await refresh();
      return { ok: true, notice: '已取消当前动作' };
    });

  const doLeave = () =>
    withBusy(async () => {
      const envelope = await leaveWorld();
      setOutcome({ outcome: envelope.result.outcome, score: envelope.result.score });
      await refresh();
      return { ok: true, notice: '已离场' };
    });

  const doCreate = (nick: string, color: number) =>
    withBusy(async () => {
      const response = await createHuman(nick, color);
      if (!response.agent) throw new Error('服务端没有返回角色');
      setMe(response.agent);
      setPhase('ready');
      return { ok: true, notice: '角色已创建，准备入场' };
    });

  const countdown = msLeft <= 0 ? '结算中' : `${(msLeft / 1000).toFixed(1)}s`;
  const executing = state?.joined ? (state.agent?.action ?? null) : null;

  return {
    phase,
    me,
    state,
    prev,
    arrivedAt,
    events,
    busy,
    error,
    pending,
    outcome,
    loadError,
    countdown,
    bar: pendingBar(error, executing, pending, countdown),
    runAction,
    doJoin,
    doCancel,
    doLeave,
    doCreate,
  };
}
