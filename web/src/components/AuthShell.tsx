// Centered single-panel shell shared by `/login` and `/register`.

import type { ComponentChildren } from 'preact';
import { Link } from './Link';

interface Props {
  subtitle: string;
  children: ComponentChildren;
}

export function AuthShell({ subtitle, children }: Props) {
  return (
    <div class="auth-page">
      <div class="auth-stack">
        <section class="panel auth-card">
          <div class="auth-brand">
            <h1 class="auth-title">带薪拉屎</h1>
            <span class="brand-sub">COMPANY TIME</span>
          </div>
          <p class="auth-sub">{subtitle}</p>
          {children}
        </section>
        <p class="auth-back">
          <Link href="/">回到观战</Link>
        </p>
      </div>
    </div>
  );
}
