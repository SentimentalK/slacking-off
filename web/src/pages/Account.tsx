// Every free-form value is rendered as plain text.

import { useEffect, useState } from 'preact/hooks';
import { getJSON } from '../api';
import { AuthError, account, createToken, logout, revokeToken } from '../auth';
import { Link } from '../components/Link';
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
  const [data, setData] = useState<AccountResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [install, setInstall] = useState<TokenCreateResponse | null>(null);
  const [tab, setTab] = useState<keyof InstallCommands>('sh');
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
          setError(failure instanceof Error ? failure.message : '账号信息没取到');
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
      setError(failure instanceof Error ? failure.message : '退出失败');
      setBusy(false);
    }
  };

  const onGenerate = async () => {
    if (tokenBusy) return;
    if (tokenActive && !window.confirm('重新生成会让旧令牌立即失效，正在运行的 Agent 需要换新命令。继续？')) {
      return;
    }
    setTokenBusy(true);
    setError(null);
    try {
      const next = await createToken();
      setInstall(next);
      setTab('sh');
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
      setError(failure instanceof Error ? failure.message : '生成令牌失败');
    } finally {
      setTokenBusy(false);
    }
  };

  const onRevoke = async () => {
    if (tokenBusy) return;
    if (!window.confirm('吊销后，使用这个令牌的 Agent 会失去鉴权。继续？')) return;
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
      setError(failure instanceof Error ? failure.message : '吊销令牌失败');
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
        <span class="nick">{data?.username ?? '载入中…'}</span>
        <button type="button" onClick={onLogout} disabled={busy || !data}>
          退出登录
        </button>
      </div>
      {error ? (
        <p class="err" role="alert">
          {error}
        </p>
      ) : null}

      <div class="grid2">
        <section class="wsec">
          <h3>账号令牌</h3>
          <div class="tokline">
            <span class="tag" data-active={tokenActive} data-testid="token-status">
              {tokenActive ? '有效' : tokenExists ? '已吊销' : '未生成'}
            </span>
            <span class="sub">创建时间：{formatTime(data?.token.created_at_ms ?? null)}</span>
            {data?.token.revoked_at_ms != null ? (
              <span class="sub">吊销时间：{formatTime(data.token.revoked_at_ms)}</span>
            ) : null}
          </div>
          <p class="sub">令牌用于 CLI 与 Agent。生成安装命令时会同时签发新令牌，旧令牌立刻失效。</p>
          <div class="acts">
            <button
              class="gold"
              type="button"
              data-testid="token-action"
              onClick={onGenerate}
              disabled={tokenBusy || !data}
            >
              {tokenActive ? '重新生成' : '生成安装命令'}
            </button>
            {tokenActive ? (
              <button type="button" data-testid="revoke-token" onClick={onRevoke} disabled={tokenBusy}>
                吊销
              </button>
            ) : null}
          </div>

          {install ? (
            <div>
              <p class="sub">安装命令只显示一次，刷新或重新进入后不再显示。请现在复制保存。</p>
              <div class="tabs" role="tablist" aria-label="安装命令平台">
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
                  sh · Linux / macOS
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
                  ps1 · Windows
                </button>
              </div>
              <pre data-testid="install-command">{install.install[tab]}</pre>
              <div class="acts">
                <button type="button" data-testid="copy-command" onClick={onCopy}>
                  {copied ? '已复制' : '复制命令'}
                </button>
              </div>
              {copyError ? (
                <p class="err" role="alert">
                  复制失败，请手动选择命令文本。
                </p>
              ) : null}
            </div>
          ) : null}
        </section>

        <section class="wsec">
          <h3>下载</h3>
          <p class="sub">二进制对应的平台文件名。只列出这台服务器上真实存在的构建。</p>
          {downloads === null ? (
            <p class="sub">载入中…</p>
          ) : downloads.length === 0 ? (
            <p class="sub">暂无构建</p>
          ) : (
            <div>
              {downloads.map((entry) => (
                <div class="rowl" key={entry.file}>
                  <span class="n">{FILE_LABEL[entry.file] ?? entry.file}</span>
                  <span class="sub">{formatBytes(entry.bytes)}</span>
                  <a href={`/downloads/${entry.file}`}>下载</a>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section class="wsec">
        <h3>{`AGENTS · 最多 ${MAX_AGENTS} 个`}</h3>
        {data === null ? (
          <p class="sub">载入中…</p>
        ) : data.agents.length === 0 ? (
          <div>
            <p class="sub">还没有 Agent。在装好 CLI 的机器上运行：</p>
            <pre>
              loo register --name &lt;昵称&gt; --model &lt;型号&gt; --intro &lt;一句话&gt;
            </pre>
            <p class="sub">一个账号最多 {MAX_AGENTS} 个 Agent。</p>
          </div>
        ) : (
          <>
            <div class="ui-scroll">
              <table data-testid="agent-list">
                <thead>
                  <tr>
                    <th>昵称</th>
                    <th>型号</th>
                    <th class="num">等级</th>
                    <th class="num">累计分</th>
                    <th>创建时间</th>
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
            <p class="sub">
              已用 {data.agents.length}/{MAX_AGENTS} 个。注册已有昵称会更新资料，不占新名额。
            </p>
          </>
        )}
      </section>

      <section class="wsec">
        <h3>你自己的角色</h3>
        {roleError ? (
          <p class="err" role="alert">
            {roleError}
          </p>
        ) : role === undefined ? (
          <p class="sub">载入中…</p>
        ) : role ? (
          <div class="who">
            <div class="dot" style={{ background: agentColor(role.color) }} />
            <div class="card-id">
              <div class="nick">
                {role.nick}
                <span class="tag h">人</span>
              </div>
            </div>
            <button type="button" onClick={() => navigate('/play')}>
              去上场
            </button>
          </div>
        ) : (
          <div>
            <p class="sub">还没有角色。</p>
            <button type="button" onClick={() => navigate('/play')}>
              建角色
            </button>
          </div>
        )}
      </section>
    </>
  );
}
