import { useState } from 'preact/hooks';
import { AuthError, register } from '../auth';
import { Link } from '../components/Link';
import { useI18n } from '../i18n';
import { navigate } from '../router';
import { problemText, type Problem } from './problem';

export function Register() {
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
      await register(username.trim(), password);
      navigate('/account');
    } catch (failure) {
      setError(failure instanceof AuthError ? { text: failure.message } : { key: 'register.failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="authbody">
      <p class="sub">{t('register.sub')}</p>
      <p class="sub">{t('register.rules')}</p>
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
            minLength={2}
            maxLength={16}
            pattern="[a-z0-9\-]{2,16}"
            title={t('register.usernameTitle')}
            value={username}
            onInput={(event) => setUsername(event.currentTarget.value)}
          />
        </label>
        <label class="field">
          <span>{t('common.password')}</span>
          <input
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
          <p class="err" role="alert">
            {problemText(error)}
          </p>
        ) : null}
        <button class="gold" type="submit" disabled={busy}>
          {busy ? t('register.busy') : t('common.signUp')}
        </button>
      </form>
      <p class="sub">
        {t('register.hasAccount')}
        <Link href="/login">{t('common.logIn')}</Link>
      </p>
      <p class="sub">
        <Link href="/">{t('common.backToWatch')}</Link>
      </p>
    </div>
  );
}
