// Wire enums turned into labels in the current language, plus the number/clock formatting the
// panels share. Kept in one place so live, replay, profile and stats never
// drift apart.

import { t, type Key } from './i18n';
import type { EventTag, Need, SentBy, SessionOutcome } from './types';

const EVENT_KEY: Record<EventTag, Key> = {
  success: 'label.event.success',
  attack: 'label.event.attack',
  demolish: 'label.event.demolish',
  defend: 'label.event.defend',
  join: 'label.event.join',
  leave: 'label.event.leave',
  build: 'label.event.build',
  use: 'label.event.use',
  other: 'label.event.other',
};

const NEED_KEY: Record<Need, Key> = {
  urine: 'label.need.urine',
  feces: 'label.need.feces',
};

const SENT_BY_KEY: Record<SentBy, Key> = {
  self: 'label.sentBy.self',
  human: 'label.sentBy.human',
};

const OUTCOME_KEY: Record<SessionOutcome, Key> = {
  success: 'label.outcome.success',
  failed_deadline: 'label.outcome.failed_deadline',
  failed_recovery: 'label.outcome.failed_recovery',
  left: 'label.outcome.left',
  abandoned: 'label.outcome.abandoned',
};

export const eventLabel = (tag: EventTag): string => t(EVENT_KEY[tag]);
export const needLabel = (need: Need): string => t(NEED_KEY[need]);
export const sentByLabel = (sentBy: SentBy): string => t(SENT_BY_KEY[sentBy]);
export const outcomeLabel = (outcome: SessionOutcome): string => t(OUTCOME_KEY[outcome]);

export function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** `0.4286` -> `43%`; one decimal only when it says something. */
export function formatPercent(rate: number): string {
  const percent = rate * 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}
