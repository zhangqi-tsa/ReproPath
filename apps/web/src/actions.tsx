import { useState } from 'react';
import type { ActionRecord, EvidenceSnapshot, SessionEvent } from '@repropath/protocol';

function Snapshot({ snapshot, label }: { snapshot?: EvidenceSnapshot; label: string }) {
  const [dom, setDom] = useState<string>();
  return <section className="evidence-phase"><h4>{label}</h4>
    {snapshot?.screenshot ? <img alt={`${label} evidence`} loading="lazy" src={`/artifacts/${snapshot.screenshot.id}`} /> : <p>截图不可用</p>}
    <p>{snapshot?.url || '—'}<br />{snapshot?.title}</p>
    {snapshot?.dom && <button onClick={() => { void fetch(`/artifacts/${snapshot.dom!.id}`).then(async response => {
      if (!response.ok) throw new Error(); setDom(await response.text());
    }).catch(() => setDom('DOM 证据不可用')); }}>查看 Sanitized DOM · {label}</button>}
    {dom !== undefined && <pre className="evidence-dom">{dom}</pre>}
  </section>;
}
export function Actions({ actions, events }: { actions: ActionRecord[]; events: SessionEvent[] }) {
  const [selected, setSelected] = useState<string>();
  return <section className="actions" aria-label="Actions"><h2>Actions <span>{actions.length}</span></h2>
    {!actions.length && <p>接管后进行点击、输入或滚动，自动记录操作与现场。</p>}
    {actions.map(action => {
      const network = events.filter(event => ['request', 'response', 'requestfailed'].includes(event.type) && 'requestId' in event.payload && action.networkRequestIds.includes(event.payload.requestId));
      const related = events.filter(event => event.sequence >= action.eventSequenceStart && event.sequence <= (action.eventSequenceEnd ?? Infinity) && 'pageId' in event && event.pageId === action.pageId);
      const errors = related.filter(event => event.type === 'pageerror' || (event.type === 'console' && event.payload.level === 'error'));
      return <article key={action.id} className="action-card" data-testid="action-card">
        <button className="action-summary" aria-expanded={selected === action.id} onClick={() => setSelected(selected === action.id ? undefined : action.id)}>
          <strong>{action.actor} · {action.kind.toUpperCase()}</strong> <span>{action.target?.tagName} {action.target?.ariaLabel || action.target?.text || action.target?.name}</span>
          <span>{new Date(action.startedAt).toLocaleTimeString()} · {action.durationMs === undefined ? '记录中' : `${action.durationMs} ms`} · {action.status}</span>
          {action.detail.kind === 'type' && <span>{action.detail.characterCount} characters</span>}
          {action.detail.kind === 'key' && <span>{[...action.detail.modifiers, action.detail.key].join('+')}</span>}
          <span>{action.networkRequestIds.length} requests · {errors.length} console/page errors · {action.evidenceStatus}</span>
          {['partial','failed'].includes(action.evidenceStatus) && <span className="error">⚠ Evidence incomplete</span>}
        </button>
        {selected === action.id && <div className="action-detail">
          <small>Action {action.id} · events {action.eventSequenceStart}–{action.eventSequenceEnd ?? '…'}</small>
          {action.settle?.timedOut && <p>等待已达上限，现场可能仍在变化。</p>}
          <div className="evidence-pair"><Snapshot key={`${action.id}-before`} snapshot={action.before} label="Before" /><Snapshot key={`${action.id}-after`} snapshot={action.after} label="After" /></div>
          <h4>Network</h4>{network.length ? network.map(event => <p key={event.id}>{event.type === 'request' ? `${event.payload.method} ${event.payload.url}` : event.type === 'response' ? `HTTP ${event.payload.status} · ${event.payload.url}` : event.type === 'requestfailed' ? `${event.payload.error} · ${event.payload.url}` : ''}</p>) : <p>暂无相关网络事件</p>}
          <h4>Console / Page</h4>{related.filter(event => ['console','pageerror','navigation'].includes(event.type)).map(event => <p key={event.id}>{event.type === 'console' ? `[${event.payload.level}] ${event.payload.text}` : event.type === 'pageerror' ? event.payload.message : event.type === 'navigation' ? event.payload.url : ''}</p>)}
        </div>}
      </article>;
    })}
  </section>;
}
