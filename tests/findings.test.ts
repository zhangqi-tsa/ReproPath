import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { ActionRecordSchema, FindingListSchema, SignalListSchema, WorkerCommandSchema, type FindingStatus } from '@repropath/protocol';
import { create, freePort, ready, service, subscribe, until } from './helpers.js';

test('M1.5 real Human Control → browser events → Signals → Findings → triage and existing Evidence', { timeout: 150_000 }, async t => {
  const wp = await freePort(), cp = await freePort(), vp = await freePort();
  const base = `http://127.0.0.1:${cp}`, web = `http://127.0.0.1:${vp}`;
  const dir = resolve('test-results', `m15-${randomUUID()}`);
  const worker = service('apps/browser-worker/src/index.ts', { WORKER_PORT: String(wp), REPROPATH_AUTH_FILE: '', REPROPATH_ARTIFACT_DIR: dir });
  const control = service('apps/control/src/index.ts', { CONTROL_PORT: String(cp), WORKER_URL: `ws://127.0.0.1:${wp}/worker`, WEB_ORIGIN: web, REPROPATH_ARTIFACT_DIR: dir });
  const vite = service('tests/web-server.ts', { WEB_PORT: String(vp), CONTROL_URL: base });
  t.after(async () => { await vite.stop(); await control.stop(); await worker.stop(); });
  await ready(base, true); await until(async () => { try { return (await fetch(web)).ok; } catch { return false; } }, 'web ready');
  const session = await create(base, base + '/test-page/signals?global=1');
  const stream = await subscribe(base, session.id); t.after(() => stream.socket.close());
  const signals = async () => SignalListSchema.parse(await fetch(base + `/sessions/${session.id}/signals`).then(r => r.json())).signals;
  const findings = async () => FindingListSchema.parse(await fetch(base + `/sessions/${session.id}/findings`).then(r => r.json())).findings;
  const actions = async () => ActionRecordSchema.array().parse(await fetch(base + `/sessions/${session.id}/actions`).then(r => r.json()));
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  // Plain script avoids tsx's class-name helper leaking into the serialized browser realm.
  await page.addInitScript(`{
    const sockets = []; const Native = window.WebSocket;
    window.WebSocket = class extends Native { constructor(url, protocols) { super(url, protocols); sockets.push(this); } };
    window.closeTestSockets = () => sockets.forEach(socket => socket.close());
  }`);
  await page.goto(web + '/session/' + session.id);
  const card = (kind: string) => page.locator(`.finding-card[data-kind="${kind}"]`);
  const acquire = async () => { await page.getByTestId('view-status').filter({ hasText: 'LIVE' }).waitFor(); await page.getByRole('button', { name: '接管浏览器', exact: true }).click(); await page.getByTestId('control-mode').filter({ hasText: 'HUMAN CONTROL' }).waitFor(); };
  const click = async (index: number, wait = true) => {
    const before = (await actions()).length;
    const canvas = page.getByTestId('browser-canvas'); await canvas.scrollIntoViewIfNeeded(); const rect = await canvas.boundingBox(); assert.ok(rect);
    await page.mouse.click(rect.x + (182 + index % 3 * 318) / 1440 * rect.width, rect.y + (192 + Math.floor(index / 3) * 83) / 900 * rect.height);
    await until(async () => (await actions()).length === before + 1, 'click Action');
    if (wait) await until(async () => (await actions()).at(-1)?.status === 'completed', 'completed Action');
    return (await actions()).at(-1)!;
  };
  await acquire();

  await t.test('global console error has no Action and renders source event', async () => {
    await until(async () => (await signals()).some(s => s.kind === 'CONSOLE_ERROR'), 'global signal');
    const s = (await signals()).find(s => s.kind === 'CONSOLE_ERROR')!; assert.equal(s.actionId, undefined);
    await card('CONSOLE_ERROR').getByRole('button', { name: '查看', exact: true }).click();
    await page.getByText('该异常发生在页面自主行为中，没有关联人工 Action。').waitFor();
    await card('CONSOLE_ERROR').locator('summary').click(); await card('CONSOLE_ERROR').getByText(/Signal fixture global error/).waitFor();
  });
  let httpFindingId = '';
  await t.test('HTTP 500 realtime Signal, candidate Finding, request/action correlation and Before/After', async () => {
    const action = await click(0); const ss = (await signals()).filter(s => s.kind === 'HTTP_5XX'); assert.equal(ss.length, 1);
    const s = ss[0]!; assert.equal(s.actionId, action.id); assert.equal(s.severity, 'high'); assert.ok(action.networkRequestIds.includes(s.requestIds[0]!));
    assert.equal(s.facts.kind === 'HTTP_5XX' && s.facts.status, 500);
    const fs = (await findings()).filter(f => f.signalKind === 'HTTP_5XX'); assert.equal(fs.length, 1); assert.equal(fs[0]!.status, 'candidate'); assert.equal(fs[0]!.occurrenceCount, 1); httpFindingId = fs[0]!.id;
    assert.ok(stream.messages.some(m => m.type === 'signal-created' && m.signal.id === s.id));
    assert.ok(stream.messages.some(m => m.type === 'finding-update' && m.finding.id === httpFindingId));
    await card('HTTP_5XX').getByRole('button', { name: '查看', exact: true }).click();
    await card('HTTP_5XX').getByRole('button', { name: /human · CLICK/ }).click();
    await card('HTTP_5XX').getByAltText('Before evidence').waitFor(); await card('HTTP_5XX').getByAltText('After evidence').waitFor();
    assert.equal(action.evidenceStatus, 'complete');
    await until(async () => card('HTTP_5XX').getByText(/HTTP 500 · http/).count().then(n => n > 0), 'related network');
  });
  await t.test('three Actions aggregate, human confirmation persists, all triage statuses and validation', async () => {
    await card('HTTP_5XX').getByRole('button', { name: '确认问题', exact: true }).click();
    await card('HTTP_5XX').getByText('已确认问题', { exact: true }).waitFor();
    await click(0); await click(0);
    let f = (await findings()).find(f => f.id === httpFindingId)!; assert.equal(f.occurrenceCount, 3); assert.equal(f.actionIds.length, 3); assert.equal(f.status, 'confirmed');
    const patch = (status: string, id = httpFindingId) => fetch(base + `/sessions/${session.id}/findings/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    for (const status of ['candidate', 'not_issue', 'known_issue'] satisfies FindingStatus[]) assert.equal((await patch(status)).status, 200);
    await click(0); f = (await findings()).find(f => f.id === httpFindingId)!; assert.equal(f.status, 'known_issue'); assert.equal(f.occurrenceCount, 4);
    assert.equal((await patch('candidate')).status, 200); assert.equal((await patch('confirmed')).status, 200);
    assert.equal((await patch('bug')).status, 400); assert.equal((await patch('candidate', randomUUID())).status, 404);
    assert.equal((await fetch(base + `/sessions/${session.id}/findings/${randomUUID()}`)).status, 404);
    assert.equal((await fetch(base + `/sessions/${randomUUID()}/signals`)).status, 404);
    const detail = await fetch(base + `/sessions/${session.id}/findings/${httpFindingId}`).then(r => r.json()); assert.equal(detail.status, 'confirmed');
  });
  await t.test('one triple POST Signal; single POST, GET and warning negatives; HTTP 404 is not HTTP_5XX', async () => {
    const a = await click(4); let ss = (await signals()).filter(s => s.kind === 'DUPLICATE_REQUEST');
    assert.equal(ss.length, 1); assert.equal(ss[0]!.actionId, a.id); assert.equal(ss[0]!.requestIds.length, 3); assert.equal(ss[0]!.facts.kind === 'DUPLICATE_REQUEST' && ss[0]!.facts.count, 3);
    const beforeHttp = (await signals()).filter(s => s.kind === 'HTTP_5XX').length;
    await click(5); await click(7); const beforeWarning = (await signals()).length; await click(8); assert.equal((await signals()).length, beforeWarning);
    await click(6); assert.equal((await signals()).filter(s => s.kind === 'HTTP_5XX').length, beforeHttp);
    ss = (await signals()).filter(s => s.kind === 'DUPLICATE_REQUEST'); assert.equal(ss.length, 1);
    await click(4); const f = (await findings()).find(f => f.signalKind === 'DUPLICATE_REQUEST')!; assert.equal(f.occurrenceCount, 2); assert.equal(f.actionIds.length, 2);
  });
  await t.test('real pageerror/console/error and socket destruction; different kinds stay separate', async () => {
    const pageAction = await click(2); const s = (await signals()).find(s => s.kind === 'PAGE_ERROR')!; assert.equal(s.actionId, pageAction.id);
    assert.ok(stream.events.some(e => e.id === s.sourceEventIds[0] && e.type === 'pageerror' && e.payload.message === 'Signal fixture page error'));
    await card('PAGE_ERROR').getByRole('button', { name: '查看', exact: true }).click(); await card('PAGE_ERROR').locator('summary').click();
    await card('PAGE_ERROR').getByText(/Signal fixture page error/).waitFor();
    const consoleAction = await click(3); assert.ok((await signals()).some(s => s.kind === 'CONSOLE_ERROR' && s.actionId === consoleAction.id));
    const failed = await click(1); const failedSignals = (await signals()).filter(s => s.actionId === failed.id && s.kind === 'REQUEST_FAILED'); assert.equal(failedSignals.length, 1);
    assert.equal((await signals()).filter(s => s.actionId === failed.id && s.kind === 'DOCUMENT_REQUEST_FAILED').length, 0);
    const combined = await click(11); const kinds = (await signals()).filter(s => s.actionId === combined.id).map(s => s.kind);
    assert.ok(kinds.includes('HTTP_5XX')); assert.ok(kinds.includes('CONSOLE_ERROR'));
    const fs = (await findings()).filter(f => f.actionIds.includes(combined.id)); assert.ok(fs.some(f => f.signalKind === 'HTTP_5XX')); assert.ok(fs.some(f => f.signalKind === 'CONSOLE_ERROR'));
  });
  await t.test('slow HTTP 500 after settle retains original request → Action', async () => {
    const action = await click(9); assert.equal(action.settle?.timedOut, true);
    await until(async () => (await signals()).some(s => s.kind === 'HTTP_5XX' && s.actionId === action.id), 'late signal');
    const s = (await signals()).find(s => s.kind === 'HTTP_5XX' && s.actionId === action.id)!;
    const response = stream.events.find(e => e.type === 'response' && e.payload.requestId === s.requestIds[0]); assert.ok(response); assert.ok(response.sequence > action.eventSequenceEnd!);
  });
  await t.test('query values and message originals absent from Signal/Finding JSON; raw Timeline kept', async () => {
    await click(13); const serialized = JSON.stringify([await signals(), await findings()]);
    for (const text of ['SUPER_SECRET', 'id=123', 'Signal fixture page error', 'Signal fixture console error']) assert.equal(serialized.includes(text), false, text);
    assert.ok(stream.events.some(e => e.type === 'request' && e.payload.url.includes('SUPER_SECRET')));
  });
  await t.test('refresh and websocket reconnect restore triage, Signals and Action Evidence', async () => {
    const count = (await findings()).length; await page.reload();
    await page.getByTestId('control-mode').filter({ hasText: 'VIEW ONLY' }).waitFor();
    await until(async () => (await page.getByTestId('finding-card').count()) === count, 'restored Findings');
    await page.locator(`.finding-card`).filter({ has: page.locator('h3', { hasText: `HTTP 500 · GET ${base}/fixture/signal/500` }) }).getByText('已确认问题', { exact: true }).waitFor();
    await page.evaluate(() => (window as unknown as { closeTestSockets: () => void }).closeTestSockets());
    await page.getByText('连接中断，正在重连', { exact: true }).waitFor();
    await page.getByText('实时连接', { exact: true }).waitFor();
    await until(async () => (await page.getByTestId('finding-card').count()) === count, 'reconnected Findings');
    await acquire();
  });
  await t.test('explicit close with pending request creates no teardown Signals, closed Evidence retained', async () => {
    const a = await click(12, false); await until(() => stream.events.some(e => e.type === 'request' && e.payload.url.endsWith('/pending')), 'pending network');
    const count = (await signals()).length;
    await page.getByRole('button', { name: '关闭 Session', exact: true }).click(); await page.getByTestId('status').filter({ hasText: 'closed' }).waitFor();
    assert.equal((await signals()).length, count);
    const completed = (await actions()).find(a => a.evidenceStatus === 'complete')!; assert.ok(completed.before?.screenshot);
    assert.equal((await fetch(base + '/artifacts/' + completed.before.screenshot.id)).status, 200);
    assert.equal((await actions()).find(x => x.id === a.id)?.status, 'interrupted');
    await page.reload(); await page.getByTestId('status').filter({ hasText: 'closed' }).waitFor();
    await until(async () => await page.getByTestId('finding-card').count() > 0, 'closed restored Findings');
    await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });

  await t.test('real document failure is exclusively DOCUMENT_REQUEST_FAILED', async () => {
    const failed = await create(base, base + '/fixture/signal/document-failed');
    await until(async () => {
      const data = SignalListSchema.parse(await fetch(base + `/sessions/${failed.id}/signals`).then(r => r.json()));
      return data.signals.some(s => s.kind === 'DOCUMENT_REQUEST_FAILED');
    }, 'document failure Signal');
    const ss = SignalListSchema.parse(await fetch(base + `/sessions/${failed.id}/signals`).then(r => r.json())).signals;
    assert.equal(ss.filter(s => s.kind === 'DOCUMENT_REQUEST_FAILED').length, 1); assert.equal(ss.filter(s => s.kind === 'REQUEST_FAILED').length, 0);
  });
});

test('M1.5 Control API/UI expose bounded stores and dropped warning', { timeout: 60_000 }, async t => {
  const wp = await freePort(), cp = await freePort(), vp = await freePort();
  const base = `http://127.0.0.1:${cp}`, web = `http://127.0.0.1:${vp}`;
  const wss = new WebSocketServer({ port: wp, host: '127.0.0.1' }); await once(wss, 'listening');
  t.after(() => { for (const socket of wss.clients) socket.terminate(); wss.close(); });
  wss.on('connection', socket => socket.on('message', raw => {
    const message = WorkerCommandSchema.parse(JSON.parse(raw.toString()));
    if (message.type !== 'start') return;
    socket.send(JSON.stringify({ type: 'state', session: { ...message.session, status: 'running', currentUrl: message.session.requestedUrl, activePageId: 'P' } }));
    for (let i = 0; i < 2025; i++) socket.send(JSON.stringify({ type: 'event', event: {
      id: randomUUID(), sessionId: message.session.id, pageId: 'P', sequence: i + 1, timestamp: new Date().toISOString(), type: 'pageerror', payload: { message: 'bounded fixture ' + (i < 501 ? i : 0) },
    } }));
  }));
  const control = service('apps/control/src/index.ts', { CONTROL_PORT: String(cp), WORKER_URL: `ws://127.0.0.1:${wp}`, WEB_ORIGIN: web });
  const vite = service('tests/web-server.ts', { WEB_PORT: String(vp), CONTROL_URL: base });
  t.after(async () => { await vite.stop(); await control.stop(); }); await ready(base, true);
  await until(async () => { try { return (await fetch(web)).ok; } catch { return false; } }, 'web ready');
  const session = await create(base, base + '/test-page/signals');
  const get = async () => FindingListSchema.parse(await fetch(base + `/sessions/${session.id}/findings`).then(r => r.json()));
  await until(async () => (await get()).stats.signalsDropped === 25, 'bounded events processed');
  const result = await get(); assert.equal(result.findings.length, 500); assert.equal(result.stats.findingsDropped, 1);
  assert.equal(result.findings[0]!.occurrenceCount, 1525); assert.equal(result.findings[0]!.signalIds.length, 100);
  const ss = SignalListSchema.parse(await fetch(base + `/sessions/${session.id}/signals`).then(r => r.json())); assert.equal(ss.signals.length, 2000);
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage();
  await page.goto(web + '/session/' + session.id);
  await page.getByRole('alert').filter({ hasText: '检测结果已达到当前 Session 上限' }).waitFor();
  assert.equal(await page.getByTestId('finding-card').count(), 500);
  await page.getByTestId('finding-card').first().getByRole('button', { name: '查看', exact: true }).click();
  await page.getByText(/引用已截断/).first().waitFor();
});
