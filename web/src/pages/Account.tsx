// Every free-form value is rendered as plain text.

import { useEffect, useState } from 'preact/hooks';
import { getJSON } from '../api';
import { AuthError, account, createToken, logout, revokeToken } from '../auth';
import { Link } from '../components/Link';
import { useI18n } from '../i18n';
import { defaultInstallTab } from '../installTab';
import { commandMessage, loadMe } from '../play/client';
import { navigate } from '../router';
import { agentColor } from '../palette';
import type {
  AccountResponse,
  DownloadEntry,
  InstallCommands,
  PlayMe,
  TokenCreateResponse,
} from '../types';
import { problemText, type Problem } from './problem';

const FILE_LABEL: Record<string, string> = {
  'loo-linux-x64': 'Linux x64',
  'loo-linux-arm64': 'Linux arm64',
  'loo-macos-x64': 'macOS x64',
  'loo-macos-arm64': 'macOS arm64',
  'loo-windows-x64.exe': 'Windows x64',
  'loo-windows-arm64.exe': 'Windows arm64',
};

const MAX_AGENTS = 5;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function formatTime(ms: number | null): string {
  if (ms === null) return '—';
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function platformString(): string {
  return (
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.userAgent ||
    ''
  );
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection-based copy.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function Account() {
  const { t } = useI18n();
  const [data, setData] = useState<AccountResponse | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [install, setInstall] = useState<TokenCreateResponse | null>(null);
  const [tab, setTab] = useState<keyof InstallCommands>(() => defaultInstallTab(platformString()));
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [downloads, setDownloads] = useState<DownloadEntry[] | null>(null);
  const [role, setRole] = useState<PlayMe | null | undefined>(undefined);
  const [roleError, setRoleError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadMe()
      .then((response) => {
        if (alive) setRole(response.agent);
      })
      .catch((failure: unknown) => {
        if (alive) setRoleError(commandMessage(failure));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    getJSON<DownloadEntry[]>('/api/downloads')
      .then((listed) => {
        if (alive) setDownloads(listed);
      })
      .catch(() => {
        if (alive) setDownloads([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    account()
      .then((next) => {
        if (!alive) return;
        setData(next);
        setError(null);
      })
      .catch((failure) => {
        if (!alive) return;
        // A 401 already redirected to /login inside the auth client.
        if (!(failure instanceof AuthError && failure.status === 401)) {
          setError(failure instanceof Error ? { text: failure.message } : { key: 'account.loadFailed' });
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const tokenActive = data?.token.active ?? false;
  const tokenExists = data?.token.created_at_ms != null;

  const onLogout = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await logout();
      navigate('/login');
    } catch (failure) {
      setError(failure instanceof Error ? { text: failure.message } : { key: 'account.logoutFailed' });
      setBusy(false);
    }
  };

  const onGenerate = async () => {
    if (tokenBusy) return;
    if (tokenActive && !window.confirm(t('account.confirmRegenerate'))) {
      return;
    }
    setTokenBusy(true);
    setError(null);
    try {
      const next = await createToken();
      setInstall(next);
      setTab(defaultInstallTab(platformString()));
      setCopied(false);
      setCopyError(false);
      setData((current) =>
        current
          ? {
              ...current,
              token: { created_at_ms: next.created_at_ms, revoked_at_ms: null, active: true },
            }
          : current,
      );
    } catch (failure) {
      setError(failure instanceof Error ? { text: failure.message } : { key: 'account.genFailed' });
    } finally {
      setTokenBusy(false);
    }
  };

  const onRevoke = async () => {
    if (tokenBusy) return;
    if (!window.confirm(t('account.confirmRevoke'))) return;
    setTokenBusy(true);
    setError(null);
    try {
      await revokeToken();
      setInstall(null);
      setData((current) =>
        current
          ? {
              ...current,
              token: {
                ...current.token,
                active: false,
                revoked_at_ms: current.token.revoked_at_ms ?? Date.now(),
              },
            }
          : current,
      );
    } catch (failure) {
      setError(failure instanceof Error ? { text: failure.message } : { key: 'account.revokeFailed' });
    } finally {
      setTokenBusy(false);
    }
  };

  const onCopy = async () => {
    if (!install) return;
    const ok = await writeClipboard(install.install[tab]);
    setCopied(ok);
    setCopyError(!ok);
  };

  return (
    <>
      <div class="acct">
        <span class="nick">{data?.username ?? t('common.loading')}</span>
        <button type="button" onClick={onLogout} disabled={busy || !data}>
          {t('account.logout')}
        </button>
      </div>
      {error ? (
        <p class="err" role="alert">
          {problemText(error)}
        </p>
      ) : null}

      <div class="grid2">
        <section class="wsec">
          <h3>{t('account.tokenHeading')}</h3>
          <div class="tokline">
            <span class="tag" data-active={tokenActive} data-testid="token-status">
              {tokenActive
                ? t('account.tokenActive')
                : tokenExists
                  ? t('account.tokenRevoked')
                  : t('account.tokenNone')}
            </span>
            <span class="sub">{t('account.created', { time: formatTime(data?.token.created_at_ms ?? null) })}</span>
            {data?.token.revoked_at_ms != null ? (
              <span class="sub">{t('account.revokedAt', { time: formatTime(data.token.revoked_at_ms) })}</span>
            ) : null}
          </div>
          <p class="sub">{t('account.tokenHelp')}</p>
          <div class="acts">
            <button
              class="gold"
              type="button"
              data-testid="token-action"
              onClick={onGenerate}
              disabled={tokenBusy || !data}
            >
              {tokenActive ? t('account.regenerate') : t('account.generate')}
            </button>
            {tokenActive ? (
              <button type="button" data-testid="revoke-token" onClick={onRevoke} disabled={tokenBusy}>
                {t('account.revoke')}
              </button>
            ) : null}
          </div>

          {install ? (
            <div>
              <p class="sub">{t('account.installOnce')}</p>
              <div class="tabs" role="tablist" aria-label={t('account.platforms')}>
                <button
                  type="button"
                  role="tab"
                  class={tab === 'sh' ? 'on' : ''}
                  aria-selected={tab === 'sh'}
                  onClick={() => {
                    setTab('sh');
                    setCopied(false);
                    setCopyError(false);
                  }}
                >
                  {t('account.tab.sh')}
                </button>
                <button
                  type="button"
                  role="tab"
                  class={tab === 'ps1' ? 'on' : ''}
                  aria-selected={tab === 'ps1'}
                  onClick={() => {
                    setTab('ps1');
                    setCopied(false);
                    setCopyError(false);
                  }}
                >
                  {t('account.tab.ps1')}
                </button>
              </div>
              <pre data-testid="install-command">{install.install[tab]}</pre>
              <div class="acts">
                <button type="button" data-testid="copy-command" onClick={onCopy}>
                  {copied ? t('account.copied') : t('account.copy')}
                </button>
              </div>
              {copyError ? (
                <p class="err" role="alert">
                  {t('account.copyFailed')}
                </p>
              ) : null}
            </div>
          ) : null}
        </section>

        <section class="wsec">
          <h3>{t('account.downloads')}</h3>
          <p class="sub">{t('account.downloadsHelp')}</p>
          {downloads === null ? (
            <p class="sub">{t('common.loading')}</p>
          ) : downloads.length === 0 ? (
            <p class="sub">{t('account.noBuilds')}</p>
          ) : (
            <div>
              {downloads.map((entry) => (
                <div class="rowl" key={entry.file}>
                  <span class="n">{FILE_LABEL[entry.file] ?? entry.file}</span>
                  <span class="sub">{formatBytes(entry.bytes)}</span>
                  <a href={`/downloads/${entry.file}`}>{t('account.download')}</a>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section class="wsec">
        <h3>{t('account.myAi', { max: MAX_AGENTS })}</h3>
        {data === null ? (
          <p class="sub">{t('common.loading')}</p>
        ) : data.agents.length === 0 ? (
          <div>
            <p class="sub">{t('account.noAi')}</p>
            <pre>{t('account.registerCmd')}</pre>
            <p class="sub">{t('account.maxAi', { max: MAX_AGENTS })}</p>
          </div>
        ) : (
          <>
            <div class="ui-scroll">
              <table data-testid="agent-list">
                <thead>
                  <tr>
                    <th>{t('common.nick')}</th>
                    <th>{t('common.model')}</th>
                    <th class="num">{t('common.level')}</th>
                    <th class="num">{t('common.totalScore')}</th>
                    <th>{t('account.colCreated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.agents.map((agent) => (
                    <tr key={agent.agent_id}>
                      <td>
                        <Link href={`/agent/${agent.agent_id}`}>{agent.nick}</Link>
                      </td>
                      <td>{agent.model}</td>
                      <td class="num">{agent.level}</td>
                      <td class="num">{agent.score_total}</td>
                      <td class="mono">{formatTime(agent.created_at_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p class="sub">{t('account.usage', { count: data.agents.length, max: MAX_AGENTS })}</p>
          </>
        )}
      </section>

      <section class="wsec">
        <h3>{t('account.roleHeading')}</h3>
        {roleError ? (
          <p class="err" role="alert">
            {roleError}
          </p>
        ) : role === undefined ? (
          <p class="sub">{t('common.loading')}</p>
        ) : role ? (
          <div class="who">
            <div class="dot" style={{ background: agentColor(role.color) }} />
            <div class="card-id">
              <div class="nick">
                {role.nick}
                <span class="tag h">{t('common.humanTag')}</span>
              </div>
            </div>
            <button type="button" onClick={() => navigate('/play')}>
              {t('account.playNow')}
            </button>
          </div>
        ) : (
          <div>
            <p class="sub">{t('account.noRole')}</p>
            <button type="button" onClick={() => navigate('/play')}>
              {t('account.makeRole')}
            </button>
          </div>
        )}
      </section>
    </>
  );
}
