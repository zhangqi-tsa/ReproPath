import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Frame, type Page, type Request, type Response, type ConsoleMessage, type WebError } from 'playwright';
import { DEFAULT_VIEWPORT, type BrowserInput, type EventData, type PageEventData, type Session, type WorkerMessage } from '@repropath/protocol';
import { Screencast } from './screencast.js';
import { PageInput } from './input.js';
import { LocalArtifactStore, type ArtifactStore } from '@repropath/artifacts';
import { EvidenceCapture } from './evidence.js';
import { ActionRecorder } from './action-recorder.js';
import { AgentPage } from './agent-page.js';
import type { AgentOperation } from '@repropath/agent-protocol';

interface RuntimePage { id: string; dispose: () => void }
interface ActiveSession {
  state: Session; sequence: number; frameSequence: number; context?: BrowserContext; page?: Page;
  pages: Map<Page, RuntimePage>; terminal: boolean; cleanup?: Promise<void>;
  disposeContext?: () => void; cast?: Screencast; retry?: ReturnType<typeof setTimeout>;
  input?: PageInput;
  recorder?: ActionRecorder;
  agent?: AgentPage;
}
export class BrowserRuntime {
  private browser?: Browser;
  private launching?: Promise<Browser>;
  private sessions = new Map<string, ActiveSession>();
  private pageIds = new WeakMap<Page, string>();
  private frameIds = new WeakMap<Frame, string>();
  constructor(private publish: (message: WorkerMessage) => void, private navigationTimeout = 15_000,
    private launch: () => Promise<Browser> = () => chromium.launch({ headless: true }),
    private initializeContext?: (context: BrowserContext, requestedUrl: string) => Promise<void>,
    private artifactStore: ArtifactStore = new LocalArtifactStore()) {}
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
  private emit(session: ActiveSession, data: EventData, page?: Page): void {
    if (session.terminal) return;
    const base = { id: randomUUID(), sessionId: session.state.id, sequence: ++session.sequence, timestamp: new Date().toISOString() };
    if (data.type === 'lifecycle') this.publish({ type: 'event', event: { ...base, ...data } });
    else {
      if (!page) throw new Error('Page events require a Page identity');
      const event = { ...base, pageId: this.pageId(page), ...data };
      session.recorder?.observe(event); this.publish({ type: 'event', event });
    }
  }
  private pageId(page: Page): string {
    let id = this.pageIds.get(page);
    if (!id) { id = `P-${randomUUID()}`; this.pageIds.set(page, id); }
    return id;
  }
  private frameId(frame: Frame): string {
    let id = this.frameIds.get(frame);
    if (!id) { id = `F-${randomUUID()}`; this.frameIds.set(frame, id); }
    return id;
  }
  private state(session: ActiveSession): void {
    this.publish({ type: 'state', session: { ...session.state, screencast: { ...session.state.screencast } } });
  }
  private watchPage(session: ActiveSession, page: Page): void {
    if (session.pages.has(page) || session.terminal) return;
    const id = this.pageId(page);
    if (!session.page) { session.page = page; session.state.activePageId = id; this.state(session); }
    const emit = (data: PageEventData) => this.emit(session, data, page);
    const navigation = (frame: Frame) => {
      emit({ type: 'navigation', payload: { url: frame.url(), frameId: this.frameId(frame), isMainFrame: frame === page.mainFrame() } });
      if (page === session.page && frame === page.mainFrame()) {
        session.agent?.invalidate();
        session.state.currentUrl = page.url(); this.state(session); void this.refresh(session);
      }
    };
    const refresh = () => { if (page === session.page) void this.refresh(session); };
    const crashed = () => {
      if (page === session.page) void this.finish(session, 'failed', 'Page crashed');
      else { emit({ type: 'pageerror', payload: { message: 'Popup page crashed' } }); void page.close().catch(() => {}); }
    };
    const closed = () => {
      if (page === session.page) void this.finish(session, 'closed', 'Page closed');
      else { session.pages.get(page)?.dispose(); session.pages.delete(page); }
    };
    page.on('framenavigated', navigation); page.on('domcontentloaded', refresh); page.on('load', refresh);
    page.on('crash', crashed); page.on('close', closed);
    session.pages.set(page, { id, dispose: () => {
      page.off('framenavigated', navigation); page.off('domcontentloaded', refresh); page.off('load', refresh);
      page.off('crash', crashed); page.off('close', closed);
    } });
  }
  private watchContext(session: ActiveSession, context: BrowserContext): void {
    const requests = new WeakMap<Request, string>();
    const deferred: { request: Request; data: PageEventData }[] = [];
    const requestId = (request: Request): string => {
      let id = requests.get(request);
      if (!id) { id = randomUUID(); requests.set(request, id); } return id;
    };
    const requestPage = (request: Request): Page | undefined => {
      // Service-worker-owned requests have no Page and are not Page events.
      try { const page = request.frame().page(); this.watchPage(session, page); return page; } catch { return undefined; }
    };
    const dispatch = (request: Request, data: PageEventData) => {
      const page = requestPage(request);
      if (page) this.emit(session, data, page);
      else if (!request.serviceWorker()) {
        // Popup's first request/response can precede Playwright's Page publication.
        // Keep the real Request object; resolve ownership when its Frame gets a Page.
        if (deferred.length >= 1024) { void this.finish(session, 'failed', 'Too many unresolved Page requests'); return; }
        deferred.push({ request, data });
      }
    };
    const onPage = (page: Page) => {
      this.watchPage(session, page);
      for (let i = 0; i < deferred.length;) {
        const item = deferred[i]!; const owner = requestPage(item.request);
        if (!owner) { i++; continue; }
        deferred.splice(i, 1); this.emit(session, item.data, owner);
      }
      // A popup may already have committed its initial document before 'page'.
      // Observe that real Frame, then use framenavigated for subsequent changes.
      if (page.url() && page.url() !== 'about:blank') this.emit(session, { type: 'navigation',
        payload: { url: page.url(), frameId: this.frameId(page.mainFrame()), isMainFrame: true } }, page);
    };
    const onRequest = (request: Request) => {
      dispatch(request, { type: 'request', payload: { requestId: requestId(request), url: request.url(), method: request.method(), resourceType: request.resourceType() } });
    };
    const onResponse = (response: Response) => {
      dispatch(response.request(), { type: 'response', payload: { requestId: requestId(response.request()), url: response.url(), status: response.status(), statusText: response.statusText() } });
    };
    const onFailed = (request: Request) => {
      session.recorder?.requestFinished(requestId(request));
      dispatch(request, { type: 'requestfailed', payload: { requestId: requestId(request), url: request.url(), error: request.failure()?.errorText ?? 'Request failed' } });
    };
    const onConsole = (message: ConsoleMessage) => {
      const page = message.page(); if (!page) return; this.watchPage(session, page);
      this.emit(session, { type: 'console', payload: { level: message.type(), text: message.text(), ...message.location() } }, page);
    };
    const onError = (error: WebError) => {
      const page = error.page(); if (!page) return; this.watchPage(session, page);
      this.emit(session, { type: 'pageerror', payload: { message: error.error().message, stack: error.error().stack } }, page);
    };
    const onFinished = (request: Request) => session.recorder?.requestFinished(requestId(request));
    context.on('requestfinished', onFinished);
    context.on('page', onPage); context.on('request', onRequest); context.on('response', onResponse);
    context.on('requestfailed', onFailed); context.on('console', onConsole); context.on('weberror', onError);
    session.disposeContext = () => {
      deferred.length = 0;
      context.off('requestfinished', onFinished);
      context.off('page', onPage); context.off('request', onRequest); context.off('response', onResponse);
      context.off('requestfailed', onFailed); context.off('console', onConsole); context.off('weberror', onError);
    };
  }
  async start(state: Session): Promise<void> {
    if (this.sessions.has(state.id)) return;
    const session: ActiveSession = { state: { ...state, viewport: { ...DEFAULT_VIEWPORT } }, sequence: 0, frameSequence: 0, pages: new Map(), terminal: false };
    session.recorder = new ActionRecorder(state.id, () => session.page, () => session.sequence, new EvidenceCapture(this.artifactStore), action => this.publish({ type: 'action-update', action }));
    session.agent = new AgentPage(()=>session.page,()=>session.state.activePageId,session.recorder,process.env.NODE_ENV==='test'?Number(process.env.REPROPATH_TEST_AGENT_DELAY_MS??0):0);
    session.input = new PageInput(() => session.page, () => ({ running: !session.terminal && session.state.status === 'running',
      pageId: session.state.activePageId, ...session.state.viewport }), summary => {
      if (session.page) this.emit(session, { type: 'human-input', payload: summary }, session.page);
    }, session.recorder);
    this.sessions.set(state.id, session); this.emit(session, { type: 'lifecycle', payload: { status: 'starting' } });
    try {
      const browser = await this.getBrowser(); if (session.terminal) return;
      const context = await browser.newContext({ viewport: session.state.viewport, deviceScaleFactor: 1 });
      session.context = context;
      if (session.terminal) { await context.close(); return; }
      await this.initializeContext?.(context, state.requestedUrl);
      if (session.terminal) { await context.close(); return; }
      this.watchContext(session, context);
      await context.exposeBinding('__repropathTitleChanged', source => {
        if (source.page === session.page) return this.refresh(session);
      });
      await context.addInitScript(`(() => {
        document.addEventListener('DOMContentLoaded', () => {
          const notify = () => { void window.__repropathTitleChanged?.().catch(() => {}); };
          new MutationObserver(notify).observe(document.head ?? document.documentElement, { childList: true, subtree: true, characterData: true });
        });
      })()`);
      const page = await context.newPage(); this.watchPage(session, page);
      await session.agent!.guardNavigations(page,state.requestedUrl);
      if (session.terminal) { await context.close(); return; }
      await page.goto(state.requestedUrl, { waitUntil: 'domcontentloaded', timeout: this.navigationTimeout });
      if (session.terminal) return;
      session.state.status = 'running'; await this.refresh(session); this.state(session);
      this.emit(session, { type: 'lifecycle', payload: { status: 'running' } }); await this.startCast(session);
    } catch (error) { await this.finish(session, 'failed', error instanceof Error ? error.message : String(error)); }
  }
  private async startCast(session: ActiveSession): Promise<void> {
    if (session.terminal || session.cast || !session.page || !session.context) return;
    session.state.screencast = { status: 'starting' }; this.state(session);
    const cast = new Screencast(session.context, session.page, { sessionId: session.state.id, pageId: this.pageId(session.page) },
      () => ++session.frameSequence, frame => {
        if (session.terminal || session.cast !== cast) return;
        if (session.state.screencast.status !== 'live') { session.state.screencast = { status: 'live' }; this.state(session); }
        this.publish(frame);
      }, error => { void this.castUnavailable(session, cast, error); });
    session.cast = cast;
    try { await cast.start(); } catch (error) { await this.castUnavailable(session, cast, String(error)); }
  }
  private async castUnavailable(session: ActiveSession, cast: Screencast, error: string): Promise<void> {
    if (session.terminal || session.cast !== cast || session.state.screencast.status === 'unavailable') return;
    session.state.screencast = { status: 'unavailable', error };
    console.error(`[${session.state.id}] Screencast: ${error.split('\n')[0]}`); this.state(session);
    await cast.stop(); if (session.terminal) return;
    session.cast = undefined;
    session.retry = setTimeout(() => { session.retry = undefined; void this.startCast(session); }, 2000);
  }
  private async refresh(session: ActiveSession): Promise<void> {
    const page = session.page; if (!page || session.terminal) return;
    try {
      const title = await page.title(); if (session.terminal) return;
      session.state.currentUrl = page.url(); session.state.pageTitle = title; this.state(session);
    } catch { /* Navigation replaces execution contexts; the next load refreshes state. */ }
  }
  private async finish(session: ActiveSession, status: 'failed' | 'closed', message: string): Promise<void> {
    if (session.terminal) return session.cleanup;
    session.state.status = status; session.state.screencast = { status: 'stopped' };
    if (status === 'failed') { session.state.error = message; console.error(`[${session.state.id}] ${message}`); }
    this.emit(session, { type: 'lifecycle', payload: { status, message } });
    session.terminal = true; clearTimeout(session.retry); this.state(session);
    session.agent?.setEpoch(null);
    // Fence pending inputs now. Context closure also releases native pressed state.
    void session.input?.reset();
    session.cleanup = (async () => {
      await session.cast?.stop(); session.cast = undefined; session.disposeContext?.();
      for (const page of session.pages.values()) page.dispose(); session.pages.clear();
      try { await session.context?.close(); }
      catch (error) { if (this.browser?.isConnected()) console.error('Context cleanup:', String(error).split('\n')[0]); }
      session.context = undefined; session.page = undefined; this.sessions.delete(session.state.id);
    })();
    return session.cleanup;
  }
  async close(id: string): Promise<void> { const session = this.sessions.get(id); if (session) await this.finish(session, 'closed', 'Session closed'); }
  async input(message: BrowserInput): Promise<void> {
    const input = this.sessions.get(message.sessionId)?.input;
    this.publish(input ? await input.apply(message) : { type: 'input-result', sessionId: message.sessionId,
      leaseId: message.leaseId, inputSequence: message.inputSequence, ok: false, code: 'SESSION_NOT_RUNNING', message: 'Session 未运行' });
  }
  resetInput(sessionId: string): Promise<void> { return this.sessions.get(sessionId)?.input?.reset() ?? Promise.resolve(); }
  agentEpoch(sessionId:string,epoch:string|null):void{this.sessions.get(sessionId)?.agent?.setEpoch(epoch);}
  async agentOperation(command:AgentOperation):Promise<void>{const session=this.sessions.get(command.sessionId);const result=session?.state.status==='running'&&session.agent?await session.agent.execute(command):{ok:false as const,code:'SESSION_NOT_RUNNING' as const};this.publish({type:'agent-operation-result',id:command.id,sessionId:command.sessionId,result});}
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(id => this.close(id)));
    const browser = this.browser ?? await this.launching?.catch(() => undefined); await browser?.close();
  }
}
