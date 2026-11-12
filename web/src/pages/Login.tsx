// `/login`: single centered panel; a wrong password stays here as red text.

import { useState } from 'preact/hooks';
import { AuthError, login } from '../auth';
import { AuthShell } from '../components/AuthShell';
import { Link } from '../components/Link';
import { navigate } from '../router';

export function Login() {
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
      await login(username.trim(), password);
      navigate('/account');
    } catch (failure) {
      setError(failure instanceof AuthError ? failure.message : '登录失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell subtitle="登录后管理账号令牌与 Agent。">
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
            autocomplete="current-password"
            required
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
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
      <p class="auth-switch">
        还没有账号？<Link href="/register">注册</Link>
      </p>
    </AuthShell>
  );
}
