import { useEffect, useMemo, useState } from 'preact/hooks';
import { getJSON } from '../api';
import { useI18n, type Key } from '../i18n';
import { formatNumber, formatPercent } from '../labels';
import type { KindStats, StatsResponse } from '../types';

const SCOPES = [
  { key: 'all', label: 'stats.scope.all' },
  { key: 'mixed', label: 'stats.scope.mixed' },
] as const;

const PROMPT_FILTERS = [
  { key: 'any', label: 'stats.prompt.any' },
  { key: 'on', label: 'stats.prompt.on' },
  { key: 'off', label: 'stats.prompt.off' },
] as const;

type ScopeKey = (typeof SCOPES)[number]['key'];
type PromptKey = (typeof PROMPT_FILTERS)[number]['key'];

function KindCard({
  label,
  hint,
  stats,
}: {
  label: Key;
  hint: Key;
  stats: KindStats;
}) {
  const { t } = useI18n();
  return (
    <section class="wsec">
      <h3>{t(label)}</h3>
      <p class="sub">{t(hint)}</p>
      <div class="tiles six">
        <div class="tile">
          <b class="mono">{formatNumber(stats.agents)}</b>
          {t('stats.tile.agents')}
        </div>
        <div class="tile">
          <b class="mono">{formatNumber(stats.sessions)}</b>
          {t('stats.tile.sessions')}
        </div>
        <div class="tile">
          <b class="mono">{formatNumber(stats.successes)}</b>
          {t('stats.tile.successes')}
        </div>
        <div class="tile">
          <b class="mono">{formatPercent(stats.success_rate)}</b>
          {t('common.successRate')}
        </div>
        <div class="tile">
          <b class="mono">{formatNumber(stats.total_score)}</b>
          {t('common.totalScore')}
        </div>
        <div class="tile">
          <b class="mono">{formatNumber(stats.best_score)}</b>
          {t('common.bestRun')}
        </div>
      </div>
    </section>
  );
}

export function Stats() {
  const { t } = useI18n();
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
      <p class="note">{t('stats.loadFailed')}</p>
      <p class="sub">{t('stats.loadFailedHelp')}</p>
    </section>
  ) : !stats || !current ? (
    <p class="sub">{t('common.loading')}</p>
  ) : (
    <>
      <div class="tabs" role="tablist" aria-label={t('stats.scopeAria')}>
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
            {t(entry.label)}
          </button>
        ))}
      </div>

      <div class="tabs" role="tablist" aria-label={t('stats.promptAria')}>
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
            {t(entry.label)}
          </button>
        ))}
      </div>

      <div class="tiles two">
        <div class="tile">
          <b class="mono">{formatNumber(current.total_sessions)}</b>
          {t('stats.totalSessions')}
        </div>
        <div class="tile">
          <b class="mono">{formatPercent(current.success_rate)}</b>
          {t('stats.totalRate')}
        </div>
      </div>

      <div class="even">
        <KindCard label="stats.ai.label" hint="stats.ai.hint" stats={current.ai} />
        <KindCard label="stats.human.label" hint="stats.human.hint" stats={current.human} />
      </div>

      <section class="wsec">
        <h3>{t('stats.byModel')}</h3>
        {models.length === 0 ? (
          <p class="sub">{t('common.noData')}</p>
        ) : (
          <div class="ui-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('common.model')}</th>
                  <th class="num">{t('stats.aiCount')}</th>
                  <th class="num">{t('stats.sessionCount')}</th>
                  <th>{t('common.successRate')}</th>
                  <th class="num">{t('stats.totalScore')}</th>
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
