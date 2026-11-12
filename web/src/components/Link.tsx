// Internal link: an anchor that stays a real link (middle-click, copy URL)
// but routes through the history router on a plain left click.

import type { ComponentChildren } from 'preact';
import { navigate } from '../router';

interface Props {
  href: string;
  class?: string;
  title?: string;
  ariaCurrent?: 'page';
  children: ComponentChildren;
}

export function Link({ href, class: className, title, ariaCurrent, children }: Props) {
  return (
    <a
      href={href}
      class={className}
      title={title}
      aria-current={ariaCurrent}
      onClick={(event) => {
        const mouse = event as unknown as MouseEvent;
        if (mouse.defaultPrevented || mouse.button !== 0) return;
        if (mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.altKey) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
