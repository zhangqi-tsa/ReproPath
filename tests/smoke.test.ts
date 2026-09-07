import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { create, freePort, ready, service, subscribe, until } from './helpers.js';

test('real Chromium → Worker → Control → WebSocket → React', { timeout: 90_000 }, async t => {
  const workerPort = await freePort(); const controlPort = await freePort(); const webPort = await freePort();
  const base = `http://127.0.0.1:${controlPort}`;
  const worker = service('apps/browser-worker/src/index.ts', { WORKER_PORT: String(workerPort), NAVIGATION_TIMEOUT_MS: '2000' });
  const control = service('apps/control/src/index.ts', { CONTROL_PORT: String(controlPort), WORKER_URL: `ws://127.0.0.1:${workerPort}/worker`, WEB_ORIGIN: `http://127.0.0.1:${webPort}` });
  t.after(async () => { await control.stop(); await worker.stop(); });
  try { await ready(base, true); } catch (error) { throw new Error(`${String(error)}\n${worker.logs()}\n${control.logs()}`); }

  await t.test('invalid URL and malformed JSON are 4xx, Control remains healthy', async () => {
    for (const url of ['garbage', 'file:///etc/passwd', 'javascript:alert(1)', 'http://user:password@localhost']) {
      const response = await fetch(`${base}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      assert.equal(response.status, 400); assert.ok((await response.json() as { error: string }).error);
    }
    const bad = await fetch(`${base}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(bad.status, 400); await ready(base, true);
  });

  const session = await create(base, `${base}/test-page?navigate=1`);
  assert.equal(session.status, 'starting');
  const stream = await subscribe(base, session.id); t.after(() => stream.socket.close());
  await t.test('all runtime events, request association, real title and later navigation', async () => {
    await until(() => stream.events.some(event => event.type === 'pageerror') && stream.states.some(state => state.pageTitle.endsWith('Next')), 'complete browser event chain');
    for (const type of ['navigation', 'request', 'response', 'console', 'pageerror']) assert.ok(stream.events.some(event => event.type === type), type);
    assert.ok(stream.states.some(state => state.status === 'running'));
    assert.equal(stream.states.at(-1)?.currentUrl, `${base}/test-page/next`);
    assert.equal(stream.states.at(-1)?.pageTitle, 'ReproPath Fixture — Next');
    const response = stream.events.find(event => event.type === 'response' && event.payload.url.endsWith('/fixture/api/user'));
    assert.ok(response?.type === 'response'); assert.equal(response.payload.status, 200);
    assert.ok(stream.events.some(event => event.type === 'request' && event.payload.requestId === response.payload.requestId && event.payload.method === 'GET'));
    assert.ok(stream.events.some(event => event.type === 'console' && event.payload.text === 'hello from ReproPath fixture'));
    assert.ok(stream.events.some(event => event.type === 'pageerror' && event.payload.message.includes('intentional error')));
    assert.equal(new Set(stream.events.map(event => event.id)).size, stream.events.length);
    for (let i = 1; i < stream.events.length; i++) assert.ok(stream.events[i]!.sequence > stream.events[i - 1]!.sequence);
    assert.ok(stream.messages.some(message => message.type === 'event'), 'live events, not just snapshot');
  });
  await t.test('real JPEG frames are separate from events; page and main-frame identity survive navigation', async () => {
    await until(() => stream.frames.length >= 3, 'several CDP frames');
    const activePageId = stream.states.at(-1)?.activePageId;
    for (const frame of stream.frames) {
      assert.equal(frame.sessionId, session.id); assert.equal(frame.pageId, activePageId);
      assert.equal(frame.mimeType, 'image/jpeg'); assert.equal(frame.width, 1440); assert.equal(frame.height, 900);
      const jpeg = Buffer.from(frame.data, 'base64'); assert.ok(jpeg.length > 1000);
      assert.equal(jpeg.readUInt16BE(0), 0xffd8); assert.equal(jpeg.readUInt16BE(jpeg.length - 2), 0xffd9);
    }
    for (let i = 1; i < stream.frames.length; i++) assert.ok(stream.frames[i]!.frameSequence > stream.frames[i - 1]!.frameSequence);
    const navigations = stream.events.filter(event => event.type === 'navigation').filter(event => event.payload.isMainFrame);
    assert.ok(navigations.length >= 2);
    assert.equal(new Set(navigations.map(event => event.pageId)).size, 1);
    assert.equal(new Set(navigations.map(event => event.payload.frameId)).size, 1);
    for (const event of stream.events) if (event.type !== 'lifecycle') assert.equal(event.pageId, activePageId);
    assert.ok(stream.events.every(event => event.type !== ('browser-frame' as string)));
    const log = stream.events.find(event => event.type === 'console' && event.payload.text === 'hello from ReproPath fixture');
    assert.ok(log?.type === 'console'); assert.ok(log.payload.url.includes('/test-page'));
    assert.ok(log.payload.lineNumber >= 0); assert.ok(log.payload.columnNumber >= 0);
  });
  await t.test('slow UI gets only one in-flight frame; fast UI and events keep flowing', async () => {
    const slow = await subscribe(base, session.id, false);
    try {
      await until(() => slow.frames.length === 1, 'slow client first frame');
      const first = slow.frames[0]!; const count = stream.frames.length;
      await until(() => stream.frames.length >= count + 6, 'fast consumer progresses while slow consumer does not ACK');
      assert.equal(slow.frames.length, 1, 'no renderer receive-queue growth');
      slow.socket.send(JSON.stringify({ type: 'frame-ack', sessionId: first.sessionId, pageId: first.pageId, frameSequence: first.frameSequence }));
      await until(() => slow.frames.length === 2, 'slow consumer receives latest frame');
      assert.ok(slow.frames[1]!.frameSequence > first.frameSequence + 1, 'intermediate frames dropped');
      assert.ok(slow.events.length > 0);
      assert.ok(slow.messages.filter(message => message.type === 'snapshot').every(message => message.events.every(event => event.type !== ('browser-frame' as string))));
    } finally { slow.socket.close(); }
  });
  await t.test('popup has independent page identity and original active page keeps the screencast', async () => {
    const popupSession = await create(base, `${base}/test-page?popup=1`);
    const popupStream = await subscribe(base, popupSession.id);
    try {
      await until(() => popupStream.events.some(event => event.type === 'console' && event.payload.text === 'popup console warning'), 'popup console captured');
      const active = popupStream.states.at(-1)?.activePageId;
      const popupLog = popupStream.events.find(event => event.type === 'console' && event.payload.text === 'popup console warning');
      assert.ok(popupLog?.type === 'console'); assert.notEqual(popupLog.pageId, active);
      const popupEvents = popupStream.events.filter(event => event.type !== 'lifecycle' && event.pageId === popupLog.pageId);
      assert.ok(popupEvents.some(event => event.type === 'navigation' && event.payload.url.endsWith('/test-page/popup')));
      assert.ok(popupEvents.some(event => event.type === 'request' && event.payload.url.endsWith('/test-page/popup')), 'initial popup request retained');
      assert.ok(popupEvents.some(event => event.type === 'response' && event.payload.url.endsWith('/test-page/popup')), 'initial popup response retained');
      assert.equal(popupLog.payload.level, 'warning'); assert.ok(popupLog.payload.url.endsWith('/test-page/popup'));
      await until(() => popupStream.frames.length >= 3, 'active page frames with popup');
      assert.ok(popupStream.frames.every(frame => frame.pageId === active));
      assert.equal(popupStream.states.at(-1)?.currentUrl, `${base}/test-page?popup=1`);
    } finally { await fetch(`${base}/sessions/${popupSession.id}`, { method: 'DELETE' }); popupStream.socket.close(); }
  });
  await t.test('disconnect, late subscribe and close preserve history and state', async () => {
    stream.socket.close();
    const again = await subscribe(base, session.id);
    try {
      assert.ok(again.events.some(event => event.type === 'pageerror'));
      assert.equal(again.messages[0]?.type, 'snapshot');
      assert.equal((await fetch(`${base}/sessions/${session.id}`, { method: 'DELETE' })).status, 202);
      await until(() => again.states.at(-1)?.status === 'closed', 'closed state');
      const frameCount = again.frames.length; await delay(400); assert.equal(again.frames.length, frameCount, 'frames stop after close');
      const closedStream = await subscribe(base, session.id);
      try { await delay(250); assert.equal(closedStream.frames.length, 0, 'closed session has no cached frame'); }
      finally { closedStream.socket.close(); }
    } finally { again.socket.close(); }
  });
  await t.test('connection refusal fails only the affected session', async () => {
    const unavailable = await freePort();
    const failed = await create(base, `http://127.0.0.1:${unavailable}/missing`);
    const stream = await subscribe(base, failed.id);
    try { await until(() => stream.states.at(-1)?.status === 'failed', 'failed navigation'); assert.ok(stream.states.at(-1)?.error); }
    finally { stream.socket.close(); }
    await ready(base, true);
  });
  await t.test('React decodes live JPEGs, restores by URL/refresh, keeps ratio and closes', async () => {
    const vite = service('tests/web-server.ts', { WEB_PORT: String(webPort), CONTROL_URL: base });
    t.after(() => vite.stop());
    try { await until(async () => { try { return (await fetch(`http://127.0.0.1:${webPort}`)).ok; } catch { return false; } }, 'Vite ready'); }
    catch (error) { throw new Error(`${String(error)}\n${vite.logs()}`); }
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${webPort}`);
      await page.getByLabel('目标 URL', { exact: true }).fill(`${base}/test-page`);
      await page.getByRole('button', { name: 'Create Session' }).click();
      await page.locator('[data-testid="status"]').filter({ hasText: 'running' }).waitFor();
      await page.locator('.event.pageerror').first().waitFor();
      await page.getByTestId('view-status').filter({ hasText: '● LIVE' }).waitFor();
      assert.match(new URL(page.url()).pathname, /^\/session\/[^/]+$/);
      const sessionId = await page.getByTestId('session-id').textContent();
      const pageId = await page.getByTestId('page-id').textContent();
      const canvas = page.getByTestId('browser-canvas');
      const firstFrame = Number(await canvas.getAttribute('data-frame-sequence'));
      await until(async () => Number(await canvas.getAttribute('data-frame-sequence')) > firstFrame, 'view repaints without refresh');
      const pixels = await canvas.evaluate(element => {
        const canvas = element as HTMLCanvasElement;
        return { width: canvas.width, height: canvas.height, alpha: canvas.getContext('2d')!.getImageData(10, 10, 1, 1).data[3] };
      });
      assert.deepEqual(pixels, { width: 1440, height: 900, alpha: 255 });
      await page.reload();
      await page.getByTestId('view-status').filter({ hasText: '● LIVE' }).waitFor();
      assert.equal(await page.getByTestId('session-id').textContent(), sessionId);
      assert.equal(await page.getByTestId('page-id').textContent(), pageId);
      await page.locator('.event.pageerror').first().waitFor();
      assert.equal(await page.getByTestId('page-title').textContent(), 'ReproPath Fixture');
      assert.equal(await page.getByTestId('current-url').textContent(), `${base}/test-page`);
      for (const type of ['navigation', 'request', 'response', 'console', 'pageerror']) assert.ok(await page.locator(`.event.${type}`).count());
      await mkdir('test-results', { recursive: true });
      await page.screenshot({ path: 'test-results/web-desktop.png', fullPage: true });
      assert.equal(await page.locator('.event.browser-frame').count(), 0);
      await page.setViewportSize({ width: 390, height: 844 });
      const rect = await canvas.boundingBox(); assert.ok(rect); assert.ok(Math.abs(rect.width / rect.height - 1440 / 900) < 0.01);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: 'test-results/web-mobile.png', fullPage: true });
      await page.getByRole('button', { name: '关闭 Session' }).click();
      await page.getByTestId('status').filter({ hasText: 'closed' }).waitFor();
      await page.getByTestId('view-status').filter({ hasText: '浏览器 Session 已关闭' }).waitFor();
      await page.reload();
      await page.getByTestId('status').filter({ hasText: 'closed' }).waitFor();
      await page.goto(`http://127.0.0.1:${webPort}/session/missing-session`);
      await page.getByRole('alert').filter({ hasText: 'Session 不存在或已过期' }).waitFor();
    } finally { await browser.close(); }
  });
  await t.test('static page restores its current frame after a period with no UI subscriber', async () => {
    const staticSession = await create(base, `${base}/test-page?static=1`);
    await delay(1200);
    const first = await subscribe(base, staticSession.id);
    try { await until(() => first.frames.length > 0, 'static frame without earlier subscriber'); }
    finally { first.socket.close(); }
    await delay(300);
    const second = await subscribe(base, staticSession.id);
    try { await until(() => second.frames.length > 0, 'static frame on fresh subscription'); assert.equal(second.frames[0]?.pageId, first.frames[0]?.pageId); }
    finally { second.socket.close(); await fetch(`${base}/sessions/${staticSession.id}`, { method: 'DELETE' }); }
  });
  await t.test('Worker loss marks active sessions failed; API survives and recovers', async () => {
    const active = await create(base, `${base}/test-page`); const stream = await subscribe(base, active.id);
    try {
      await until(() => stream.states.at(-1)?.status === 'running', 'running before worker loss');
      worker.child.kill();
      await until(() => stream.states.at(-1)?.status === 'failed', 'worker disconnected');
      const unavailable = await fetch(`${base}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `${base}/test-page` }) });
      assert.equal(unavailable.status, 503);
      const replacement = service('apps/browser-worker/src/index.ts', { WORKER_PORT: String(workerPort) });
      t.after(() => replacement.stop()); await ready(base, true);
      const recovered = await create(base, `${base}/test-page`); const recoveredStream = await subscribe(base, recovered.id);
      try { await until(() => recoveredStream.states.at(-1)?.status === 'running', 'runtime recovers'); }
      finally { recoveredStream.socket.close(); }
    } finally { stream.socket.close(); }
  });
});
