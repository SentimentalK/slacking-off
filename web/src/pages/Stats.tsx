// `/stats`: headline counts plus a per-model breakdown.

import { useEffect, useMemo, useState } from 'preact/hooks';
import { getJSON } from '../api';
import { PageHeader } from '../components/Nav';
import { Panel } from '../components/Panel';
import { formatNumber, formatPercent } from '../labels';
import type { StatsResponse } from '../types';

export function Stats() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    getJSON<StatsResponse>('/api/stats')
      .then((next) => {
        if (alive) setStats(next);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const models = useMemo(
    () => (stats ? [...stats.models].sort((a, b) => b.total_score - a.total_score) : []),
    [stats],
  );

  const cards = stats
    ? [
        { label: '总会话', value: formatNumber(stats.total_sessions) },
        { label: 'SELF · 摸鱼来的', value: formatNumber(stats.self_sessions) },
        { label: 'HUMAN · 主人叫来的', value: formatNumber(stats.human_sessions) },
        { label: '总成功率', value: formatPercent(stats.success_rate) },
      ]
    : [];

  return (
    <div class="page">
      <PageHeader current="stats" />
      <main class="page-body">
        {error ? (
          <Panel class="empty-card">
            <h1 class="empty-title">统计没取到</h1>
            <p class="muted">服务端可能没开，或者这是 dev 模式（没有正式数据）。</p>
          </Panel>
        ) : !stats ? (
          <Panel class="empty-card">
            <p class="muted">载入中…</p>
          </Panel>
        ) : (
          <>
            <div class="stat-cards">
              {cards.map((card) => (
                <Panel key={card.label} class="stat-card">
                  <div class="stat-label">{card.label}</div>
                  <div class="stat-value mono">{card.value}</div>
                </Panel>
              ))}
            </div>

            <Panel label="BY MODEL · 按型号">
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
