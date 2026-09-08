import { readFile } from 'node:fs/promises';
import type { BrowserContext } from 'playwright';

// Local opt-in only. Never expose this file or its values through Control or Timeline.
export async function seedSessionAuth(context: BrowserContext, requestedUrl: string): Promise<void> {
  const path = process.env.REPROPATH_AUTH_FILE;
  if (!path) return;
  try {
    const raw = await readFile(path, 'utf8');
    if (raw.length > 32_768) throw new Error();
    const config: unknown = JSON.parse(raw);
    if (!config || typeof config !== 'object' || !('origin' in config) || !('cookieHeader' in config)
      || typeof config.origin !== 'string' || typeof config.cookieHeader !== 'string') throw new Error();
    const origin = new URL(config.origin);
    if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password
      || origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
    if (new URL(requestedUrl).origin !== origin.origin) return;
    const cookies = config.cookieHeader.split(';').map(part => {
      const separator = part.indexOf('=');
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (separator < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\x00]/.test(value)) throw new Error();
      // A Cookie request header has no original attributes. Use a host-only session cookie.
      return { name, value, url: origin.origin + '/', secure: origin.protocol === 'https:', sameSite: 'Lax' as const };
    });
    await context.addCookies(cookies);
  } catch {
    // Playwright errors may include cookie values: never propagate the original exception.
    throw new Error('Local session authentication configuration could not be loaded');
  }
}
