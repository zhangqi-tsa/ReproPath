import { createHash, randomUUID } from 'node:crypto';
import type { ActionRecord, SessionEvent, Signal } from '@repropath/protocol';

export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
// Never carry userinfo, query values or fragments into derived data.
export function safeEndpoint(raw: string): string {
  try { const url = new URL(raw); return ['http:', 'https:'].includes(url.protocol) ? url.origin + url.pathname : '(non-http page)'; }
  catch { return '(unknown endpoint)'; }
}
type Request = { eventId: string; pageId: string; actionId?: string; method: string; endpoint: string; resourceType: string };
type Burst = { pageId: string; actionId: string; method: string; endpoint: string; first: number; last: number; requestIds: string[]; eventIds: string[] };
export const DETECTOR_MAP_LIMIT = 10_000;

/** One Session, synchronous indexed rules. No UI, network, body capture or evidence work. */
export class SignalDetector {
  private requests = new Map<string, Request>();
  private active = new Map<string, string>();
  private pages = new Map<string, string>();
  private terminal = new Set<string>();
  private bursts = new Map<string, Map<string, Burst>>();
  private burstRequests = 0;
  private sequence = 0;
  private stopped = false;
  constructor(private sessionId: string, private emit: (signal: Signal) => void, private dropped: () => void = () => {}) {}
  private bound<K, V>(map: Map<K, V>, limit: number): void {
    while (map.size > limit) { map.delete(map.keys().next().value!); this.dropped(); }
  }
  onAction(action: ActionRecord): void {
    if (this.stopped || action.sessionId !== this.sessionId) return;
    if (action.before && !this.pages.has(action.pageId)) { this.pages.set(action.pageId, safeEndpoint(action.before.url)); this.bound(this.pages, 500); }
    if (action.status === 'recording') {
      if (!this.terminal.has(action.id)) { this.active.set(action.pageId, action.id); this.bound(this.active, 500); }
    } else {
      this.flushAction(action.id);
      if (this.active.get(action.pageId) === action.id) this.active.delete(action.pageId);
      this.terminal.add(action.id);
      if (this.terminal.size > 500) this.terminal.delete(this.terminal.values().next().value!);
    }
    for (const id of action.networkRequestIds) {
      const request = this.requests.get(id);
      if (request && !request.actionId) request.actionId = action.id;
    }
  }
  onEvent(event: SessionEvent): void {
    if (this.stopped || event.sessionId !== this.sessionId || event.sequence <= this.sequence) return;
    this.sequence = event.sequence;
    if (event.type === 'lifecycle') { if (['closed', 'failed'].includes(event.payload.status)) this.stop(); return; }
    const actionId = this.active.get(event.pageId);
    if (event.type === 'navigation') {
      if (event.payload.isMainFrame) { this.pages.set(event.pageId, safeEndpoint(event.payload.url)); this.bound(this.pages, 500); }
    } else if (event.type === 'request') {
      const request: Request = { eventId: event.id, pageId: event.pageId, actionId, method: event.payload.method, endpoint: safeEndpoint(event.payload.url), resourceType: event.payload.resourceType };
      this.requests.set(event.payload.requestId, request); this.bound(this.requests, DETECTOR_MAP_LIMIT);
      if (actionId && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) this.duplicate(event, request, actionId);
    } else if (event.type === 'response' || event.type === 'requestfailed') {
      const request = this.requests.get(event.payload.requestId);
      // Missing/evicted Request facts cannot safely classify a failure or recover its Action.
      if (!request) { this.dropped(); return; }
      const sourceEventIds = [request.eventId, event.id];
      const common = { requestId: event.payload.requestId, method: request.method, safeEndpoint: request.endpoint };
      if (event.type === 'response' && event.payload.status >= 500 && event.payload.status <= 599) {
        this.signal({ kind: 'HTTP_5XX', ...common, status: event.payload.status }, event.timestamp, event.pageId, request.actionId, sourceEventIds, [event.payload.requestId]);
      } else if (event.type === 'requestfailed') {
        this.signal({ kind: request.resourceType === 'document' ? 'DOCUMENT_REQUEST_FAILED' : 'REQUEST_FAILED', ...common, resourceType: request.resourceType, failureHash: digest(event.payload.error) }, event.timestamp, event.pageId, request.actionId, sourceEventIds, [event.payload.requestId]);
      }
    } else if (event.type === 'pageerror' || (event.type === 'console' && event.payload.level === 'error')) {
      this.signal({ kind: event.type === 'pageerror' ? 'PAGE_ERROR' : 'CONSOLE_ERROR', safePage: this.pages.get(event.pageId) ?? '(unknown page)', messageHash: digest(event.type === 'pageerror' ? event.payload.message : event.payload.text) }, event.timestamp, event.pageId, actionId, [event.id], []);
    }
  }
  private duplicate(event: Extract<SessionEvent, { type: 'request' }>, request: Request, actionId: string): void {
    let groups = this.bursts.get(actionId);
    if (!groups) {
      if (this.bursts.size >= 500) { this.dropped(); return; }
      groups = new Map(); this.bursts.set(actionId, groups);
    }
    // Hash the exact raw URL only for transient equality; it never enters Signal or Finding.
    const key = digest([request.method, event.payload.url]); const time = Date.parse(event.timestamp);
    let burst = groups.get(key);
    if (burst && (time - burst.first > 1000 || time < burst.first)) { this.flush(burst); this.burstRequests -= burst.requestIds.length; groups.delete(key); burst = undefined; }
    if (this.burstRequests >= DETECTOR_MAP_LIMIT) { this.dropped(); return; }
    if (!burst) {
      burst = { pageId: event.pageId, actionId, method: request.method, endpoint: request.endpoint, first: time, last: time, requestIds: [], eventIds: [] };
      if (groups.size >= 1000) { this.dropped(); return; }
      groups.set(key, burst);
    }
    if (burst.requestIds.length >= 1000) { this.dropped(); return; }
    burst.last = time; burst.requestIds.push(event.payload.requestId); burst.eventIds.push(event.id); this.burstRequests++;
  }
  private flush(burst: Burst): void {
    if (burst.requestIds.length < 2) return;
    this.signal({ kind: 'DUPLICATE_REQUEST', method: burst.method, safeEndpoint: burst.endpoint, count: burst.requestIds.length, windowMs: burst.last - burst.first }, new Date(burst.last).toISOString(), burst.pageId, burst.actionId, burst.eventIds, burst.requestIds);
  }
  private flushAction(id: string): void {
    const groups = this.bursts.get(id);
    if (groups) for (const burst of groups.values()) { this.flush(burst); this.burstRequests -= burst.requestIds.length; }
    this.bursts.delete(id);
  }
  private signal(facts: Signal['facts'], at: string, pageId: string, actionId: string | undefined, sourceEventIds: string[], requestIds: string[]): void {
    const { kind } = facts;
    const material = kind === 'HTTP_5XX' ? [kind, facts.method, facts.safeEndpoint, facts.status]
      : kind === 'REQUEST_FAILED' || kind === 'DOCUMENT_REQUEST_FAILED' ? [kind, facts.method, facts.safeEndpoint, facts.resourceType, facts.failureHash]
      : kind === 'DUPLICATE_REQUEST' ? [kind, facts.method, facts.safeEndpoint]
      : [kind, facts.safePage, facts.messageHash];
    this.emit({ id: randomUUID(), sessionId: this.sessionId, pageId, actionId, kind,
      severity: ['HTTP_5XX', 'DOCUMENT_REQUEST_FAILED', 'PAGE_ERROR'].includes(kind) ? 'high' : 'medium',
      detectedAt: at, fingerprint: digest(material), sourceEventIds: [...sourceEventIds], requestIds: [...requestIds], facts });
  }
  stop(): void { this.stopped = true; this.requests.clear(); this.active.clear(); this.pages.clear(); this.bursts.clear(); this.terminal.clear(); this.burstRequests = 0; }
  runtimeSize(): number { return this.requests.size + this.active.size + this.pages.size + this.terminal.size + [...this.bursts.values()].reduce((n, groups) => n + groups.size, 0); }
}
