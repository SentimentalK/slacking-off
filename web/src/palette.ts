// Agent body colours, `docs/art/README.md` §2. Index = `ProjectionAgent.color`.
export const AGENT_COLORS = [
  '#ef5350',
  '#ff8a50',
  '#ffca28',
  '#66bb6a',
  '#26a69a',
  '#42a5f5',
  '#ab47bc',
  '#cfd8e0',
  '#f06292',
  '#9ccc65',
  '#4dd0e1',
  '#9575cd',
] as const;

export function agentColor(index: number): string {
  const n = AGENT_COLORS.length;
  return AGENT_COLORS[((index % n) + n) % n];
}
