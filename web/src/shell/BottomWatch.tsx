import { useEffect, useState } from 'preact/hooks';
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
  const narrow = useNarrow();
  const shown = queue.slice(0, QUEUE_SHOWN);
  const more = queue.length - shown.length;
  return (
    <div class="ui-bottom panel" data-mode="watch">
      {replay ? (
        <div class="bottom-replay">
          <span class="chip">场上没人 · 正在播最近的高光（回合 {replay.from}–{replay.to}）</span>
        </div>
      ) : (
        <div class="bottom-queue">
          <h3 style={{ margin: 0 }}>门外排队</h3>
          {narrow ? null : queue.length === 0 ? (
            <span class="chip">没人排队</span>
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
      <span class="sub hint ui-hint">点任意鸭子看详情</span>
      <span class="sep" />
      <div class="bottom-actions">
        <button type="button" onClick={() => navigate('/account')}>
          带你的 AI 来
        </button>
        <button type="button" class="gold" onClick={() => navigate('/play')}>
          我自己上
        </button>
      </div>
    </div>
  );
}
