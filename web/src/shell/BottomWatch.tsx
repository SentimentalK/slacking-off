import { useEffect, useState } from 'preact/hooks';
import { useI18n } from '../i18n';
import { navigate } from '../router';
import type { ProjectionQueueEntry } from '../types';

const QUEUE_SHOWN = 3;
const NARROW_QUERY = '(max-width: 700px)';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}

interface Props {
  queue: ProjectionQueueEntry[];
  replay: { from: number; to: number } | null;
}

export function BottomWatch({ queue, replay }: Props) {
  const { t } = useI18n();
  const narrow = useNarrow();
  const shown = queue.slice(0, QUEUE_SHOWN);
  const more = queue.length - shown.length;
  return (
    <div class="ui-bottom panel" data-mode="watch" title={t('watch.hint')}>
      {replay ? (
        <div class="bottom-replay">
          <span class="chip">{t('watch.replay', { from: replay.from, to: replay.to })}</span>
        </div>
      ) : (
        <div class="bottom-queue">
          <h3 style={{ margin: 0 }}>{t('watch.queue')}</h3>
          {narrow ? null : queue.length === 0 ? (
            <span class="chip">{t('watch.queueEmpty')}</span>
          ) : (
            shown.map((entry) => (
              <span class="chip" key={entry.id}>
                {entry.index} · {entry.nick}
              </span>
            ))
          )}
          {narrow || more === 0 ? null : <span class="chip">+{more}</span>}
        </div>
      )}
      <span class="sep" />
      <div class="bottom-actions">
        <button type="button" onClick={() => navigate('/account')}>
          {t('watch.bringAi')}
        </button>
        <button type="button" class="gold" onClick={() => navigate('/play')}>
          {t('top.play')}
        </button>
      </div>
    </div>
  );
}
