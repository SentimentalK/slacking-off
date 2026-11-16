import { t, type Key } from '../i18n';

// Raw text from the server, or a dictionary key resolved when the message is rendered.
export type Problem = { text: string } | { key: Key };

export function problemText(problem: Problem): string {
  return 'key' in problem ? t(problem.key) : problem.text;
}
