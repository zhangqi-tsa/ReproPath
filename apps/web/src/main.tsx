import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ServerMessageSchema, SessionSchema, type Session, type SessionEvent } from '@repropath/protocol';
import './style.css';

const labels: Record<SessionEvent['type'], string> = {
  navigation: 'NAVIGATION', request: 'REQUEST', response: 'RESPONSE', console: 'CONSOLE',
  pageerror: 'PAGE ERROR', requestfailed: 'REQUEST FAILED', lifecycle: 'LIFECYCLE',
};
function describe(event: SessionEvent): string {
  switch (event.type) {
    case 'navigation': return event.payload.url;
    case 'request': return `${event.payload.method} ${event.payload.url}`;
    case 'response': return `HTTP ${event.payload.status} ${event.payload.statusText} · ${event.payload.url}`;
    case 'console': return `[${event.payload.level}] ${event.payload.text}`;
    case 'pageerror': return event.payload.message;
    case 'requestfailed': return `${event.payload.error} · ${event.payload.url}`;
    case 'lifecycle': return `${event.payload.status}${event.payload.message ? ` · ${event.payload.message}` : ''}`;
  }
}
function App(): React.JSX.Element {
  const [url, setUrl] = useState('http://127.0.0.1:4310/test-page');
  const [session, setSession] = useState<Session>();
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('未订阅');
  const [filter, setFilter] = useState('all');
  useEffect(() => {
    if (!session?.id) return;
    const id = session.id;
    let disposed = false;
    let socket: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    function connect(): void {
      setConnection('连接中');
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events`);
      socket.onopen = () => { socket.send(JSON.stringify({ type: 'subscribe', sessionId: id })); };
      socket.onmessage = message => {
        if (disposed) return;
        try {
          const data = ServerMessageSchema.parse(JSON.parse(String(message.data)));
          if (data.type === 'snapshot') { setSession(data.session); setEvents(data.events); setConnection('实时连接'); }
          else if (data.type === 'state') setSession(data.session);
          else if (data.type === 'event') setEvents(previous => previous.some(event => event.id === data.event.id) ? previous : [...previous, data.event].slice(-10_000));
          else setError(data.message);
        } catch { setError('无法解析服务端消息'); }
      };
      socket.onclose = () => { if (!disposed) { setConnection('连接中断，正在重连'); retry = setTimeout(connect, 1000); } };
      socket.onerror = () => socket.close();
    }
    connect();
    return () => { disposed = true; clearTimeout(retry); socket.close(); };
  }, [session?.id]);
  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(typeof data === 'object' && data && 'error' in data ? String(data.error) : '创建失败');
      setSession(SessionSchema.parse(data)); setEvents([]);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function close(): Promise<void> {
    if (!session) return;
    try {
      const response = await fetch(`/sessions/${session.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('关闭 Session 失败');
    } catch (error) { setError(String(error)); }
  }
  const shown = events.filter(event => filter === 'all' || event.type === filter);
  return <main>
    <header><div className="brand">R<span>↗</span></div><div><h1>ReproPath</h1><p>真实浏览器事件 · Milestone 1.1</p></div><span className="milestone">LOCAL RUNTIME</span></header>
    <section className="create"><h2>创建浏览器 Session</h2><p>输入页面地址，在独立 Chromium 上下文中捕获运行事件。</p>
      <form onSubmit={event => { void create(event); }}><label htmlFor="url">目标 URL</label><div className="input-row"><input id="url" type="url" required value={url} onChange={event => setUrl(event.target.value)} /><button disabled={busy}>{busy ? '创建中…' : 'Create Session'}</button></div></form>
      <p className="hint">本地 fixture 会自动触发请求、日志和异常；附加 ?navigate=1 可演示后续导航。</p>
    </section>
    {error && <p role="alert" className="error">{error}</p>}
    {session && <section aria-label="Session 状态"><div className="section-heading"><h2>Session</h2><span className={`status ${session.status}`} data-testid="status">{session.status}</span><button className="secondary" onClick={() => { void close(); }} disabled={['closed', 'failed'].includes(session.status)}>关闭 Session</button></div>
      <dl><dt>Session ID</dt><dd>{session.id}</dd><dt>Current URL</dt><dd data-testid="current-url">{session.currentUrl || '等待导航…'}</dd><dt>Page Title</dt><dd data-testid="page-title">{session.pageTitle || '等待页面…'}</dd><dt>Created At</dt><dd>{new Date(session.createdAt).toLocaleString()}</dd></dl>
      {session.error && <p className="error">{session.error}</p>}
    </section>}
    <section><div className="section-heading"><h2>Timeline <small>{events.length}</small></h2><span className="connection" role="status">{connection}</span><label className="filter">事件筛选<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部事件</option>{Object.entries(labels).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label></div>
      <p className="hint">按 Session sequence 排序 · requestId 关联请求与响应 · 保留最近 10,000 条</p>
      {!shown.length ? <div className="empty">{session ? '等待浏览器事件，或调整筛选条件。' : '创建 Session 后，浏览器事件将在这里实时显示。'}</div> : <ol className="timeline">{shown.map(event => <li key={event.id} className={`event ${event.type}`}><div className="event-meta"><span>#{event.sequence}</span><strong>{labels[event.type]}</strong><time>{new Date(event.timestamp).toLocaleTimeString()}</time></div><div className="event-body">{describe(event)}</div>{'requestId' in event.payload && <code>requestId: {event.payload.requestId}</code>}{event.type === 'pageerror' && event.payload.stack && <details><summary>错误堆栈</summary><pre>{event.payload.stack}</pre></details>}</li>)}</ol>}
    </section><footer>Browser → SessionEvent → Control → WebSocket → UI</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
