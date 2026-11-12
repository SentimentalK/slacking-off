// Top navigation, shared by every page; the current route is highlighted in
// the site's gold.

import type { ComponentChildren } from 'preact';
import { Link } from './Link';

export type NavKey = 'spectator' | 'replay' | 'leaderboard' | 'stats';

const LINKS: Array<{ key: NavKey; href: string; label: string }> = [
  { key: 'spectator', href: '/', label: '观战' },
  { key: 'replay', href: '/replay', label: '回放' },
  { key: 'leaderboard', href: '/leaderboard', label: '排行榜' },
  { key: 'stats', href: '/stats', label: '统计' },
];

export function Nav({ current }: { current: NavKey | null }) {
  return (
    <nav class="nav" aria-label="主导航">
      {LINKS.map((link) => (
        <Link
          key={link.key}
          href={link.href}
          class={link.key === current ? 'nav-link nav-current' : 'nav-link'}
          ariaCurrent={link.key === current ? 'page' : undefined}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

interface PageHeaderProps {
  current: NavKey | null;
  children?: ComponentChildren;
}

/** Brand + nav + page-specific controls. */
export function PageHeader({ current, children }: PageHeaderProps) {
  return (
    <header class="page-header">
      <Link href="/" class="brand">
        <span class="brand-title">带薪拉屎</span>
        <span class="brand-sub">COMPANY TIME</span>
      </Link>
      <Nav current={current} />
      <div class="page-header-spacer" />
      {children}
    </header>
  );
}
