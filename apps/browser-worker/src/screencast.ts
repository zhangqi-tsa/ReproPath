import type { BrowserContext, CDPSession, Page } from 'playwright';
import { MAX_FRAME_DATA_LENGTH, type BrowserFrame } from '@repropath/protocol';

interface ScreencastPacket {
  sessionId: number; data: string; metadata: { deviceWidth: number; deviceHeight: number };
}
async function bounded(operation: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([operation.catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 750); })]); }
  finally { clearTimeout(timer); }
}
/** Owns one CDP session/listener. CDP ACKs never wait for transport/UI. */
export class Screencast {
  private cdp?: CDPSession;
  private stopped = false;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  constructor(private context: BrowserContext, private page: Page,
    private identity: { sessionId: string; pageId: string },
    private nextSequence: () => number, private publish: (frame: BrowserFrame) => void,
    private unavailable: (error: string) => void) {}
  private onFrame = (packet: ScreencastPacket): void => {
    // ACK even when dropping oversized frames, stopping, or no consumer can accept data.
    void this.cdp?.send('Page.screencastFrameAck', { sessionId: packet.sessionId }).catch(error => {
      if (!this.stopped) this.unavailable(String(error));
    });
    if (this.stopped || !packet.data || packet.data.length > MAX_FRAME_DATA_LENGTH) return;
    this.publish({ type: 'browser-frame', ...this.identity, frameSequence: this.nextSequence(),
      width: packet.metadata.deviceWidth, height: packet.metadata.deviceHeight, mimeType: 'image/jpeg', data: packet.data });
  };
  start(): Promise<void> { this.opening ??= this.open(); return this.opening; }
  private async open(): Promise<void> {
    const cdp = await this.context.newCDPSession(this.page); this.cdp = cdp;
    if (this.stopped) { await cdp.detach().catch(() => {}); this.cdp = undefined; return; }
    cdp.on('Page.screencastFrame', this.onFrame);
    const viewport = this.page.viewportSize();
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 65,
      maxWidth: viewport?.width ?? 1440, maxHeight: viewport?.height ?? 900, everyNthFrame: 1 });
  }
  stop(): Promise<void> {
    this.stopped = true;
    this.closing ??= (async () => {
      if (this.opening) await bounded(this.opening);
      const cdp = this.cdp; if (!cdp) return;
      // A crashed renderer may never answer Page commands. Cleanup must still proceed.
      await bounded(cdp.send('Page.stopScreencast'));
      cdp.off('Page.screencastFrame', this.onFrame);
      await bounded(cdp.detach()); this.cdp = undefined;
    })();
    return this.closing;
  }
}
