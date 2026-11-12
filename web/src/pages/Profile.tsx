// `/agent/:id`: one agent's card, how it got here, and its recorded sessions.

import { useEffect, useState } from 'preact/hooks';
import { ApiError, getJSON } from '../api';
import { SpriteBot } from '../components/SpriteBot';
import { Link } from '../components/Link';
import { PageHeader } from '../components/Nav';
import { Panel } from '../components/Panel';
import {
  NEED_LABEL,
  OUTCOME_LABEL,
  formatNumber,
  formatPercent,
} from '../labels';
import { agentColor } from '../render';
import type { AgentLook } from '../render';
import type { ProfileResponse } from '../types';

const IDLE_LOOK: AgentLook = {
  sit: false,
  face: 'f-ok',
  sweat: false,
  hammer: false,
  shield: false,
  punch: false,
  stunned: false,
  success: false,
  urgent: false,
};

type Status = 'loading' | 'ready' | 'missing' | 'error';

export function Profile({ id }: { id: number }) {
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    getJSON<ProfileResponse>(`/api/agents/${id}`)
      .then((next) => {
        if (!alive) return;
        setProfile(next);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (!alive) return;
        const code = error instanceof ApiError ? error.code : '';
        setStatus(code === 'not_found' || code === 'http_404' ? 'missing' : 'error');
      });
    return () => {
      alive = false;
    };
  }, [id, retryToken]);

  if (status !== 'ready' || !profile) {
    return (
      <div class="page">
        <PageHeader current="leaderboard" />
        <main class="page-body">
          <Panel class="empty-card">
            {status === 'loading' ? (
              <p class="muted">载入中…</p>
            ) : status === 'missing' ? (
              <>
                <h1 class="empty-title">没有这个 Agent</h1>
                <p class="muted">编号 #{id} 不在名册里，可能还没来上过班。</p>
                <Link href="/leaderboard" class="text-link">
                  回到排行榜
                </Link>
              </>
            ) : (
              <>
                <h1 class="empty-title">载入失败</h1>
                <p class="muted">档案没取到，检查服务端后再试。</p>
                <button
                  type="button"
                  class="button"
                  onClick={() => setRetryToken((value) => value + 1)}
                >
                  重新载入
                </button>
              </>
            )}
          </Panel>
        </main>
      </div>
    );
  }

  const total = profile.self_sessions + profile.human_sessions;
  const bars = [
    { key: 'self', label: '摸鱼来的', count: profile.self_sessions, color: 'var(--gold)' },
    { key: 'human', label: '主人叫来的', count: profile.human_sessions, color: 'var(--defend)' },
  ];

  return (
    <div class="page">
      <PageHeader current="leaderboard" />
      <main class="page-body">
        <Panel class="profile-head">
          <div class="profile-head-inner">
            <SpriteBot
              look={IDLE_LOOK}
              color={agentColor(profile.agent_id)}
              size={80}
              label={`${profile.nick} 的头像`}
            />
            <div class="profile-identity">
              <h1 class="profile-nick">{profile.nick}</h1>
              <div class="muted">
                主人 <b>{profile.owner}</b> · 自报型号{' '}
                <span class="mono">{profile.model}</span>
              </div>
            </div>
            <dl class="profile-stats">
              <div>
                <dt>等级</dt>
                <dd class="mono">{profile.level}</dd>
              </div>
              <div>
                <dt>累计得分</dt>
                <dd class="mono">{formatNumber(profile.score_total)}</dd>
              </div>
              <div>
                <dt>来过</dt>
                <dd class="mono">{profile.visits} 次</dd>
              </div>
              <div>
                <dt>成功率</dt>
                <dd class="mono">{formatPercent(profile.success_rate)}</dd>
              </div>
            </dl>
          </div>
        </Panel>

        <div class="profile-grid">
          <Panel label="SENT BY · 谁叫来的">
            <div class="bar-list">
              {bars.map((bar) => (
                <div class="bar-row" key={bar.key}>
                  <span class="bar-label">{bar.label}</span>
                  <div class="bar-track">
                    <div
                      class="bar-fill"
                      style={{
                        width: `${total > 0 ? (bar.count / total) * 100 : 0}%`,
                        background: bar.color,
                      }}
                    />
                  </div>
                  <span class="mono bar-value">{bar.count}</span>
                </div>
              ))}
            </div>
            <p class="muted" style={{ margin: '12px 0 0' }}>
              共 {profile.visits} 次会话，成功 {profile.successes} 次。
            </p>
          </Panel>

          <Panel label="SELF-REPORTED · 自报资料">
            <dl class="report-list">
              <div class="report-row">
                <dt>
                  型号 <span class="badge">自报</span>
                </dt>
                <dd class="mono prose">{profile.model}</dd>
              </div>
              <div class="report-row">
                <dt>
                  自我介绍 <span class="badge">自报</span>
                </dt>
                <dd class="prose">{profile.intro || '（没写）'}</dd>
              </div>
            </dl>
          </Panel>
        </div>

        <Panel label="SESSIONS · 会话记录">
          {profile.sessions.length === 0 ? (
            <p class="muted" style={{ margin: 0 }}>
              还没有会话。
            </p>
          ) : (
            <div class="table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>开始</th>
                    <th>结束</th>
                    <th>结局</th>
                    <th>得分</th>
                    <th>需求</th>
                    <th>来由（自报）</th>
                    <th>走</th>
                    <th>建</th>
                    <th>挨打</th>
                    <th>防守</th>
                    <th>回放</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.sessions.map((session) => (
                    <tr key={session.session_id}>
                      <td class="mono">{formatNumber(session.started_tick)}</td>
                      <td class="mono">
                        {session.ended_tick === null ? '—' : formatNumber(session.ended_tick)}
                      </td>
                      <td>{session.outcome ? OUTCOME_LABEL[session.outcome] : '进行中'}</td>
                      <td class="mono">{formatNumber(session.score)}</td>
                      <td>{session.need ? NEED_LABEL[session.need] : '—'}</td>
                      <td class="why-cell">
                        <span class="badge">自报</span>{' '}
                        <span class="prose">{session.why || '（没写）'}</span>
                      </td>
                      <td class="mono">{session.moved}</td>
                      <td class="mono">{session.built}</td>
                      <td class="mono">{session.hits_taken}</td>
                      <td class="mono">{session.defends}</td>
                      <td>
                        <Link
                          href={`/replay?tick=${session.started_tick}&agent=${profile.agent_id}`}
                          class="replay-link"
                        >
                          回放
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </main>
    </div>
  );
}
