import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { useI18n } from '../i18n';
import { navigate } from '../router';
import { formatNumber, needLabel, sentByLabel } from '../labels';
import { agentColor } from '../palette';
import type { LeaderRow, ProjectionAgent } from '../types';

export const DEADLINE_MAX_TICKS = 240;

interface Props {
  agent: ProjectionAgent | null;
  tick: number;
  top3: LeaderRow[];
  onVision?: (on: boolean) => void;
  visionState?: boolean;
  vision?: boolean;
  play?: boolean;
  extra?: ComponentChildren;
}

export function meterColor(fraction: number): string {
  if (fraction > 0.5) return 'var(--ok)';
  if (fraction > 0.2) return 'var(--gold)';
  return 'var(--bad)';
}

export function Card({ agent, tick, top3, onVision, visionState, vision = true, play = false, extra }: Props) {
  const { t, tn } = useI18n();
  const [localVision, setLocalVision] = useState(true);
  const visionOn = visionState ?? localVision;
  const [expanded, setExpanded] = useState(false);

  if (!agent) {
    if (top3.length === 0) return null;
    return (
      <div class="ui-card panel empty">
        <h3>{t('card.top3')}</h3>
        {top3.length === 0 ? (
          <div class="sub">{t('card.noData')}</div>
        ) : (
          top3.map((row) => (
            <div class="rowl" key={row.agent_id}>
              <span class="n">{row.rank}</span>
              <i class="sdot" style={{ background: 'var(--dim)' }} />
              <span class="n">
                {row.nick}
                {row.kind === 'human' ? <span class="tag h">{t('card.human')}</span> : null}
              </span>
              <span class="s">{formatNumber(row.score_total)}</span>
            </div>
          ))
        )}
        <div class="note">{t('card.hint')}</div>
      </div>
    );
  }

  const remaining = Math.max(0, agent.deadline_tick - tick);
  const fraction = Math.min(1, remaining / DEADLINE_MAX_TICKS);
  const urgent = agent.urgent;
  const toggleVision = () => {
    const next = !visionOn;
    setLocalVision(next);
    onVision?.(next);
  };

  return (
    <div class={['ui-card', 'panel', 'sel', expanded && 'expanded', play && 'play'].filter(Boolean).join(' ')}>
      <div class="who">
        <div class="dot" style={{ background: agentColor(agent.color) }} />
        <div class="card-id">
          <div class="nick">
            {agent.nick}
            {agent.kind === 'human' ? <span class="tag h">{t('card.human')}</span> : <span class="tag">AI</span>}
          </div>
          <div class="sub card-level">
            {t('card.level', { level: agent.level, score: formatNumber(agent.score_total) })}
          </div>
        </div>
        <button
          type="button"
          class="card-toggle"
          data-card-toggle
          aria-expanded={expanded ? 'true' : 'false'}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? t('card.collapse') : t('card.expand')}
        </button>
      </div>

      <div class="kv card-need">
        <b>{agent.need ? (urgent ? t('card.needUrgent', { need: needLabel(agent.need) }) : needLabel(agent.need)) : t('card.noNeed')}</b>
        <span class="sub">{agent.need ? tn('card.hold', remaining) : '—'}</span>
      </div>
      <div class="bar">
        <i style={{ width: `${agent.need ? fraction * 100 : 0}%`, background: meterColor(fraction) }} />
      </div>

      <div class="card-body">
        <div class="kv">
          <span class="sub">{t('card.progress', { done: agent.use_done, total: agent.use_total })}</span>
        </div>
        <div class="pips">
          {agent.use_total === 0 ? (
            <span class="sub">—</span>
          ) : (
            Array.from({ length: agent.use_total }, (_, index) => (
              <i key={index} class={index < agent.use_done ? 'f' : undefined} />
            ))
          )}
        </div>

        <div class="kv">
          <span class="sub">{t('card.origin')}</span>
          <span>{agent.kind === 'human' ? t('card.jumpIn') : agent.sent_by ? sentByLabel(agent.sent_by) : '—'}</span>
        </div>

        <div class="kv">
          <button type="button" onClick={() => navigate(`/agent/${agent.id}`)}>
            {t('card.profile')}
          </button>
          {vision && onVision ? (
            <button type="button" aria-pressed={visionOn ? 'true' : 'false'} onClick={toggleVision}>
              {t('card.vision')}
            </button>
          ) : null}
        </div>
        {extra}
      </div>
    </div>
  );
}
