import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
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
  await t.test('disconnect, late subscribe and close preserve history and state', async () => {
    stream.socket.close();
    const again = await subscribe(base, session.id);
    try {
      assert.ok(again.events.some(event => event.type === 'pageerror'));
      assert.equal(again.messages[0]?.type, 'snapshot');
      assert.equal((await fetch(`${base}/sessions/${session.id}`, { method: 'DELETE' })).status, 202);
      await until(() => again.states.at(-1)?.status === 'closed', 'closed state');
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
  await t.test('React renders live events and close action in a real browser', async () => {
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
      assert.equal(await page.getByTestId('page-title').textContent(), 'ReproPath Fixture');
      assert.equal(await page.getByTestId('current-url').textContent(), `${base}/test-page`);
      for (const type of ['navigation', 'request', 'response', 'console', 'pageerror']) assert.ok(await page.locator(`.event.${type}`).count());
      await mkdir('test-results', { recursive: true });
      await page.screenshot({ path: 'test-results/web-desktop.png', fullPage: true });
      await page.getByRole('button', { name: '关闭 Session' }).click();
      await page.getByTestId('status').filter({ hasText: 'closed' }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: 'test-results/web-mobile.png', fullPage: true });
    } finally { await browser.close(); }
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
