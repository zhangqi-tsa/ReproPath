/** Keep initial user goal and complete recent assistant/tool groups, never orphan results. */
export function recentHistory<T extends { role: string }>(messages: T[], turns: number): T[] {
  let remaining = turns, start = messages.length;
  for (let i = messages.length - 1; i >= 1; i--) if (messages[i]!.role === 'assistant' && --remaining === 0) { start = i; break; }
  return start === messages.length ? messages : [messages[0]!, ...messages.slice(start)];
}
