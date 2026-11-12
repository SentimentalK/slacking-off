// The selected-agent card. Live and replay render exactly this, so a nickname
// or meter never disagrees between the two pages.

import { SpriteBot } from './SpriteBot';
import { NEED_LABEL, formatClock, formatNumber } from '../labels';
import { URGENT_TICKS, agentColor, agentLook } from '../render';
import type { ProjectionAgent } from '../types';

/** Longest configured deadline; the card's meter is scaled against it. */
const DEADLINE_MAX_TICKS = 240;

interface Props {
  agent: ProjectionAgent;
  tick: number;
  tickSeconds: number;
}

export function AgentCard({ agent, tick, tickSeconds }: Props) {
  const look = agentLook(agent, tick);
  const remainingTicks = Math.max(0, agent.deadline_tick - tick);
  const urgent = remainingTicks <= URGENT_TICKS;

  return (
    <div class="panel agent-card">
      <div class="agent-card-head">
        <SpriteBot look={look} color={agentColor(agent.color)} label={`${agent.nick} 的头像`} />
        <div class="agent-id">
          <div class="agent-nick">{agent.nick}</div>
          <div class="muted">
            等级 <span class="mono">{agent.level}</span> · 累计{' '}
            <span class="mono">{formatNumber(agent.score_total)}</span> 分
          </div>
          <div class="muted">
            坐标{' '}
            <span class="mono">
              ({agent.pos.x}, {agent.pos.y})
            </span>{' '}
            · 朝向 <span class="mono">{agent.facing}</span>
          </div>
        </div>
      </div>

      <div class="agent-id">
        <div class="need-row">
          <span>
            {agent.need ? `${NEED_LABEL[agent.need]}${urgent ? ' · 快憋不住了' : ''}` : '没有需求'}
          </span>
          <span class="need-remaining" data-ok={urgent ? 'false' : 'true'}>
            {agent.need ? formatClock(remainingTicks * tickSeconds) : '—'}
          </span>
        </div>
        <div class="meter">
          <div
            class="meter-fill"
            style={{
              width: `${Math.min(100, Math.max(0, (remainingTicks / DEADLINE_MAX_TICKS) * 100))}%`,
              background: urgent ? 'var(--danger)' : 'var(--success)',
            }}
          />
        </div>
      </div>

      <div class="tags">
        <span class={agent.sent_by === 'self' ? 'tag gold' : 'tag'}>
          {agent.sent_by === 'human' ? '主人叫来的' : '摸鱼来的'}
        </span>
        <span class="tag">
          得分 <span class="mono">{formatNumber(agent.score_total)}</span>
        </span>
        {agent.pose === 'using' && agent.use_total > 0 ? (
          <span class="tag">
            如厕{' '}
            <span class="mono">
              {agent.use_done}/{agent.use_total}
            </span>
          </span>
        ) : null}
      </div>

      <div class="vision-note">
        视野 9×9：棋盘上的黄色虚线框就是它看得到的范围，选中后整体高亮一格黄框。
      </div>
    </div>
  );
}
