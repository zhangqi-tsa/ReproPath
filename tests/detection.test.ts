import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignalSchema, FindingSchema, type ActionRecord, type SessionEvent, type Signal } from '@repropath/protocol';
import { SignalDetector, safeEndpoint, digest, DETECTOR_MAP_LIMIT } from '../apps/control/src/signal-detector.js';
import { DetectionRegistry, SessionDetection, MAX_SIGNALS, MAX_FINDINGS } from '../apps/control/src/detection.js';

function setup(sessionId = 'S') {
  const signals: Signal[] = []; let sequence = 0; let dropped = 0;
  const detector = new SignalDetector(sessionId, signal => signals.push(SignalSchema.parse(signal)), () => dropped++);
  const action = (pageId = 'P'): ActionRecord => ({ id: randomUUID(), sessionId, pageId, actor: 'human', kind: 'click', status: 'recording', startedAt: new Date(0).toISOString(), detail: { kind: 'click', button: 'left', x: 1, y: 1 }, eventSequenceStart: 1, networkRequestIds: [], evidenceStatus: 'pending' });
  function event(type: SessionEvent['type'], payload: unknown, ms = 0, pageId = 'P'): SessionEvent {
    const value = { id: randomUUID(), sessionId, pageId, sequence: ++sequence, timestamp: new Date(ms).toISOString(), type, payload } as SessionEvent;
    detector.onEvent(value); return value;
  }
  const request = (url = 'https://a.test/order', method = 'POST', ms = 0, resourceType = 'fetch', pageId = 'P') => {
    const requestId = randomUUID(); const source = event('request', { requestId, url, method, resourceType }, ms, pageId); return { requestId, source, url };
  };
  const response = (r: ReturnType<typeof request>, status = 500, ms = 0) => event('response', { requestId: r.requestId, url: r.url, status, statusText: 'fixture' }, ms);
  return { detector, signals, event, request, response, action, drops: () => dropped };
}

test('six deterministic rules, independent UUIDs, HTTP boundaries and exclusive document failures', () => {
  const h = setup(); const a = h.action(); h.detector.onAction(a);
  for (const status of [200, 302, 400, 404, 499, 500, 599, 600]) h.response(h.request(), status);
  assert.deepEqual(h.signals.map(s => s.facts.kind === 'HTTP_5XX' && s.facts.status), [500, 599]);
  assert.ok(h.signals.every(s => s.actionId === a.id && s.severity === 'high' && !s.sourceEventIds.includes(s.id)));
  for (const resourceType of ['fetch', 'document']) {
    const r = h.request('https://a.test/fail', 'GET', 0, resourceType);
    h.event('requestfailed', { requestId: r.requestId, url: r.url, error: 'net::ERR_EMPTY_RESPONSE secret-failure' });
  }
  assert.deepEqual(h.signals.slice(2).map(s => [s.kind, s.severity]), [['REQUEST_FAILED', 'medium'], ['DOCUMENT_REQUEST_FAILED', 'high']]);
  h.event('pageerror', { message: 'secret-error', stack: 'secret-stack' });
  for (const level of ['log', 'info', 'debug', 'warning', 'error']) h.event('console', { level, text: 'secret-console', url: 'https://a.test', lineNumber: 1, columnNumber: 0 });
  assert.deepEqual(h.signals.slice(4).map(s => [s.kind, s.severity]), [['PAGE_ERROR', 'high'], ['CONSOLE_ERROR', 'medium']]);
  assert.equal(JSON.stringify(h.signals).includes('secret-'), false);
});

test('safe endpoint and deterministic fingerprints ignore session/action/time and query values', () => {
  assert.equal(safeEndpoint('https://user:pass@a.test/order?token=SECRET#secret'), 'https://a.test/order');
  assert.equal(safeEndpoint('data:text/html,SECRET'), '(non-http page)');
  assert.equal(safeEndpoint('SECRET'), '(unknown endpoint)');
  const a = setup('A'), b = setup('B');
  a.response(a.request('https://a.test/order?token=SUPER_SECRET&id=123'));
  b.response(b.request('https://a.test/order?token=other&id=456'), 500, 5000);
  assert.equal(a.signals[0]!.fingerprint, b.signals[0]!.fingerprint);
  assert.equal(JSON.stringify(a.signals).includes('SUPER_SECRET'), false);
  assert.equal(JSON.stringify(a.signals).includes('id=123'), false);
  b.response(b.request('https://a.test/order', 'PUT'));
  assert.notEqual(a.signals[0]!.fingerprint, b.signals[1]!.fingerprint);
});

test('late response keeps original Action, independent page and global errors never use recent click', () => {
  const h = setup(); const a = h.action(); h.detector.onAction(a); const r = h.request();
  h.detector.onAction({ ...a, status: 'completed' });
  const b = h.action(); h.detector.onAction(b); h.response(r, 500, 3500);
  assert.equal(h.signals[0]!.actionId, a.id);
  h.event('pageerror', { message: 'other page' }, 4000, 'P2'); assert.equal(h.signals[1]!.actionId, undefined);
  h.detector.onAction({ ...b, status: 'completed' });
  h.event('pageerror', { message: 'global' }, 4100); assert.equal(h.signals[2]!.actionId, undefined);
});

