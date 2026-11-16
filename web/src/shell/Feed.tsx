import { EventText } from '../components/EventText';
import { zhEvent } from '../eventText';
import type { ProjectionEvent } from '../types';

interface Props {
  events: ProjectionEvent[];
  colors: Map<string, string>;
}

export function Feed({ events, colors }: Props) {
  const latest = events.slice(0, 3);
  return (
    <div class="ui-feed panel">
      <h3>现场</h3>
      {latest.length === 0 ? (
        <div class="sub">暂无事件</div>
      ) : (
        latest.map((event) => (
          <div class="row feed-row" key={`${event.tick}:${event.seq}`} title={zhEvent(event.text)}>
            <i class="feed-dot" data-kind={event.kind} />
            <span class="feed-text">
              <EventText text={zhEvent(event.text)} colors={colors} />
            </span>
          </div>
        ))
      )}
    </div>
  );
}
