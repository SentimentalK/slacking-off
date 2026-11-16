import { useEffect, useState } from 'preact/hooks';
import { ApiError, getJSON } from '../api';
import { Link } from '../components/Link';
import { useI18n } from '../i18n';
import {
  needLabel,
  outcomeLabel,
  sentByLabel,
  formatNumber,
  formatPercent,
} from '../labels';
import { agentColor } from '../palette';
import type { ProfileResponse } from '../types';

type Status = 'loading' | 'ready' | 'missing' | 'error';

export function Profile({ id }: { id: number }) {
  const { t, tn } = useI18n();
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
      <section class="wsec">
        {status === 'loading' ? (
          <p class="sub">{t('common.loading')}</p>
        ) : status === 'missing' ? (
          <>
            <p class="note">{t('profile.missing')}</p>
            <p class="sub">{t('profile.missingHelp', { id })}</p>
            <p class="sub">
              <Link href="/leaderboard">{t('profile.backToBoard')}</Link>
            </p>
          </>
        ) : (
          <>
            <p class="note">{t('profile.loadFailed')}</p>
            <p class="sub">{t('profile.loadFailedHelp')}</p>
            <button type="button" onClick={() => setRetryToken((value) => value + 1)}>
              {t('profile.reload')}
            </button>
          </>
        )}
      </section>
    );
  }

  // A person types no `why` and is neither `self` nor `human`-sent: the
  // self-reported distribution means nothing for them (contract-J §6).
  const total = profile.self_sessions + profile.human_sessions;
  const bars =
    profile.kind === 'human'
      ? []
      : [
          { key: 'self', label: sentByLabel('self'), count: profile.self_sessions, color: 'var(--gold)' },
          {
            key: 'human',
            label: sentByLabel('human'),
            count: profile.human_sessions,
            color: 'var(--blue)',
          },
        ];

  return (
    <>
      <div class="who">
        <div class="dot" style={{ background: agentColor(profile.agent_id) }} />
        <div>
          <div class="nick">
            {profile.nick}
            {profile.kind === 'human' ? (
              <span class="tag h" title={t('common.humanPlayer')}>
                {t('common.humanTag')}
              </span>
            ) : null}
          </div>
          {profile.kind === 'human' ? (
            <div>
              <span class="tag h">{t('profile.humanRole')}</span>
            </div>
          ) : null}
          <div class="sub">
            {t('common.owner')} <b>{profile.owner}</b> · {t('profile.selfModel')}{' '}
            <span class="mono">{profile.model || '—'}</span>
          </div>
        </div>
      </div>

      <div class="tiles">
        <div class="tile">
          <b class="mono">{profile.level}</b>
          {t('common.level')}
        </div>
        <div class="tile">
          <b class="mono">{formatNumber(profile.score_total)}</b>
          {t('common.scoreTotal')}
        </div>
        <div class="tile">
          <b class="mono">{tn('profile.visits', profile.visits)}</b>
          {t('profile.visited')}
        </div>
        <div class="tile">
          <b class="mono">{formatPercent(profile.success_rate)}</b>
          {t('common.successRate')}
        </div>
      </div>

      <div class="even">
        <section class="wsec">
          <h3>{t('profile.whoSent')}</h3>
          {bars.length === 0 ? (
            <p class="sub">{t('profile.webOnly')}</p>
          ) : (
            <>
              {bars.map((bar) => (
                <div class="hb" key={bar.key}>
                  <span>{bar.label}</span>
                  <div class="bar">
                    <i
                      style={{
                        width: `${total > 0 ? (bar.count / total) * 100 : 0}%`,
                        background: bar.color,
                      }}
                    />
                  </div>
                  <b class="mono">{bar.count}</b>
                </div>
              ))}
            </>
          )}
          <p class="sub">{t('profile.summary', { visits: profile.visits, successes: profile.successes })}</p>
        </section>

        <section class="wsec">
          <h3>{t('profile.selfInfo')}</h3>
          <dl class="self">
            <dt>
              {t('common.model')} <span class="tag">{t('common.selfTag')}</span>
            </dt>
            <dd class="mono">{profile.model}</dd>
            <dt>
              {t('profile.intro')} <span class="tag">{t('common.selfTag')}</span>
            </dt>
            <dd>{profile.intro || t('profile.unwritten')}</dd>
          </dl>
        </section>
      </div>

      <section class="wsec">
        <h3>{t('profile.sessions')}</h3>
        {profile.sessions.length === 0 ? (
          <p class="sub">{t('profile.noSessions')}</p>
        ) : (
          <div class="ui-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('profile.colStart')}</th>
                  <th>{t('profile.colEnd')}</th>
                  <th>{t('profile.colOutcome')}</th>
                  <th class="num">{t('profile.colScore')}</th>
                  <th>{t('profile.colNeed')}</th>
                  <th>{t('profile.colWhy')}</th>
                  <th class="num">{t('profile.colMoved')}</th>
                  <th class="num">{t('profile.colBuilt')}</th>
                  <th class="num">{t('profile.colHits')}</th>
                  <th class="num">{t('profile.colDefends')}</th>
                  <th>{t('profile.replay')}</th>
                </tr>
              </thead>
              <tbody>
                {profile.sessions.map((session) => (
                  <tr key={session.session_id}>
                    <td class="num mono">{formatNumber(session.started_tick)}</td>
                    <td class="num mono">
                      {session.ended_tick === null ? '—' : formatNumber(session.ended_tick)}
                    </td>
                    <td>{session.outcome ? outcomeLabel(session.outcome) : t('profile.inProgress')}</td>
                    <td class="num mono">{formatNumber(session.score)}</td>
                    <td>{session.need ? needLabel(session.need) : '—'}</td>
                    <td>
                      {profile.kind === 'human' ? (
                        <span>{t('profile.webJoin')}</span>
                      ) : (
                        <>
                          <span class="tag">{t('common.selfTag')}</span>{' '}
                          <span>{session.why || t('profile.unwritten')}</span>
                        </>
                      )}
                    </td>
                    <td class="num mono">{session.moved}</td>
                    <td class="num mono">{session.built}</td>
                    <td class="num mono">{session.hits_taken}</td>
                    <td class="num mono">{session.defends}</td>
                    <td>
                      <Link href={`/replay?tick=${session.started_tick}&agent=${profile.agent_id}`}>
                        {t('profile.replay')}
                      </Link>
                    </td>
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
