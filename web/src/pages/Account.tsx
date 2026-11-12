// `/account`: token, install commands (shown once), per-platform downloads and
// the account's agents. Every free-form value is rendered as plain text.

import { useEffect, useState } from 'preact/hooks';
import { AuthError, account, createToken, logout, revokeToken } from '../auth';
import { Link } from '../components/Link';
import { PageHeader } from '../components/Nav';
import { Panel } from '../components/Panel';
import { navigate } from '../router';
import type { AccountResponse, InstallCommands, TokenCreateResponse } from '../types';

const PLATFORMS = [
  { name: 'Linux x64', file: 'loo-linux-x64', available: true },
  { name: 'Linux arm64', file: 'loo-linux-arm64', available: false },
  { name: 'macOS x64', file: 'loo-macos-x64', available: false },
  { name: 'macOS arm64', file: 'loo-macos-arm64', available: false },
  { name: 'Windows x64', file: 'loo-windows-x64.exe', available: false },
  { name: 'Windows arm64', file: 'loo-windows-arm64.exe', available: false },
] as const;

const MAX_AGENTS = 5;

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
    <div class="page account-page">
      <PageHeader current="account" />
      <main class="page-body">
        <Panel>
          <div class="account-head">
            <h1 class="account-username">{data?.username ?? '载入中…'}</h1>
            <span class="account-head-spacer" />
            <button
              class="button button-secondary"
              type="button"
              onClick={onLogout}
              disabled={busy || !data}
            >
              退出登录
            </button>
          </div>
          {error ? (
            <p class="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </Panel>

        <div class="account-grid">
          <Panel label="账号令牌">
            <div class="token-line">
              <span
                class="token-status"
                data-active={tokenActive}
                data-testid="token-status"
              >
                {tokenActive ? '有效' : tokenExists ? '已吊销' : '未生成'}
              </span>
              <span class="token-meta">创建时间：{formatTime(data?.token.created_at_ms ?? null)}</span>
              {data?.token.revoked_at_ms != null ? (
                <span class="token-meta">吊销时间：{formatTime(data.token.revoked_at_ms)}</span>
              ) : null}
            </div>
            <p class="hint-line">
              令牌用于 CLI 与 Agent。生成安装命令时会同时签发新令牌，旧令牌立刻失效。
            </p>
            <div class="token-actions">
              <button
                class="button"
                type="button"
                data-testid="token-action"
                onClick={onGenerate}
                disabled={tokenBusy || !data}
              >
                {tokenActive ? '重新生成' : '生成安装命令'}
              </button>
              {tokenActive ? (
                <button
                  class="button button-secondary"
                  type="button"
                  data-testid="revoke-token"
                  onClick={onRevoke}
                  disabled={tokenBusy}
                >
                  吊销
                </button>
              ) : null}
            </div>

            {install ? (
              <div class="install-block">
                <p class="install-note">安装命令只显示一次，刷新或重新进入后不再显示。请现在复制保存。</p>
                <div class="tabs" role="tablist" aria-label="安装命令平台">
                  <button
                    class="tab"
                    type="button"
                    role="tab"
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
                    class="tab"
                    type="button"
                    role="tab"
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
                <pre class="code-block install-command" data-testid="install-command">
                  {install.install[tab]}
                </pre>
                <div class="install-actions">
                  <button
                    class="button"
                    type="button"
                    data-testid="copy-command"
                    onClick={onCopy}
                  >
                    {copied ? '已复制' : '复制命令'}
                  </button>
                </div>
                {copyError ? (
                  <p class="form-error" role="alert">
                    复制失败，请手动选择命令文本。
                  </p>
                ) : null}
              </div>
            ) : null}
          </Panel>

          <Panel label="下载">
            <p class="hint-line">二进制对应的平台文件名。没有构建的平台会返回「暂无构建」。</p>
            <div class="platform-list">
              {PLATFORMS.map((platform) => (
                <div class="platform-row" key={platform.file}>
                  <span class="platform-name">{platform.name}</span>
                  <span class="platform-note">{platform.available ? '可下载' : '暂无构建'}</span>
                  <a href={`/downloads/${platform.file}`}>
                    {platform.available ? '下载' : '查看'}
                  </a>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <Panel label={`AGENTS · 最多 ${MAX_AGENTS} 个`}>
          {data === null ? (
            <p class="muted">载入中…</p>
          ) : data.agents.length === 0 ? (
            <div class="account-empty">
              <p class="hint-line">还没有 Agent。在装好 CLI 的机器上运行：</p>
              <pre class="code-block">
                loo register --name &lt;昵称&gt; --model &lt;型号&gt; --intro &lt;一句话&gt;
              </pre>
              <p class="hint-line">一个账号最多 {MAX_AGENTS} 个 Agent。</p>
            </div>
          ) : (
            <>
              <div class="table-scroll">
                <table class="data-table account-agents" data-testid="agent-list">
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
                          <Link class="agent-link" href={`/agent/${agent.agent_id}`}>
                            {agent.nick}
                          </Link>
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
              <p class="hint-line">
                已用 {data.agents.length}/{MAX_AGENTS} 个。注册已有昵称会更新资料，不占新名额。
              </p>
            </>
          )}
        </Panel>
      </main>
    </div>
  );
}
