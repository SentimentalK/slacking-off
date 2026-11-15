import { navigate } from '../router';
import type { ProjectionQueueEntry } from '../types';

const QUEUE_SHOWN = 5;

interface Props {
  queue: ProjectionQueueEntry[];
  replay: { from: number; to: number } | null;
}

export function BottomWatch({ queue, replay }: Props) {
  const shown = queue.slice(0, QUEUE_SHOWN);
  const more = queue.length - shown.length;
  return (
    <div class="ui-bottom panel" data-mode="watch">
      {replay ? (
        <span class="chip">
          场上没人 · 正在播最近的高光（TICK {replay.from}–{replay.to}）
        </span>
      ) : null}
      <h3 style={{ margin: 0 }}>门外排队</h3>
      {queue.length === 0 ? (
        <span class="chip">没人排队</span>
      ) : (
        shown.map((entry) => (
          <span class="chip" key={entry.id}>
            {entry.index} · {entry.nick}
          </span>
        ))
      )}
      {more > 0 ? <span class="chip">+{more}</span> : null}
      <span class="sep" />
      <span class="sub">点任意鸭子看详情 · 滚轮缩放 · 拖动平移</span>
      <span class="sep" />
      <button type="button" onClick={() => navigate('/account')}>
        带你的 AI 来
      </button>
      <button type="button" class="gold" onClick={() => navigate('/play')}>
        我自己上
      </button>
    </div>
  );
}
