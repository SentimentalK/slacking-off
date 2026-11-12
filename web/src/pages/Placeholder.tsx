import { navigate } from '../router';

interface Props {
  title: string;
  note: string;
}

/** Route stub: the E1/E2 shell is real, these pages arrive in E3. */
export function Placeholder({ title, note }: Props) {
  return (
    <main class="placeholder">
      <h1>{title}</h1>
      <p>建设中</p>
      <p class="muted">{note}</p>
      <a
        href="/"
        onClick={(event) => {
          event.preventDefault();
          navigate('/');
        }}
      >
        ← 返回观战
      </a>
    </main>
  );
}
