// The outside queue as a horizontal strip. The board also draws these bots on
// their physical queue cells; this strip is the readable overview, including
// entries scrolled off the camera.

import { agentColor } from '../render';
import type { ProjectionQueueEntry } from '../types';

interface Props {
  queue: ProjectionQueueEntry[];
}

export function QueueStrip({ queue }: Props) {
  return (
    <section class="queue-strip" aria-label="场外排队">
      <div class="queue-strip-label">
        门外排队 <span class="mono">{queue.length}</span>
      </div>
      <div class="queue-strip-track">
        {queue.length === 0 ? (
          <span class="queue-empty">没有人排队</span>
        ) : (
          queue.map((entry) => (
            <div
              class="queue-slot"
              key={entry.id}
              title={`${entry.nick} · 第 ${entry.index} 位 · (${entry.pos.x}, ${entry.pos.y})`}
            >
              <span class="queue-index mono">{entry.index}</span>
              <span class="queue-nick">{entry.nick}</span>
              <span
                class="queue-swatch"
                style={{ background: agentColor(entry.color) }}
                aria-hidden="true"
              />
            </div>
          ))
        )}
      </div>
    </section>
  );
}
