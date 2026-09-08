import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';
import { BrowserInputSchema, type BrowserInput, type InputAction } from '@repropath/protocol';
import { InputBuffer } from '@repropath/streaming';
import { create, freePort, ready, service, subscribe, until } from './helpers.js';

type Stream = Awaited<ReturnType<typeof subscribe>>;
const logs = (stream: Stream, text: string) => stream.events.filter(event => event.type === 'console' && event.payload.text === text).length;
async function acquire(stream: Stream, id: string): Promise<string> {
  const before = stream.messages.length; stream.socket.send(JSON.stringify({ type: 'control-acquire', sessionId: id }));
  await until(() => stream.messages.slice(before).some(message => message.type === 'control-state' && message.heldBySelf), 'control acquired');
  const state = stream.messages.slice(before).find(message => message.type === 'control-state' && message.heldBySelf);
  assert.ok(state?.type === 'control-state' && state.leaseId); return state.leaseId;
}
function inputDriver(stream: Stream, sessionId: string, pageId: string, leaseId: string) {
  let sequence = 0;
  return {
    message: (input: InputAction): BrowserInput => ({ type: 'browser-input', sessionId, pageId, leaseId,
      inputSequence: ++sequence, sourceFrameSequence: stream.frames.at(-1)?.frameSequence, input }),
    async send(input: InputAction) {
      const value = this.message(input); stream.socket.send(JSON.stringify(value));
      await until(() => stream.messages.some(message => message.type === 'input-result' && message.leaseId === leaseId && message.inputSequence === value.inputSequence), 'input result');
      const result = stream.messages.find(message => message.type === 'input-result' && message.leaseId === leaseId && message.inputSequence === value.inputSequence);
      assert.ok(result?.type === 'input-result'); assert.equal(result.ok, true, result.message); return value;
    },
  };
}
const pointer = (type: 'pointer-move' | 'pointer-down' | 'pointer-up', x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): InputAction => ({ type, x, y, button, buttons: type === 'pointer-up' ? 0 : button === 'left' ? 1 : button === 'right' ? 2 : 4 });

