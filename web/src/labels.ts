// Wire enums turned into Chinese labels, plus the number/clock formatting the
// panels share. Kept in one place so live, replay, profile and stats never
// drift apart.

import type { EventTag, Need, SentBy, SessionOutcome } from './types';

export const EVENT_LABEL: Record<EventTag, string> = {
  success: '成功',
  attack: '打人',
  demolish: '拆除',
  defend: '防御',
  join: '入场',
  leave: '离场',
  build: '施工',
  use: '如厕',
  other: '事件',
};

export const NEED_LABEL: Record<Need, string> = {
  urine: '想尿尿',
  feces: '想拉屎',
};

export const SENT_BY_LABEL: Record<SentBy, string> = {
  self: '摸鱼来的',
  human: '主人叫来的',
};

export const OUTCOME_LABEL: Record<SessionOutcome, string> = {
  success: '成功',
  failed_deadline: '憋爆了',
  failed_recovery: '恢复失败',
  left: '中途离开',
  abandoned: '掉线消失',
};

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
