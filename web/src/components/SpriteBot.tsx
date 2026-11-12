// The selected-agent card reads the same look-up as the map so the face never
// disagrees between the two.

import type { AgentLook } from '../render';

interface Props {
  look: AgentLook;
  color: string;
  size?: number;
  label?: string;
}

/** One 16px sprite upscaled by a whole number, drawn as DOM SVG. */
export function SpriteBot({ look, color, size = 64, label }: Props) {
  return (
    <svg
      class="agent-avatar"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      style={{ color }}
      shape-rendering="crispEdges"
      role="img"
      aria-label={label ?? 'Agent'}
    >
      <use href={`#${look.sit ? 'bot-sit' : 'bot'}`} />
      <use href={`#${look.face}`} y={look.sit ? 5 : 0} />
    </svg>
  );
}
