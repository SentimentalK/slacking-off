import { EventText } from '../components/EventText';
import { EVENT_LABEL } from '../labels';
import type { ProjectionEvent } from '../types';

interface Props {
  events: ProjectionEvent[];
  colors: Map<string, string>;
}

export function Feed({ events, colors }: Props) {
  const latest = events.slice(0, 4);
  return (
    <div class="ui-feed panel">
      <h3>现场</h3>
      {latest.length === 0 ? (
        <div class="sub">暂无事件</div>
      ) : (
        latest.map((event) => (
          <div class="row feed-row" key={`${event.tick}:${event.seq}`} title={event.text}>
            <span class="chip">{EVENT_LABEL[event.kind]}</span>
            <span class="feed-text">
              <EventText text={event.text} colors={colors} />
            </span>
          </div>
        ))
      )}
    </div>
  );
}
