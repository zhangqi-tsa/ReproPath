import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type { ActionRecord, ActionTarget, EvidenceSnapshot } from '@repropath/protocol';
import type { ArtifactStore } from '@repropath/artifacts';

export const MASK_SELECTOR = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=range]):not([type=color]),textarea,[contenteditable]:not([contenteditable=false]),iframe,frame';
async function bounded<T>(promise: Promise<T>, ms = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Evidence timeout')), ms); })]); }
  finally { clearTimeout(timer!); }
}
export async function identifyTarget(page: Page, point?: { x: number; y: number }): Promise<ActionTarget | undefined> {
  try { return await bounded(page.evaluate(point => {
    const element = point ? document.elementFromPoint(point.x, point.y) : document.activeElement;
    if (!element) return undefined;
    const editable = !!element.closest('input,textarea,select,[contenteditable]:not([contenteditable=false])');
    return { tagName: element.tagName.toLowerCase(), role: element.getAttribute('role')?.slice(0,120) || undefined, ariaLabel: element.getAttribute('aria-label')?.slice(0,120) || undefined,
      name: element.getAttribute('name')?.slice(0,120) || undefined, type: element.getAttribute('type')?.slice(0,120) || undefined, testId: element.getAttribute('data-testid')?.slice(0,120) || undefined,
      text: editable || element.querySelector('input,textarea,select,[contenteditable]') ? undefined : element.textContent?.trim().slice(0, 120) };
  }, point), 150); } catch { return undefined; }
}
export async function sanitizedDOM(page: Page): Promise<string> {
  return bounded(page.evaluate(() => {
    const root = document.documentElement.cloneNode(true) as HTMLElement;
    root.querySelectorAll('script,style,noscript,template,iframe,frame,object,embed').forEach(element => element.remove());
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT); const comments: Node[] = [];
    while (walker.nextNode()) comments.push(walker.currentNode); comments.forEach(node => node.parentNode?.removeChild(node));
    root.querySelectorAll('textarea,select,[contenteditable]:not([contenteditable=false])').forEach(element => { element.textContent = '[REDACTED]'; });
    for (const element of [root, ...root.querySelectorAll('*')]) {
      for (const attr of [...element.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || ['srcdoc', 'style'].includes(name) || (name.startsWith('data-') && !['data-testid', 'data-test', 'data-cy'].includes(name))) element.removeAttribute(attr.name);
        else if (/password|passwd|secret|token|auth|cookie|session|credential|api-?key/.test(name) || name === 'value') element.setAttribute(attr.name, '[REDACTED]');
      }
      if (element.tagName === 'INPUT') element.setAttribute('value', '[REDACTED]');
    }
    return '<!doctype html>\n' + root.outerHTML;
  }));
}
export class EvidenceCapture {
  private bytes = 0;
  constructor(private store: ArtifactStore, private quota = 256 * 1024 * 1024) {}
  async capture(page: Page, action: ActionRecord, phase: 'before' | 'after', enabled: boolean): Promise<EvidenceSnapshot> {
    const snapshot: EvidenceSnapshot = { id: randomUUID(), sessionId: action.sessionId, actionId: action.id, pageId: action.pageId, phase,
      capturedAt: new Date().toISOString(), url: page.url(), title: '', viewport: page.viewportSize() ?? { width: 1440, height: 900 } };
    try { snapshot.title = await bounded(page.title(), 100); } catch { /* unavailable during navigation */ }
    if (!enabled) return snapshot;
    const save = async (kind: 'screenshot' | 'dom', data: Buffer, maximum: number) => {
      if (data.length > maximum || this.bytes + data.length > this.quota) return;
      this.bytes += data.length; // Reserve even if I/O times out; late writes cannot exceed quota.
      snapshot[kind] = await bounded(this.store.put(kind, data), 250);
    };
    await Promise.all([
      (async () => { try { await save('screenshot', await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false, timeout: 500, animations: 'disabled', caret: 'hide', mask: [page.locator(MASK_SELECTOR)], maskColor: '#333333' }), 8 * 1024 * 1024); } catch { /* Input must remain operational. */ } })(),
      (async () => { try { await save('dom', Buffer.from(await sanitizedDOM(page), 'utf8'), 5 * 1024 * 1024); } catch { /* Partial evidence is visible on the Action. */ } })(),
    ]);
    return snapshot;
  }
}
