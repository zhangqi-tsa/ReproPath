import { randomUUID } from 'node:crypto';
import type { DetectionStats, Finding, FindingStatus, ServerMessage, Signal } from '@repropath/protocol';
import { SignalDetector } from './signal-detector.js';

export const MAX_SIGNALS = 2000, MAX_FINDINGS = 500, MAX_FINDING_REFS = 100;
export function findingTitle(signal: Signal): string {
  const f = signal.facts;
  switch (f.kind) {
    case 'HTTP_5XX': return `HTTP ${f.status} · ${f.method} ${f.safeEndpoint}`;
    case 'REQUEST_FAILED': return `请求失败 · ${f.method} ${f.safeEndpoint}`;
    case 'DOCUMENT_REQUEST_FAILED': return `页面导航请求失败 · ${f.method} ${f.safeEndpoint}`;
    case 'PAGE_ERROR': return '页面 JavaScript 异常';
    case 'CONSOLE_ERROR': return 'Console Error';
    case 'DUPLICATE_REQUEST': return `疑似重复请求 · ${f.method} ${f.safeEndpoint}`;
  }
}

export class SignalStore {
  private values = new Map<string, Signal>();
  dropped = 0;
  append(signal: Signal): boolean {
    if (this.values.has(signal.id)) return false;
    this.values.set(signal.id, structuredClone(signal));
    if (this.values.size > MAX_SIGNALS) { this.values.delete(this.values.keys().next().value!); this.dropped++; }
    return true;
  }
  list(): Signal[] { return structuredClone([...this.values.values()]); }
  get size(): number { return this.values.size; }
}
export class FindingStore {
  private values = new Map<string, Finding>();
  private fingerprints = new Map<string, string>();
  dropped = 0;
  add(signal: Signal): Finding | undefined {
    const existing = this.fingerprints.get(signal.fingerprint);
    let finding = existing ? this.values.get(existing) : undefined;
    if (!finding) {
      if (this.values.size >= MAX_FINDINGS) { this.dropped++; return; }
      finding = { id: randomUUID(), sessionId: signal.sessionId, fingerprint: signal.fingerprint, signalKind: signal.kind, severity: signal.severity, status: 'candidate', title: findingTitle(signal), createdAt: signal.detectedAt, updatedAt: signal.detectedAt, firstDetectedAt: signal.detectedAt, lastDetectedAt: signal.detectedAt, occurrenceCount: 0, signalIds: [], actionIds: [], referencesTruncated: false, revision: 0 };
      this.values.set(finding.id, finding); this.fingerprints.set(signal.fingerprint, finding.id);
    }
    finding.occurrenceCount++; finding.revision++;
    finding.updatedAt = new Date().toISOString();
    finding.firstDetectedAt = finding.firstDetectedAt < signal.detectedAt ? finding.firstDetectedAt : signal.detectedAt;
    finding.lastDetectedAt = finding.lastDetectedAt > signal.detectedAt ? finding.lastDetectedAt : signal.detectedAt;
    finding.signalIds.push(signal.id);
    if (signal.actionId && !finding.actionIds.includes(signal.actionId)) finding.actionIds.push(signal.actionId);
    if (finding.signalIds.length > MAX_FINDING_REFS || finding.actionIds.length > MAX_FINDING_REFS) finding.referencesTruncated = true;
    finding.signalIds = finding.signalIds.slice(-MAX_FINDING_REFS); finding.actionIds = finding.actionIds.slice(-MAX_FINDING_REFS);
    return structuredClone(finding);
  }
  triage(id: string, status: FindingStatus): Finding | undefined {
    const finding = this.values.get(id); if (!finding) return;
    finding.status = status; finding.updatedAt = new Date().toISOString(); finding.revision++;
    return structuredClone(finding);
  }
  get(id: string): Finding | undefined { const value = this.values.get(id); return value && structuredClone(value); }
  list(): Finding[] { return structuredClone([...this.values.values()]); }
  get size(): number { return this.values.size; }
}
export class SessionDetection {
  readonly signals = new SignalStore();
  readonly findings = new FindingStore();
  readonly detector: SignalDetector;
  private runtimeDropped = 0;
  constructor(readonly sessionId: string, private publish: (message: ServerMessage) => void) {
    this.detector = new SignalDetector(sessionId, signal => {
      if (!this.signals.append(signal)) return;
      this.publish({ type: 'signal-created', signal });
      const finding = this.findings.add(signal);
      if (finding) this.publish({ type: 'finding-update', finding });
      this.publishStats();
    }, () => { this.runtimeDropped++; this.publishStats(); });
  }
  stats(): DetectionStats { return { signalsRetained: this.signals.size, signalsDropped: this.signals.dropped, findingsRetained: this.findings.size, findingsDropped: this.findings.dropped, runtimeDropped: this.runtimeDropped }; }
  private publishStats(): void { this.publish({ type: 'detection-stats', sessionId: this.sessionId, stats: this.stats() }); }
  triage(id: string, status: FindingStatus): Finding | undefined { const finding = this.findings.triage(id, status); if (finding) this.publish({ type: 'finding-update', finding }); return finding; }
}
export class DetectionRegistry {
  private sessions = new Map<string, SessionDetection>();
  constructor(private publish: (id: string, message: ServerMessage) => void) {}
  create(id: string): void { this.sessions.set(id, new SessionDetection(id, message => this.publish(id, message))); }
  get(id: string): SessionDetection | undefined { return this.sessions.get(id); }
  stop(id: string): void { this.sessions.get(id)?.detector.stop(); }
  forget(id: string): void { this.stop(id); this.sessions.delete(id); }
  stopAll(): void { for (const id of this.sessions.keys()) this.stop(id); }
}
