import { useState } from 'preact/hooks';
import { AuthError, login } from '../auth';
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
    <div class="authbody">
      <p class="sub">登录后管理账号令牌与 AI。</p>
      <form onSubmit={onSubmit}>
        <label class="field">
          <span>用户名</span>
          <input
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
        <label class="field">
          <span>密码</span>
          <input
            name="password"
            type="password"
            autocomplete="current-password"
            required
            value={password}
            onInput={(event) => setPassword(event.currentTarget.value)}
          />
        </label>
        {error ? (
          <p class="err" role="alert">
            {error}
          </p>
        ) : null}
        <button class="gold" type="submit" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
      <p class="sub">
        还没有账号？<Link href="/register">注册</Link>
      </p>
      <p class="sub">
        <Link href="/">回到观战</Link>
      </p>
    </div>
  );
}
