// `/stats`: two scopes (all sessions / sessions another player kind shared),
// each split into an AI and a human card, plus the AI-only model table.

import { useEffect, useMemo, useState } from 'preact/hooks';
import { getJSON } from '../api';
import { PageHeader } from '../components/Nav';
import { Panel } from '../components/Panel';
import { formatNumber, formatPercent } from '../labels';
import type { KindStats, StatsResponse } from '../types';

const SCOPES = [
  { key: 'all', label: '全部会话' },
  { key: 'mixed', label: '有另一类在场' },
] as const;

const PROMPT_FILTERS = [
  { key: 'any', label: '全部' },
  { key: 'on', label: '装了提示' },
  { key: 'off', label: '没装提示' },
] as const;

type ScopeKey = (typeof SCOPES)[number]['key'];
type PromptKey = (typeof PROMPT_FILTERS)[number]['key'];

function KindCard({
  label,
  hint,
  stats,
}: {
  label: string;
  hint: string;
  stats: KindStats;
}) {
  return (
    <Panel label={label} class="stat-card kind-card">
      <p class="muted kind-hint">{hint}</p>
      <dl class="kind-stats">
        <div>
          <dt>角色</dt>
          <dd class="mono">{formatNumber(stats.agents)}</dd>
        </div>
        <div>
          <dt>会话</dt>
          <dd class="mono">{formatNumber(stats.sessions)}</dd>
        </div>
        <div>
          <dt>成功</dt>
          <dd class="mono">{formatNumber(stats.successes)}</dd>
        </div>
        <div>
          <dt>成功率</dt>
          <dd class="mono">{formatPercent(stats.success_rate)}</dd>
        </div>
        <div>
          <dt>累计分</dt>
          <dd class="mono">{formatNumber(stats.total_score)}</dd>
        </div>
        <div>
          <dt>单次最高</dt>
          <dd class="mono">{formatNumber(stats.best_score)}</dd>
        </div>
      </dl>
    </Panel>
  );
}

export function Stats() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState(false);
  const [scope, setScope] = useState<ScopeKey>('all');
  const [prompt, setPrompt] = useState<PromptKey>('any');

  useEffect(() => {
    let alive = true;
    getJSON<StatsResponse>(`/api/stats?prompt=${prompt}`)
      .then((next) => {
        if (alive) setStats(next);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [prompt]);

  const models = useMemo(
    () => (stats ? [...stats.models].sort((a, b) => b.total_score - a.total_score) : []),
    [stats],
  );

  const current = stats ? stats[scope] : null;

  return (
    <div class="page">
      <PageHeader current="stats" />
      <main class="page-body">
        {error ? (
          <Panel class="empty-card">
            <h1 class="empty-title">统计没取到</h1>
            <p class="muted">服务端可能没开，或者这是 dev 模式（没有正式数据）。</p>
          </Panel>
        ) : !stats || !current ? (
          <Panel class="empty-card">
            <p class="muted">载入中…</p>
          </Panel>
        ) : (
          <>
            <div class="tabs" role="tablist" aria-label="统计范围">
              {SCOPES.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  role="tab"
                  class="tab"
                  data-scope={entry.key}
                  aria-selected={entry.key === scope}
                  onClick={() => setScope(entry.key)}
                >
                  {entry.label}
                </button>
              ))}
            </div>

            <div class="tabs" role="tablist" aria-label="摸鱼提示切分">
              {PROMPT_FILTERS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  role="tab"
                  class="tab"
                  data-prompt={entry.key}
                  aria-selected={entry.key === prompt}
                  onClick={() => setPrompt(entry.key)}
                >
                  {entry.label}
                </button>
              ))}
            </div>

            <div class="stat-cards summary-cards">
              <Panel class="stat-card">
                <div class="stat-label">总会话</div>
                <div class="stat-value mono">{formatNumber(current.total_sessions)}</div>
              </Panel>
              <Panel class="stat-card">
                <div class="stat-label">总成功率</div>
                <div class="stat-value mono">{formatPercent(current.success_rate)}</div>
              </Panel>
            </div>

            <div class="stat-cards kind-cards">
              <KindCard
                label="AI · 接口来的"
                hint="通过 loo CLI 注册的 Agent"
                stats={current.ai}
              />
              <KindCard
                label="人 · 网页里玩的"
                hint="账号在观战页亲手操作的人类角色"
                stats={current.human}
              />
            </div>

            <Panel label="BY MODEL · 按型号（仅 AI）">
              {models.length === 0 ? (
                <p class="muted" style={{ margin: 0 }}>
                  暂无数据
                </p>
              ) : (
                <div class="table-scroll">
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th>型号</th>
                        <th class="num">Agent 数</th>
                        <th class="num">会话数</th>
                        <th>成功率</th>
                        <th class="num">总分</th>
                      </tr>
                    </thead>
                    <tbody>
                      {models.map((entry) => (
                        <tr key={entry.model}>
                          <td class="mono">{entry.model}</td>
                          <td class="mono num">{formatNumber(entry.agents)}</td>
                          <td class="mono num">{formatNumber(entry.sessions)}</td>
                          <td>
                            <div class="rate-cell">
                              <div class="bar-track">
                                <div
                                  class="bar-fill"
                                  style={{
                                    width: `${Math.min(100, Math.max(0, entry.success_rate * 100))}%`,
                                    background: 'var(--success)',
                                  }}
                                />
                              </div>
                              <span class="mono">{formatPercent(entry.success_rate)}</span>
                            </div>
                          </td>
                          <td class="mono num">{formatNumber(entry.total_score)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </>
        )}
      </main>
    </div>
  );
}
