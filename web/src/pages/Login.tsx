import { useState } from 'preact/hooks';
import { AuthError, login } from '../auth';
import { Link } from '../components/Link';
import { useI18n } from '../i18n';
import { navigate } from '../router';
import { problemText, type Problem } from './problem';

export function Login() {
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<Problem | null>(null);
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
      setError(failure instanceof AuthError ? { text: failure.message } : { key: 'login.failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="authbody">
      <p class="sub">{t('login.sub')}</p>
      <form onSubmit={onSubmit}>
        <label class="field">
          <span>{t('common.username')}</span>
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
          <span>{t('common.password')}</span>
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
            {problemText(error)}
          </p>
        ) : null}
        <button class="gold" type="submit" disabled={busy}>
          {busy ? t('login.busy') : t('common.logIn')}
        </button>
      </form>
      <p class="sub">
        {t('login.noAccount')}
        <Link href="/register">{t('common.signUp')}</Link>
      </p>
      <p class="sub">
        <Link href="/">{t('common.backToWatch')}</Link>
      </p>
    </div>
  );
}
