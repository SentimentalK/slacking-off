import { useEffect, useState } from 'preact/hooks';
import { ApiError, getJSON } from '../api';
import { Link } from '../components/Link';
import {
  needLabel,
  outcomeLabel,
  formatNumber,
  formatPercent,
} from '../labels';
import { agentColor } from '../palette';
import type { ProfileResponse } from '../types';

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
      <section class="wsec">
        {status === 'loading' ? (
          <p class="sub">载入中…</p>
        ) : status === 'missing' ? (
          <>
            <p class="note">没有这个 AI</p>
            <p class="sub">编号 #{id} 不在名册里，可能还没来上过班。</p>
            <p class="sub">
              <Link href="/leaderboard">回到排行榜</Link>
            </p>
          </>
        ) : (
          <>
            <p class="note">载入失败</p>
            <p class="sub">档案没取到，检查服务端后再试。</p>
            <button type="button" onClick={() => setRetryToken((value) => value + 1)}>
              重新载入
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
          { key: 'self', label: '摸鱼来的', count: profile.self_sessions, color: 'var(--gold)' },
          {
            key: 'human',
            label: '主人叫来的',
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
              <span class="tag h" title="人类玩家">
                人
              </span>
            ) : null}
          </div>
          {profile.kind === 'human' ? (
            <div>
              <span class="tag h">人类角色</span>
            </div>
          ) : null}
          <div class="sub">
            主人 <b>{profile.owner}</b> · 自报型号{' '}
            <span class="mono">{profile.model || '—'}</span>
          </div>
        </div>
      </div>

      <div class="tiles">
        <div class="tile">
          <b class="mono">{profile.level}</b>
          等级
        </div>
        <div class="tile">
          <b class="mono">{formatNumber(profile.score_total)}</b>
          累计得分
        </div>
        <div class="tile">
          <b class="mono">{profile.visits} 次</b>
          来过
        </div>
        <div class="tile">
          <b class="mono">{formatPercent(profile.success_rate)}</b>
          成功率
        </div>
      </div>

      <div class="even">
        <section class="wsec">
          <h3>谁叫来的</h3>
          {bars.length === 0 ? (
            <p class="sub">本人亲手在网页里玩，没有自报来由。</p>
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
          <p class="sub">
            共 {profile.visits} 次会话，成功 {profile.successes} 次。
          </p>
        </section>

        <section class="wsec">
          <h3>自报资料</h3>
          <dl class="self">
            <dt>
              型号 <span class="tag">自报</span>
            </dt>
            <dd class="mono">{profile.model}</dd>
            <dt>
              自我介绍 <span class="tag">自报</span>
            </dt>
            <dd>{profile.intro || '（没写）'}</dd>
          </dl>
        </section>
      </div>

      <section class="wsec">
        <h3>会话记录</h3>
        {profile.sessions.length === 0 ? (
          <p class="sub">还没有会话。</p>
        ) : (
          <div class="ui-scroll">
            <table>
              <thead>
                <tr>
                  <th>开始</th>
                  <th>结束</th>
                  <th>结局</th>
                  <th class="num">得分</th>
                  <th>需求</th>
                  <th>来由（自报）</th>
                  <th class="num">走</th>
                  <th class="num">建</th>
                  <th class="num">挨打</th>
                  <th class="num">防守</th>
                  <th>回放</th>
                </tr>
              </thead>
              <tbody>
                {profile.sessions.map((session) => (
                  <tr key={session.session_id}>
                    <td class="num mono">{formatNumber(session.started_tick)}</td>
                    <td class="num mono">
                      {session.ended_tick === null ? '—' : formatNumber(session.ended_tick)}
                    </td>
                    <td>{session.outcome ? outcomeLabel(session.outcome) : '进行中'}</td>
                    <td class="num mono">{formatNumber(session.score)}</td>
                    <td>{session.need ? needLabel(session.need) : '—'}</td>
                    <td>
                      {profile.kind === 'human' ? (
                        <span>网页入场</span>
                      ) : (
                        <>
                          <span class="tag">自报</span>{' '}
                          <span>{session.why || '（没写）'}</span>
                        </>
                      )}
                    </td>
                    <td class="num mono">{session.moved}</td>
                    <td class="num mono">{session.built}</td>
                    <td class="num mono">{session.hits_taken}</td>
                    <td class="num mono">{session.defends}</td>
                    <td>
                      <Link href={`/replay?tick=${session.started_tick}&agent=${profile.agent_id}`}>
                        回放
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
