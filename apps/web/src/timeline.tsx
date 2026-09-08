import { memo, useState } from 'react';
import type { SessionEvent } from '@repropath/protocol';
const labels: Record<SessionEvent['type'], string> = {
  navigation: 'NAVIGATION', request: 'REQUEST', response: 'RESPONSE', console: 'CONSOLE',
  pageerror: 'PAGE ERROR', requestfailed: 'REQUEST FAILED', lifecycle: 'LIFECYCLE',
  'human-input': 'HUMAN INPUT',
};
function describe(event: SessionEvent): string {
  switch (event.type) {
    case 'human-input': {
      const input = event.payload;
      if (input.kind === 'text') return `输入文本 · length = ${input.characterCount}`;
      if (input.kind === 'key') return `按键 ${input.modifiers.join('+')}${input.modifiers.length ? '+' : ''}${input.key} · ${input.action}`;
      if (input.kind === 'wheel') return `滚轮 Δx=${input.deltaX} Δy=${input.deltaY}`;
      return `${input.kind} · ${input.button} (${Math.round(input.x)}, ${Math.round(input.y)})`;
    }
    case 'navigation': return event.payload.url;
    case 'request': return `${event.payload.method} ${event.payload.url}`;
    case 'response': return `HTTP ${event.payload.status} ${event.payload.statusText} · ${event.payload.url}`;
    case 'console': return `[${event.payload.level}] ${event.payload.text}`;
    case 'pageerror': return event.payload.message;
    case 'requestfailed': return `${event.payload.error} · ${event.payload.url}`;
    case 'lifecycle': return `${event.payload.status}${event.payload.message ? ` · ${event.payload.message}` : ''}`;
  }
}
export const Timeline = memo(function Timeline({ events }: { events: SessionEvent[] }): React.JSX.Element {
  const [filter, setFilter] = useState('all'); const [level, setLevel] = useState('all');
  const shown = events.filter(event => (filter === 'all' || event.type === filter) && (event.type !== 'console' || level === 'all' || event.payload.level === level));
  const levels = [...new Set(events.flatMap(event => event.type === 'console' ? [event.payload.level] : []))];
  return <section className="timeline-section"><div className="section-heading"><h2>Timeline <small>{events.length}</small></h2>
    <label className="filter">事件筛选<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部事件</option>{Object.entries(labels).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
    <label className="filter level-filter">日志级别<select value={level} onChange={event => setLevel(event.target.value)}><option value="all">全部级别</option>{levels.map(value => <option key={value}>{value}</option>)}</select></label></div>
    <p className="hint">真实浏览器事件 · Page / Frame 稳定身份 · 画面帧不进入事件历史</p>
    {!shown.length ? <div className="empty">等待浏览器事件，或调整筛选条件。</div> : <ol className="timeline">{shown.map(event => <li key={event.id} className={`event ${event.type}`}>
      <div className="event-meta"><span>#{event.sequence}</span><strong>{labels[event.type]}</strong><time>{new Date(event.timestamp).toLocaleTimeString()}</time></div>
      <div className="event-body">{describe(event)}</div>
      {'pageId' in event && <code>pageId: {event.pageId}</code>}
      {event.type === 'human-input' && <code>inputSequence: {event.payload.inputSequence}{event.payload.sourceFrameSequence ? ` · sourceFrameSequence: ${event.payload.sourceFrameSequence}` : ''}</code>}
      {event.type === 'navigation' && <code>frameId: {event.payload.frameId} · {event.payload.isMainFrame ? 'main frame' : 'subframe'}</code>}
      {'requestId' in event.payload && <code>requestId: {event.payload.requestId}</code>}
      {event.type === 'console' && <code>来源: {event.payload.url || '(unknown)'}:{event.payload.lineNumber + 1}:{event.payload.columnNumber + 1}</code>}
      {event.type === 'pageerror' && event.payload.stack && <details><summary>错误堆栈</summary><pre>{event.payload.stack}</pre></details>}
    </li>)}</ol>}
  </section>;
});
