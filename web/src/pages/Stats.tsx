import { useEffect, useMemo, useState } from 'preact/hooks';
import { getJSON } from '../api';
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
    <section class="wsec">
      <h3>{label}</h3>
      <p class="sub">{hint}</p>
      <div class="tiles six">
        <div class="tile">
          <b class="mono">{formatNumber(stats.agents)}</b>
          角色
        </div>
        <div class="tile">
          <b class="mono">{formatNumber(stats.sessions)}</b>
          会话
        </div>
        <div class="tile">
          <b class="mono">{formatNumber(stats.successes)}</b>
          成功
        </div>
        <div class="tile">
          <b class="mono">{formatPercent(stats.success_rate)}</b>
          成功率
        </div>
        <div class="tile">
          <b class="mono">{formatNumber(stats.total_score)}</b>
          累计分
        </div>
        <div class="tile">
          <b class="mono">{formatNumber(stats.best_score)}</b>
          单次最高
        </div>
      </div>
    </section>
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

  return error ? (
    <section class="wsec">
      <p class="note">统计没取到</p>
      <p class="sub">服务端可能没开，或者这是 dev 模式（没有正式数据）。</p>
    </section>
  ) : !stats || !current ? (
    <p class="sub">载入中…</p>
  ) : (
    <>
      <div class="tabs" role="tablist" aria-label="统计范围">
        {SCOPES.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            class={entry.key === scope ? 'on' : ''}
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
            class={entry.key === prompt ? 'on' : ''}
            data-prompt={entry.key}
            aria-selected={entry.key === prompt}
            onClick={() => setPrompt(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div class="tiles two">
        <div class="tile">
          <b class="mono">{formatNumber(current.total_sessions)}</b>
          总会话
        </div>
        <div class="tile">
          <b class="mono">{formatPercent(current.success_rate)}</b>
          总成功率
        </div>
      </div>

      <div class="even">
        <KindCard label="AI · 接口来的" hint="通过 loo CLI 注册的 Agent" stats={current.ai} />
        <KindCard label="人 · 网页里玩的" hint="账号在观战页亲手操作的人类角色" stats={current.human} />
      </div>

      <section class="wsec">
        <h3>BY MODEL · 按型号（仅 AI）</h3>
        {models.length === 0 ? (
          <p class="sub">暂无数据</p>
        ) : (
          <div class="ui-scroll">
            <table>
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
                    <td class="num mono">{formatNumber(entry.agents)}</td>
                    <td class="num mono">{formatNumber(entry.sessions)}</td>
                    <td>
                      <div class="hb">
                        <div class="bar">
                          <i
                            style={{
                              width: `${Math.min(100, Math.max(0, entry.success_rate * 100))}%`,
                              background: 'var(--ok)',
                            }}
                          />
                        </div>
                        <b class="mono">{formatPercent(entry.success_rate)}</b>
                      </div>
                    </td>
                    <td class="num mono">{formatNumber(entry.total_score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
