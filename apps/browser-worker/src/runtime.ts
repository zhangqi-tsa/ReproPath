import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright';
import type { EventData, Session, WorkerMessage } from '@repropath/protocol';

interface ActiveSession {
  state: Session; sequence: number; context?: BrowserContext; page?: Page; terminal: boolean; cleanup?: Promise<void>;
}
export class BrowserRuntime {
  private browser?: Browser;
  private launching?: Promise<Browser>;
  private sessions = new Map<string, ActiveSession>();
  constructor(private publish: (message: WorkerMessage) => void, private navigationTimeout = 15_000,
    private launch: () => Promise<Browser> = () => chromium.launch({ headless: true })) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = this.launch().then(browser => {
        this.browser = browser;
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = undefined;
          for (const session of this.sessions.values()) void this.finish(session, 'failed', 'Browser disconnected');
        });
        return browser;
      }).finally(() => { this.launching = undefined; });
    }
    return this.launching;
  }
  private emit(session: ActiveSession, data: EventData): void {
    if (session.terminal) return;
    this.publish({ type: 'event', event: {
      ...data, id: randomUUID(), sessionId: session.state.id,
      sequence: ++session.sequence, timestamp: new Date().toISOString(),
    } });
  }
  private state(session: ActiveSession): void { this.publish({ type: 'state', session: { ...session.state } }); }

  async start(state: Session): Promise<void> {
    if (this.sessions.has(state.id)) return;
    const session: ActiveSession = { state: { ...state }, sequence: 0, terminal: false };
    this.sessions.set(state.id, session);
    this.emit(session, { type: 'lifecycle', payload: { status: 'starting' } });
    try {
      const browser = await this.getBrowser();
      if (session.terminal) return;
      const context = await browser.newContext();
      session.context = context;
      if (session.terminal) { await context.close(); return; }
      const page = await context.newPage();
      session.page = page;
      if (session.terminal) { await context.close(); return; }
      const requests = new WeakMap<Request, string>();
      const requestId = (request: Request): string => {
        let id = requests.get(request);
        if (!id) { id = randomUUID(); requests.set(request, id); }
        return id;
      };
      page.on('request', request => this.emit(session, { type: 'request', payload: {
        requestId: requestId(request), url: request.url(), method: request.method(), resourceType: request.resourceType(),
      } }));
      page.on('response', response => this.emit(session, { type: 'response', payload: {
        requestId: requestId(response.request()), url: response.url(), status: response.status(), statusText: response.statusText(),
      } }));
      page.on('requestfailed', request => this.emit(session, { type: 'requestfailed', payload: {
        requestId: requestId(request), url: request.url(), error: request.failure()?.errorText ?? 'Request failed',
      } }));
      page.on('console', message => this.emit(session, { type: 'console', payload: { level: message.type(), text: message.text() } }));
      page.on('pageerror', error => this.emit(session, { type: 'pageerror', payload: { message: error.message, stack: error.stack } }));
      page.on('framenavigated', frame => {
        this.emit(session, { type: 'navigation', payload: { url: frame.url(), isMainFrame: frame === page.mainFrame() } });
        if (frame === page.mainFrame() && !session.terminal) {
          session.state.currentUrl = page.url();
          this.state(session);
          void this.refresh(session);
        }
      });
      page.on('domcontentloaded', () => { void this.refresh(session); });
      page.on('load', () => { void this.refresh(session); });
      page.on('crash', () => { void this.finish(session, 'failed', 'Page crashed'); });
      page.on('close', () => { void this.finish(session, 'closed', 'Page closed'); });
      // Observe dynamic title changes without polling or exposing browser controls.
      await page.exposeBinding('__repropathTitleChanged', () => this.refresh(session));
      await page.addInitScript(`(() => {
        document.addEventListener('DOMContentLoaded', () => {
          const notify = () => {
            const binding = Reflect.get(window, '__repropathTitleChanged');
            void binding?.().catch(() => {});
          };
          new MutationObserver(notify).observe(document.head ?? document.documentElement, { childList: true, subtree: true, characterData: true });
        });
      })()`);
      await page.goto(state.requestedUrl, { waitUntil: 'domcontentloaded', timeout: this.navigationTimeout });
      if (session.terminal) return;
      session.state.status = 'running';
      await this.refresh(session);
      this.emit(session, { type: 'lifecycle', payload: { status: 'running' } });
    } catch (error) {
      await this.finish(session, 'failed', error instanceof Error ? error.message : String(error));
    }
  }
  private async refresh(session: ActiveSession): Promise<void> {
    const page = session.page;
    if (!page || session.terminal) return;
    try {
      const title = await page.title();
      if (session.terminal) return;
      session.state.currentUrl = page.url(); session.state.pageTitle = title;
      this.state(session);
    } catch { /* A navigation may replace the execution context; the next load refreshes it. */ }
  }
  private async finish(session: ActiveSession, status: 'failed' | 'closed', message: string): Promise<void> {
    if (session.terminal) return session.cleanup;
    session.state.status = status;
    if (status === 'failed') { session.state.error = message; console.error(`[${session.state.id}] ${message}`); }
    this.emit(session, { type: 'lifecycle', payload: { status, message } });
    session.terminal = true;
    this.state(session);
    session.cleanup = (async () => {
      try { await session.context?.close(); }
      catch (error) {
        // A disconnected browser has already destroyed its contexts.
        if (this.browser?.isConnected()) console.error('Context cleanup:', error instanceof Error ? error.message.split('\n')[0] : String(error));
      }
      session.context = undefined; session.page = undefined;
      this.sessions.delete(session.state.id);
    })();
    return session.cleanup;
  }
  async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) await this.finish(session, 'closed', 'Session closed');
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(id => this.close(id)));
    const browser = this.browser ?? await this.launching?.catch(() => undefined);
    await browser?.close();
  }
}
