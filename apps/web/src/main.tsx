import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionSchema } from '@repropath/protocol';
import { BrowserView } from './browser-view.js';
import { Timeline } from './timeline.js';
import { Actions } from './actions.js';
import { Findings } from './findings.js';
import { useSession } from './use-session.js';
import './style.css';

function routeId(): string | undefined { return /^\/session\/([^/]+)\/?$/.exec(location.pathname)?.[1]; }
function App(): React.JSX.Element {
  const [id, setId] = useState(routeId);
  const [url, setUrl] = useState('http://127.0.0.1:4310/test-page');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const { session, events, actions, signals, findings, detectionStats, frame, error: restoreError, connection, acknowledge, control, controlState } = useSession(id);
  useEffect(() => { if (session) setUrl(session.requestedUrl); }, [session?.id]);
  useEffect(() => {
    const changed = () => { setId(routeId()); setError(''); };
    window.addEventListener('popstate', changed); return () => window.removeEventListener('popstate', changed);
  }, []);
  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(typeof data === 'object' && data && 'error' in data ? String(data.error) : '创建失败');
      const created = SessionSchema.parse(data);
      history.pushState(null, '', `/session/${created.id}`); setId(created.id);
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
  return <main>
    <header><a className="brand" href="/" aria-label="ReproPath 首页">R<span>↗</span></a><div><h1>ReproPath</h1><p>Signal & Finding Foundation · Milestone 1.5</p></div><span className="milestone">LOCAL RUNTIME</span></header>
    <section className={`create ${session ? 'compact' : ''}`}><h2>创建浏览器 Session</h2>
      <form onSubmit={event => { void create(event); }}><label htmlFor="url">目标 URL</label><div className="input-row"><input id="url" type="url" required value={url} onChange={event => setUrl(event.target.value)} /><button disabled={busy}>{busy ? '创建中…' : 'Create Session'}</button></div></form>
      {!session && <p className="hint">在独立 Chromium 页面中实时观察画面与事件。可使用本地 fixture，或输入目标网站地址。</p>}
    </section>
    {(error || restoreError) && <p role="alert" className="error">{error || restoreError}</p>}
    {id && !session && !restoreError && <p role="status">正在恢复 Session…</p>}
    {session ? <>
      <section className="live-session" aria-label="Session 状态"><div className="section-heading session-heading"><h2>Live Session</h2><span className={`status ${session.status}`} data-testid="status">{session.status}</span><button className="secondary" onClick={() => { void close(); }} disabled={['closed', 'failed'].includes(session.status)}>关闭 Session</button></div>
        <div className="live-layout"><BrowserView key={session.id} session={session} frame={frame} connected={connection === '实时连接'} acknowledge={acknowledge} control={control} controlState={controlState} />
          <aside className="session-info"><h3>Session Info</h3><dl>
            <dt>Session ID</dt><dd data-testid="session-id">{session.id}</dd>
            <dt>Current URL</dt><dd data-testid="current-url">{session.currentUrl || '等待导航…'}</dd>
            <dt>Page Title</dt><dd data-testid="page-title">{session.pageTitle || '等待页面…'}</dd>
            <dt>Active Page ID</dt><dd data-testid="page-id">{session.activePageId ?? '等待页面…'}</dd>
            <dt>Connection</dt><dd className="connection" role="status">{connection}</dd>
            <dt>Viewport</dt><dd>{session.viewport.width} × {session.viewport.height}</dd>
            <dt>Created At</dt><dd>{new Date(session.createdAt).toLocaleString()}</dd>
          </dl><p className="hint">此地址可复制或刷新恢复。popup 事件会保留，画面始终显示原活动页面。</p></aside>
        </div>{session.error && <p className="error">{session.error}</p>}
      </section><Findings key={session.id} sessionId={session.id} findings={findings} signals={signals} stats={detectionStats} actions={actions} events={events} /><Actions actions={actions} events={events} /><Timeline events={events} />
    </> : !id && <div className="welcome"><div className="view-icon">▣</div><h2>看见浏览器正在发生什么</h2><p>创建 Session 后，实时画面将在这里显示。<br/>页面事件同步记录在下方 Timeline。</p><span className="readonly">只读 · 实时 · 独立浏览器上下文</span></div>}
    <footer>Chromium → CDP Screencast → BrowserFrame → Live View</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
