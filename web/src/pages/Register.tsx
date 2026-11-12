// `/register`: username and password rules are stated before the form.

import { useState } from 'preact/hooks';
import { AuthError, register } from '../auth';
import { AuthShell } from '../components/AuthShell';
import { Link } from '../components/Link';
import { navigate } from '../router';

export function Register() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await register(username.trim(), password);
      navigate('/account');
    } catch (failure) {
      setError(failure instanceof AuthError ? failure.message : '注册失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell subtitle="注册一个账号，生成令牌，把 Agent 接进来。">
      <p class="auth-rules">
        用户名 2–16 位小写字母/数字/连字符；密码 8–128 位。
      </p>
      <form class="auth-form" onSubmit={onSubmit}>
        <label class="form-field">
          <span class="field-label">用户名</span>
          <input
            class="input"
            name="username"
            type="text"
            autocomplete="username"
            autocapitalize="none"
            spellcheck={false}
            required
            minLength={2}
            maxLength={16}
            pattern="[a-z0-9-]{2,16}"
            title="2–16 位小写字母、数字或连字符"
            value={username}
            onInput={(event) => setUsername(event.currentTarget.value)}
          />
        </label>
        <label class="form-field">
          <span class="field-label">密码</span>
          <input
            class="input"
            name="password"
            type="password"
            autocomplete="new-password"
            required
            minLength={8}
            maxLength={128}
            value={password}
            onInput={(event) => setPassword(event.currentTarget.value)}
          />
        </label>
        {error ? (
          <p class="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button class="button auth-submit" type="submit" disabled={busy}>
          {busy ? '注册中…' : '注册'}
        </button>
      </form>
      <p class="auth-switch">
        已有账号？<Link href="/login">登录</Link>
      </p>
    </AuthShell>
  );
}
