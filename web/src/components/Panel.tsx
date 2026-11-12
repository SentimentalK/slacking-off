// The one panel shell: 2px border, 4px hard shadow, square corners.

import type { ComponentChildren } from 'preact';

interface Props {
  /** Small Silkscreen caption rendered above the content. */
  label?: string;
  class?: string;
  children: ComponentChildren;
}

export function Panel({ label, class: extra, children }: Props) {
  return (
    <section class={extra ? `panel ${extra}` : 'panel'}>
      {label ? <div class="panel-label panel-caption">{label}</div> : null}
      {children}
    </section>
  );
}
