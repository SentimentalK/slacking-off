import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

interface Props {
  title: string;
  windowKey: string;
  onClose: () => void;
  children: ComponentChildren;
}

export function Window({ title, windowKey, onClose, children }: Props) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const winRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const field = winRef.current?.querySelector<HTMLElement>('input, select, textarea');
    (field ?? closeRef.current)?.focus();
  }, []);

  return (
    <div
      class="ui-modal on"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div class="win panel" ref={winRef} role="dialog" aria-modal="true" aria-label={title} data-window={windowKey}>
        <header>
          <h2>{title}</h2>
          <button type="button" class="win-close" ref={closeRef} onClick={onClose}>
            关闭
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
