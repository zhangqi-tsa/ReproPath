import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { seedSessionAuth } from '../apps/browser-worker/src/session-auth.js';

test('local auth is origin-scoped, host-only and errors never include values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'repropath-auth-'));
  const previous = process.env.REPROPATH_AUTH_FILE;
  const browser = await chromium.launch();
  try {
    const path = join(dir, 'auth.json'); process.env.REPROPATH_AUTH_FILE = path;
    await writeFile(path, JSON.stringify({ origin: 'https://example.com', cookieHeader: 'session=test-secret=abc' }));
    const context = await browser.newContext();
    await seedSessionAuth(context, 'https://other.example.com/');
    assert.equal((await context.cookies()).length, 0);
    await seedSessionAuth(context, 'http://example.com/');
    assert.equal((await context.cookies()).length, 0);
    await seedSessionAuth(context, 'https://example.com/path');
    const cookies = await context.cookies('https://example.com/');
    assert.equal(cookies[0]?.value, 'test-secret=abc');
    assert.equal(cookies[0]?.domain, 'example.com');
    let forwarded: string | undefined;
    await context.route('https://child.example.com/**', async route => { forwarded = (await route.request().allHeaders()).cookie; await route.fulfill({ body: 'ok' }); });
    const page = await context.newPage(); await page.goto('https://child.example.com/');
    assert.equal(forwarded, undefined);
    await writeFile(path, JSON.stringify({ origin: 'https://example.com', cookieHeader: 'session=test-secret\n' + 'abc' }));
    await assert.rejects(seedSessionAuth(context, 'https://example.com'), { message: 'Local session authentication configuration could not be loaded' });
  } finally {
    if (previous === undefined) delete process.env.REPROPATH_AUTH_FILE; else process.env.REPROPATH_AUTH_FILE = previous;
    await browser.close(); await rm(dir, { recursive: true, force: true });
  }
});

