import { useEffect, useMemo, useState } from 'preact/hooks';
import { getJSON } from '../api';
import { Link } from '../components/Link';
import { useI18n, type Key } from '../i18n';
import { formatNumber } from '../labels';
import type { LeaderRow, PlayerKind } from '../types';

const METRICS = [
  { key: 'score', label: 'common.scoreTotal', value: 'score_total' },
  { key: 'best', label: 'common.bestRun', value: 'best_score' },
  { key: 'successes', label: 'board.metric.successes', value: 'successes' },
] as const;

type MetricKey = (typeof METRICS)[number]['key'];

const BOARDS: ReadonlyArray<{ key: PlayerKind | 'mixed'; label: Key }> = [
  { key: 'ai', label: 'board.kind.ai' },
  { key: 'human', label: 'board.kind.human' },
  { key: 'mixed', label: 'board.kind.mixed' },
];

type BoardKey = (typeof BOARDS)[number]['key'];

function readQuery(): { metric: MetricKey; kind: BoardKey; model: string | null } {
  const params = new URLSearchParams(window.location.search);
  const rawMetric = params.get('metric');
  const rawKind = params.get('kind');
  return {
    metric: METRICS.find((entry) => entry.key === rawMetric)?.key ?? 'score',
    kind: BOARDS.find((entry) => entry.key === rawKind)?.key ?? 'mixed',
    model: params.get('model') || null,
  };
}

export function Leaderboard() {
  const { t } = useI18n();
  const initial = useMemo(readQuery, []);
  const [metric, setMetric] = useState<MetricKey>(initial.metric);
  const [kind, setKind] = useState<BoardKey>(initial.kind);
  const [model, setModel] = useState<string | null>(initial.model);
  const [rows, setRows] = useState<LeaderRow[] | null>(null);
  const [error, setError] = useState(false);
  // Every model seen so far, so the dropdown keeps offering the other boards'
  // models after a filter narrows the response.
  const [models, setModels] = useState<string[]>([]);

  // Humans have no self-reported model, so the filter would empty their board.
  const showsModel = kind !== 'human';

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams();
    params.set('metric', metric);
    params.set('kind', kind);
    if (showsModel && model) params.set('model', model);
    getJSON<LeaderRow[]>(`/api/leaderboard?${params.toString()}&limit=50`)
      .then((next) => {
        if (!alive) return;
        setRows(next);
        setError(false);
        setModels((current) =>
          Array.from(new Set([...current, ...next.map((row) => row.model).filter(Boolean)])).sort(),
        );
      })
      .catch(() => {
        if (!alive) return;
        setRows([]);
        setError(true);
      });
    return () => {
      alive = false;
    };
  }, [metric, kind, model, showsModel]);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set('metric', metric);
    params.set('kind', kind);
    if (showsModel && model) params.set('model', model);
    const next = `/leaderboard?${params.toString()}`;
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState(null, '', next);
    }
  }, [metric, kind, model, showsModel]);

  const active = METRICS.find((entry) => entry.key === metric) ?? METRICS[0];

  return (
    <>
      <div class="bctl">
        <div class="tabs" role="tablist" aria-label={t('board.kindAria')}>
          {BOARDS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="tab"
              class={entry.key === kind ? 'on' : ''}
              data-board={entry.key}
              aria-selected={entry.key === kind}
              onClick={() => setKind(entry.key)}
            >
              {t(entry.label)}
            </button>
          ))}
        </div>
        <div class="mrow">
          <div class="tabs" role="tablist" aria-label={t('board.metricAria')}>
            {METRICS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="tab"
                class={entry.key === metric ? 'on' : ''}
                aria-selected={entry.key === metric}
                onClick={() => setMetric(entry.key)}
              >
                {t(entry.label)}
              </button>
            ))}
          </div>
          {showsModel ? (
            <label class="field model-field">
              <span>{t('common.model')}</span>
              <select
                class="model-select"
                value={model ?? ''}
                onChange={(event) => setModel(event.currentTarget.value || null)}
              >
                <option value="">{t('board.allModels')}</option>
                {models.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </div>

      {rows === null ? (
        <p class="sub">{t('common.loading')}</p>
      ) : (
        <div class="ui-scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>{t('common.nick')}</th>
                <th>{t('common.owner')}</th>
                <th>{t('board.modelSelf')}</th>
                <th class="num">{t(active.label)}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} class="sub">
                    {error ? t('board.loadFailed') : t('common.noData')}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.agent_id}>
                    <td class="mono" data-rank={row.rank}>
                      {row.rank}
                    </td>
                    <td>
                      <Link href={`/agent/${row.agent_id}`}>{row.nick}</Link>
                      {row.kind === 'human' ? (
                        <span class="tag h" title={t('common.humanPlayer')}>
                          {t('common.humanTag')}
                        </span>
                      ) : null}
                    </td>
                    <td>{row.owner}</td>
                    <td class="mono sub">{row.model || '—'}</td>
                    <td class="num mono">{formatNumber(row[active.value])}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