test('M1.3 real Control leases and Playwright input chain', { timeout: 120_000 }, async t => {
  const workerPort = await freePort(), controlPort = await freePort(), webPort = await freePort();
  const base = `http://127.0.0.1:${controlPort}`, webUrl = `http://127.0.0.1:${webPort}`;
  const worker = service('apps/browser-worker/src/index.ts', { WORKER_PORT: String(workerPort) });
  const control = service('apps/control/src/index.ts', { CONTROL_PORT: String(controlPort), WORKER_URL: `ws://127.0.0.1:${workerPort}/worker`, WEB_ORIGIN: webUrl });
  t.after(async () => { await control.stop(); await worker.stop(); }); await ready(base, true);
  const session = await create(base, `${base}/test-page/control`);
  const a = await subscribe(base, session.id), b = await subscribe(base, session.id);
  t.after(() => { a.socket.close(); b.socket.close(); });
  await until(() => a.states.at(-1)?.status === 'running' && a.frames.length > 0, 'fixture running');
  const pageId = a.states.at(-1)!.activePageId!;
  let lease = '';
  await t.test('first controller wins; lease belongs to a socket, not just a token', async () => {
    lease = await acquire(a, session.id);
    b.socket.send(JSON.stringify({ type: 'control-acquire', sessionId: session.id }));
    await until(() => b.messages.some(message => message.type === 'control-error' && message.code === 'CONTROL_BUSY'), 'second client denied');
    assert.ok(b.messages.some(message => message.type === 'control-state' && !message.heldBySelf && message.status === 'controlled' && !message.leaseId));
    const stolen: BrowserInput = { type: 'browser-input', sessionId: session.id, pageId, leaseId: lease, inputSequence: 1, input: pointer('pointer-down', 200, 140) };
    b.socket.send(JSON.stringify(stolen));
    await until(() => b.messages.some(message => message.type === 'input-result' && message.code === 'CONTROL_NOT_OWNED'), 'stolen lease denied');
    assert.equal(logs(a, 'remote-click-ok'), 0);
  });
  const driver = inputDriver(a, session.id, pageId, lease);
  await t.test('real left/right/middle clicks; action precedes browser effects', async () => {
    await driver.send(pointer('pointer-move', 200, 140));
    await driver.send(pointer('pointer-down', 200, 140)); const up = await driver.send(pointer('pointer-up', 200, 140));
    await until(() => logs(a, 'remote-click-ok') === 1, 'real DOM click');
    const action = a.events.find(event => event.type === 'human-input' && event.payload.inputSequence === up.inputSequence);
    const click = a.events.find(event => event.type === 'console' && event.payload.text === 'remote-click-ok');
    const request = a.events.find(event => event.type === 'request' && event.payload.url.endsWith('?human=1'));
    assert.ok(action?.type === 'human-input' && click && request); assert.ok(action.sequence < click.sequence && action.sequence < request.sequence);
    assert.equal(action.pageId, pageId); assert.equal(action.payload.sourceFrameSequence, up.sourceFrameSequence);
    for (const [button, log] of [['right', 'remote-right-ok'], ['middle', 'remote-middle-ok']] as const) {
      await driver.send(pointer('pointer-down', 200, 140, button)); await driver.send(pointer('pointer-up', 200, 140, button));
      await until(() => logs(a, log) > 0, `real ${button} click`);
    }
  });
  await t.test('invalid lease/page/coordinates and duplicate sequence are rejected without effects', async () => {
    const before = a.events.length;
    const invalid = [
      { ...driver.message(pointer('pointer-down', 200, 140)), leaseId: randomUUID() },
      { ...driver.message(pointer('pointer-down', 200, 140)), pageId: 'P-not-active' },
      driver.message(pointer('pointer-down', 1440, 140)),
    ];
    for (const value of invalid) a.socket.send(JSON.stringify(value));
    for (const code of ['CONTROL_NOT_OWNED', 'STALE_PAGE', 'INVALID_INPUT']) await until(() => a.messages.some(message => message.type === 'input-result' && message.code === code), code);
    assert.equal(a.events.slice(before).filter(event => event.type === 'human-input').length, 0);
    const value = await driver.send(pointer('pointer-move', 50, 50)); a.socket.send(JSON.stringify(value));
    await until(() => a.messages.some(message => message.type === 'input-result' && message.code === 'INPUT_OUT_OF_ORDER'), 'duplicate rejected');
    assert.equal(BrowserInputSchema.safeParse({ ...value, input: { type: 'wheel', x: Number.NaN, y: 0, deltaX: 0, deltaY: 10 } }).success, false);
  });
  await t.test('10,000 moves coalesce, never pollute Timeline, and do not drop following down/up', async () => {
    const buffer = new InputBuffer();
    for (let i = 0; i < 10_000; i++) buffer.offer(driver.message(pointer('pointer-move', i % 1000, 50)));
    assert.equal(buffer.stats.pending, 1); assert.equal(buffer.stats.replaced, 9999);
    buffer.offer(driver.message(pointer('pointer-down', 200, 140)));
    for (let i = 0; i < 10_000; i++) buffer.offer(driver.message(pointer('pointer-move', 200, 140)));
    buffer.offer(driver.message(pointer('pointer-up', 200, 140)));
    assert.equal(buffer.stats.pending, 4); buffer.clear();
    const clickBefore = logs(a, 'remote-click-ok');
    for (let i = 0; i < 10_000; i++) a.socket.send(JSON.stringify(driver.message(pointer('pointer-move', i % 1000, 60))));
    await driver.send(pointer('pointer-down', 200, 140)); await driver.send(pointer('pointer-up', 200, 140));
    await until(() => logs(a, 'remote-click-ok') > clickBefore, 'down/up survives move flood');
    assert.equal(a.events.filter(event => event.type === 'human-input' && (event.payload.kind as string) === 'pointer-move').length, 0);
  });
  await t.test('Unicode text, special keys, select all, slider and wheel reach the real page', async () => {
    await driver.send(pointer('pointer-down', 220, 260)); await driver.send(pointer('pointer-up', 220, 260));
    await driver.send({ type: 'text', text: 'hello测试' });
    await until(() => logs(a, 'input-length: 7') > 0, 'Unicode text length');
    assert.equal(JSON.stringify(a.events).includes('hello测试'), false);
    assert.ok(a.events.some(event => event.type === 'human-input' && event.payload.kind === 'text' && event.payload.characterCount === 7));
    await driver.send({ type: 'key', key: 'KeyA', action: 'press', modifiers: ['Control'] });
    await driver.send({ type: 'text', text: 'abc' });
    await driver.send({ type: 'key', key: 'Backspace', action: 'press', modifiers: [] });
    await driver.send({ type: 'key', key: 'Enter', action: 'press', modifiers: [] });
    await until(() => logs(a, 'enter-length: 2') > 0, 'Backspace then Enter');
    await driver.send({ type: 'key', key: 'Tab', action: 'press', modifiers: [] });
    await until(() => logs(a, 'focus: second') > 0, 'Tab moves focus');
    await driver.send(pointer('pointer-down', 150, 440)); await driver.send(pointer('pointer-move', 390, 440)); await driver.send(pointer('pointer-up', 390, 440));
    await until(() => a.events.some(event => event.type === 'console' && event.payload.text.startsWith('slider-value: ') && Number(event.payload.text.split(': ')[1]) > 80), 'native slider drag');
    await driver.send({ type: 'wheel', x: 600, y: 600, deltaX: 0, deltaY: 2100 });
    await until(() => logs(a, 'remote-scroll-ok') > 0, 'real page scrolled');
  });
  await t.test('disconnect releases ownership, new lease invalidates old token, Session close rejects input', async () => {
    const closed = once(a.socket, 'close'); a.socket.close(); await closed;
    await until(() => b.messages.some(message => message.type === 'control-state' && message.status === 'available'), 'disconnect lease release');
    const next = await acquire(b, session.id); assert.notEqual(next, lease);
    const nextDriver = inputDriver(b, session.id, pageId, next);
    b.socket.send(JSON.stringify({ ...nextDriver.message(pointer('pointer-down', 200, 140)), leaseId: lease }));
    await until(() => b.messages.some(message => message.type === 'input-result' && message.leaseId === lease && message.code === 'CONTROL_NOT_OWNED'), 'old lease fenced');
    await fetch(`${base}/sessions/${session.id}`, { method: 'DELETE' });
    await until(() => b.states.at(-1)?.status === 'closed', 'session close');
    const value = nextDriver.message(pointer('pointer-down', 200, 140)); b.socket.send(JSON.stringify(value));
    await until(() => b.messages.some(message => message.type === 'input-result' && message.leaseId === next && message.code === 'SESSION_NOT_RUNNING'), 'closed input rejected');
    const frames = b.frames.length; await delay(250); assert.equal(b.frames.length, frames);
  });

  await t.test('a real popup cannot be controlled using the active-page lease', async () => {
    const popup = await create(base, `${base}/test-page?popup=1`); const stream = await subscribe(base, popup.id);
    try {
      await until(() => stream.events.some(event => event.type === 'console' && event.payload.text === 'popup console warning'), 'popup ready');
      const log = stream.events.find(event => event.type === 'console' && event.payload.text === 'popup console warning'); assert.ok(log?.type === 'console');
      const lease = await acquire(stream, popup.id);
      const driver = inputDriver(stream, popup.id, log.pageId, lease);
      stream.socket.send(JSON.stringify(driver.message(pointer('pointer-down', 100, 100))));
      await until(() => stream.messages.some(message => message.type === 'input-result' && message.code === 'STALE_PAGE'), 'popup input rejected');
      assert.equal(stream.events.filter(event => event.type === 'human-input').length, 0);
    } finally { await fetch(`${base}/sessions/${popup.id}`, { method: 'DELETE' }); stream.socket.close(); }
  });

  await t.test('real React UI coordinate mapping, text/IME/paste, keys, wheel, release and refresh', async () => {
    const vite = service('tests/web-server.ts', { WEB_PORT: String(webPort), CONTROL_URL: base }); t.after(() => vite.stop());
    await until(async () => { try { return (await fetch(webUrl)).ok; } catch { return false; } }, 'UI ready');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1500, height: 1150 } });
      await page.goto(webUrl); await page.getByLabel('目标 URL', { exact: true }).fill(`${base}/test-page/control`);
      await page.getByRole('button', { name: 'Create Session' }).click();
      await page.getByTestId('view-status').filter({ hasText: '● LIVE' }).waitFor();
      const id = (await page.getByTestId('session-id').textContent())!;
      const observer = await subscribe(base, id); t.after(() => observer.socket.close());
      const clickAt = async (x: number, y: number) => {
        const canvas = page.getByTestId('browser-canvas'); await canvas.scrollIntoViewIfNeeded();
        const rect = await canvas.boundingBox(); assert.ok(rect);
        await page.mouse.click(rect.x + x / 1440 * rect.width, rect.y + y / 900 * rect.height);
      };
      await page.getByTestId('control-mode').filter({ hasText: 'VIEW ONLY' }).waitFor();
      await clickAt(200, 140); await delay(150); assert.equal(logs(observer, 'remote-click-ok'), 0);
      await page.getByRole('button', { name: '接管浏览器', exact: true }).click();
      await page.getByTestId('control-mode').filter({ hasText: 'HUMAN CONTROL' }).waitFor();
      await clickAt(200, 140); await until(() => logs(observer, 'remote-click-ok') === 1, 'desktop mapped click');
      await page.setViewportSize({ width: 390, height: 844 });
      await clickAt(200, 140); await until(() => logs(observer, 'remote-click-ok') === 2, 'mobile mapped click');
      await clickAt(220, 260); await page.keyboard.insertText('hello测试');
      await until(() => logs(observer, 'input-length: 7') > 0, 'UI Unicode commit');
      assert.equal(JSON.stringify(observer.events).includes('hello测试'), false);
      await page.keyboard.press('Control+A'); await page.keyboard.type('abc');
      await page.keyboard.press('Backspace'); await page.keyboard.press('Enter');
      await until(() => logs(observer, 'enter-length: 2') > 0, 'UI special keys');
      await page.keyboard.press('Control+A');
      await page.getByLabel('远程键盘输入', { exact: true }).evaluate(element => {
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '张三' }));
      });
      await until(() => observer.events.some(event => event.type === 'human-input' && event.payload.kind === 'text' && event.payload.characterCount === 2), 'IME commit');
      await page.keyboard.press('Control+A');
      await page.getByLabel('远程键盘输入', { exact: true }).evaluate(element => {
        const data = new DataTransfer(); data.setData('text/plain', 'paste测试');
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
      });
      await until(() => logs(observer, 'input-length: 7') >= 2, 'plain text paste');
      assert.equal(JSON.stringify(observer.events).includes('paste测试'), false); assert.equal(JSON.stringify(observer.events).includes('张三'), false);
      await page.setViewportSize({ width: 1500, height: 1150 });
      await page.getByTestId('browser-canvas').scrollIntoViewIfNeeded();
      const rect = await page.getByTestId('browser-canvas').boundingBox(); assert.ok(rect);
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      const hostScroll = await page.evaluate(() => scrollY); await page.mouse.wheel(0, 2100);
      await until(() => logs(observer, 'remote-scroll-ok') > 0, 'UI wheel'); assert.equal(await page.evaluate(() => scrollY), hostScroll);
      await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/m13-control.png', fullPage: true });
      await page.getByRole('button', { name: '结束接管' }).click();
      await page.getByTestId('control-mode').filter({ hasText: 'VIEW ONLY' }).waitFor();
      const actions = observer.events.filter(event => event.type === 'human-input').length;
      await clickAt(200, 140); await delay(200); assert.equal(observer.events.filter(event => event.type === 'human-input').length, actions);
      await page.getByRole('button', { name: '接管浏览器', exact: true }).click();
      await page.getByTestId('control-mode').filter({ hasText: 'HUMAN CONTROL' }).waitFor();
      await page.reload(); await page.getByTestId('view-status').filter({ hasText: '● LIVE' }).waitFor();
      await page.getByTestId('control-mode').filter({ hasText: 'VIEW ONLY' }).waitFor(); assert.equal(await page.getByTestId('session-id').textContent(), id);
      const recoveredLease = await acquire(observer, id); assert.ok(recoveredLease);
      observer.socket.send(JSON.stringify({ type: 'control-release', sessionId: id, leaseId: recoveredLease }));
      await page.getByRole('button', { name: '关闭 Session' }).click(); await page.getByTestId('status').filter({ hasText: 'closed' }).waitFor();
    } finally { await browser.close(); }
  });
  await t.test('Worker failure revokes a live control lease and rejects its remaining input', async () => {
    const active = await create(base, `${base}/test-page/control`); const stream = await subscribe(base, active.id);
    try {
      await until(() => stream.states.at(-1)?.status === 'running', 'running before failure');
      const lease = await acquire(stream, active.id);
      worker.child.kill();
      await until(() => stream.states.at(-1)?.status === 'failed', 'Worker failure state');
      assert.ok(stream.messages.some(message => message.type === 'control-state' && message.status === 'available' && message.reason?.includes('Worker')));
      stream.socket.send(JSON.stringify({ type: 'browser-input', sessionId: active.id, pageId: stream.states.at(-1)!.activePageId,
        leaseId: lease, inputSequence: 1, input: pointer('pointer-down', 100, 100) }));
      await until(() => stream.messages.some(message => message.type === 'input-result' && message.code === 'SESSION_NOT_RUNNING'), 'failed Worker input rejected');
    } finally { stream.socket.close(); }
  });
});
