// Server event lines, with every known nickname painted in its body colour
// (docs/art/README.md §7). Text itself stays plain: the server never sends
// HTML and nothing here parses it.

import { agentColor } from '../palette';
import type { Projection } from '../types';

/** Nickname -> body colour, for agents on the field and in the queue. */
export function eventColors(projection: Projection | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!projection) return map;
  for (const entry of [...projection.agents, ...projection.queue]) {
    map.set(entry.nick, agentColor(entry.color));
  }
  return map;
}

export function EventText({ text, colors }: { text: string; colors: Map<string, string> }) {
  const names = Array.from(colors.keys()).sort((a, b) => b.length - a.length);
  if (names.length === 0) return <>{text}</>;
  const pattern = new RegExp(
    `(${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'g',
  );
  return (
    <>
      {text.split(pattern).map((part, index) => {
        const color = colors.get(part);
        if (!color) return <span key={index}>{part}</span>;
        return (
          <b key={index} style={{ color }}>
            {part}
          </b>
        );
      })}
    </>
  );
}
