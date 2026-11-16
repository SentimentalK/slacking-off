import { EventText } from '../components/EventText';
import { eventIn } from '../eventText';
import { useI18n } from '../i18n';
import type { ProjectionEvent } from '../types';

interface Props {
  events: ProjectionEvent[];
  colors: Map<string, string>;
}

export function Feed({ events, colors }: Props) {
  const { t, lang } = useI18n();
  const latest = events.slice(0, 3);
  return (
    <div class="ui-feed panel">
      <h3>{t('feed.title')}</h3>
      {latest.length === 0 ? (
        <div class="sub">{t('feed.empty')}</div>
      ) : (
        latest.map((event) => (
          <div class="row feed-row" key={`${event.tick}:${event.seq}`} title={eventIn(lang, event.text)}>
            <i class="feed-dot" data-kind={event.kind} />
            <span class="feed-text">
              <EventText text={eventIn(lang, event.text)} colors={colors} />
            </span>
          </div>
        ))
      )}
    </div>
  );
}