test('duplicate POST burst is one immutable Signal with three requests, next Action is a second occurrence', () => {
  const h = setup();
  for (const count of [3, 2]) {
    const a = h.action(); h.detector.onAction(a);
    for (let i = 0; i < count; i++) h.request(undefined, 'POST', i * 100);
    const before = h.signals.length; h.detector.onAction({ ...a, status: 'completed' }); assert.equal(h.signals.length, before + 1);
    const signal = h.signals.at(-1)!; assert.equal(signal.facts.kind, 'DUPLICATE_REQUEST');
    assert.equal(signal.requestIds.length, count); assert.equal(signal.facts.kind === 'DUPLICATE_REQUEST' && signal.facts.count, count);
    h.detector.onAction({ ...a, status: 'completed' }); assert.equal(h.signals.length, before + 1);
  }
  assert.equal(h.signals[0]!.fingerprint, h.signals[1]!.fingerprint);
  assert.notEqual(h.signals[0]!.actionId, h.signals[1]!.actionId);
});

test('duplicate negatives: GET, single, distinct raw query, distinct method, distinct Action, outside window, no Action', () => {
  for (const mode of ['GET', 'single', 'query', 'method', 'action', 'window', 'global']) {
    const h = setup(); let a = h.action(); if (mode !== 'global') h.detector.onAction(a);
    h.request('https://a.test/x?token=one', mode === 'GET' ? 'GET' : 'POST', 0);
    if (mode === 'action') { h.detector.onAction({ ...a, status: 'completed' }); a = h.action(); h.detector.onAction(a); }
    if (mode !== 'single') h.request('https://a.test/x?token=' + (mode === 'query' ? 'two' : 'one'), mode === 'GET' ? 'GET' : mode === 'method' ? 'PUT' : 'POST', mode === 'window' ? 1001 : 100);
    h.detector.onAction({ ...a, status: 'completed' }); assert.equal(h.signals.length, 0, mode);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const h = setup(); const a = h.action(); h.detector.onAction(a); h.request(undefined, method, 0); h.request(undefined, method, 1000);
    h.detector.onAction({ ...a, status: 'completed' }); assert.equal(h.signals.length, 1, method);
  }
});

test('Finding aggregates three unique Actions, never merges kinds or resets human decisions', () => {
  const d = new SessionDetection('S', () => {}); const h = setup();
  for (let i = 0; i < 3; i++) { const a = h.action(); h.detector.onAction(a); h.response(h.request()); h.detector.onAction({ ...a, status: 'completed' }); }
  for (const signal of h.signals) d.findings.add(signal);
  const f = d.findings.list()[0]!; FindingSchema.parse(f);
  assert.equal(f.status, 'candidate'); assert.equal(f.occurrenceCount, 3); assert.equal(f.actionIds.length, 3);
  for (const status of ['known_issue', 'confirmed', 'not_issue', 'candidate'] as const) {
    d.triage(f.id, status); d.findings.add({ ...h.signals[0]!, id: randomUUID() }); assert.equal(d.findings.get(f.id)!.status, status);
  }
  h.event('console', { level: 'error', text: 'error', url: '', lineNumber: 0, columnNumber: 0 });
  d.findings.add(h.signals.at(-1)!); assert.equal(d.findings.size, 2);
  const clone = d.findings.get(f.id)!; clone.status = 'confirmed'; assert.equal(d.findings.get(f.id)!.status, 'candidate');
});

test('bounded Signal/Finding stores, retained references versus counts and visible drop stats', () => {
  const d = new SessionDetection('S', () => {}); const h = setup(); h.response(h.request()); const sample = h.signals[0]!;
  for (let i = 0; i < MAX_SIGNALS + 25; i++) {
    const s = { ...sample, id: randomUUID(), actionId: randomUUID() }; d.signals.append(s); d.findings.add(s);
  }
  assert.equal(d.signals.size, MAX_SIGNALS); assert.equal(d.stats().signalsDropped, 25);
  const f = d.findings.list()[0]!; assert.equal(f.occurrenceCount, 2025); assert.equal(f.signalIds.length, 100); assert.equal(f.actionIds.length, 100); assert.equal(f.referencesTruncated, true);
  const saved = d.signals.list()[0]!; saved.fingerprint = 'changed'; assert.notEqual(d.signals.list()[0]!.fingerprint, 'changed');
  for (let i = 0; i < MAX_FINDINGS + 10; i++) d.findings.add({ ...sample, id: randomUUID(), fingerprint: digest(i) });
  assert.equal(d.findings.size, MAX_FINDINGS); assert.equal(d.stats().findingsDropped, 11);
  d.findings.add({ ...sample, id: randomUUID() }); assert.equal(d.findings.get(f.id)!.occurrenceCount, 2026);
});

test('detector maps bounded, stop clears runtime and suppresses teardown, registry eviction removes all state', () => {
  const h = setup(); for (let i = 0; i < DETECTOR_MAP_LIMIT + 2; i++) h.request(undefined, 'GET');
  assert.ok(h.detector.runtimeSize() <= DETECTOR_MAP_LIMIT); assert.equal(h.drops(), 2);
  const a = h.action(); h.detector.onAction(a); const r = h.request(); h.request(); h.detector.stop();
  h.event('requestfailed', { requestId: r.requestId, url: r.url, error: 'cancelled' }); h.detector.onAction({ ...a, status: 'interrupted' });
  assert.equal(h.signals.length, 0); assert.equal(h.detector.runtimeSize(), 0);
  const registry = new DetectionRegistry(() => {}); registry.create('S'); const d = registry.get('S')!;
  const other = setup(); other.response(other.request()); d.findings.add(other.signals[0]!);
  registry.stop('S'); assert.equal(registry.get('S')!.findings.size, 1);
  registry.forget('S'); assert.equal(registry.get('S'), undefined); assert.equal(d.detector.runtimeSize(), 0);
});
