import { useMemo, useState } from 'react';
import type { ActionRecord, DetectionStats, Finding, FindingStatus, SessionEvent, Signal } from '@repropath/protocol';
import { Actions } from './actions.js';

const statusLabels: Record<FindingStatus, string> = { candidate: '待确认', confirmed: '已确认问题', not_issue: '不是问题', known_issue: '已知问题' };
const buttons: [FindingStatus, string][] = [['confirmed', '确认问题'], ['not_issue', '不是问题'], ['known_issue', '已知问题'], ['candidate', '恢复待确认']];
export function Findings({ sessionId, findings, signals, stats, actions, events }: { sessionId: string; findings: Finding[]; signals: Signal[]; stats?: DetectionStats; actions: ActionRecord[]; events: SessionEvent[] }) {
  const [selected, setSelected] = useState<string>();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState('');
  const signalMap = useMemo(() => new Map(signals.map(signal => [signal.id, signal])), [signals]);
  const eventMap = useMemo(() => new Map(events.map(event => [event.id, event])), [events]);
  const actionMap = useMemo(() => new Map(actions.map(action => [action.id, action])), [actions]);
  async function triage(id: string, status: FindingStatus): Promise<void> {
    setPending(id); setError('');
    try {
      const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/findings/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      if (!response.ok) throw new Error();
    } catch { setError('人工状态更新失败，请重试'); }
    finally { setPending(undefined); }
  }
  return <section className="findings" aria-label="Findings"><h2>Findings <span>{findings.length}</span></h2>
    <p className="hint">确定性规则发现的异常候选，由你判断。Finding is not a Bug or Issue. No AI is used in detection or triage.</p>
    {stats && <p className="hint">保留 {stats.signalsRetained} Signals · {stats.findingsRetained} Findings</p>}
    {stats && (stats.signalsDropped > 0 || stats.findingsDropped > 0 || stats.runtimeDropped > 0) && <p role="alert" className="error">检测结果已达到当前 Session 上限或关联历史已淘汰：Signals {stats.signalsDropped}，Findings {stats.findingsDropped}，关联数据 {stats.runtimeDropped}。结果可能不完整。</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {!findings.length && <p>尚无 Finding。接管本地 Signal fixture 后可触发异常。</p>}
    {findings.map(finding => {
      const latestAction = [...finding.actionIds].reverse().map(id => actionMap.get(id)).find(Boolean);
      return <article className="finding-card" key={finding.id} data-testid="finding-card" data-kind={finding.signalKind}>
        <div className="finding-heading"><strong className={`severity ${finding.severity}`}>{finding.severity.toUpperCase()}</strong><h3>{finding.title}</h3><span className="finding-status">{statusLabels[finding.status]}</span></div>
        <p>出现 {finding.occurrenceCount} 次 · 保留 {finding.signalIds.length} 个 Signal 引用 · 关联 Action {finding.actionIds.length} 个{finding.referencesTruncated ? '（引用已截断）' : ''}</p>
        <p className="hint">首次 {new Date(finding.firstDetectedAt).toLocaleString()} · 最近 {new Date(finding.lastDetectedAt).toLocaleString()}</p>
        <div className="triage"><button aria-expanded={selected === finding.id} onClick={() => setSelected(selected === finding.id ? undefined : finding.id)}>{selected === finding.id ? '收起' : '查看'}</button>
          {buttons.filter(([status]) => status !== finding.status && (finding.status === 'candidate' || status === 'candidate')).map(([status, label]) => <button className="secondary" key={status} disabled={pending !== undefined} onClick={() => { void triage(finding.id, status); }}>{label}</button>)}
        </div>
        {selected === finding.id && <div className="finding-detail"><h4>Signals · {finding.signalKind}</h4>
          {finding.signalIds.map(id => { const signal = signalMap.get(id); return signal ? <details key={id} className="signal-detail"><summary>{new Date(signal.detectedAt).toLocaleTimeString()} · {signal.kind} · {signal.actionId ? '关联人工 Action' : '无关联 Action'}</summary>
            <pre>{JSON.stringify(signal.facts, null, 2)}</pre><h4>原始 SessionEvent</h4>
            {signal.sourceEventIds.map(eventId => { const event = eventMap.get(eventId); return <pre key={eventId}>{event ? `${event.type}\n${JSON.stringify(event.payload, null, 2)}` : '原始事件已淘汰，当前历史中不可用'}</pre>; })}
          </details> : <p key={id}>Signal {id} 已超出保留上限。</p>; })}
          <h4>Related Action / Evidence</h4>
          {latestAction ? <Actions actions={[latestAction]} events={events} /> : finding.actionIds.length ? <p>关联 Action 已超出保留上限，证据索引不可用。</p> : <p>该异常发生在页面自主行为中，没有关联人工 Action。</p>}
        </div>}
      </article>;
    })}
  </section>;
}
