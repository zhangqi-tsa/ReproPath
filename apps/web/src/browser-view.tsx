import { useEffect, useRef, useState } from 'react';
import type { BrowserFrame, Session } from '@repropath/protocol';
import type { InputClient, ControlUiState } from './input-client.js';
import { useBrowserInput } from './use-browser-input.js';

export function BrowserView({ session, frame, connected, acknowledge, control, controlState }: {
  session: Session; frame?: BrowserFrame; connected: boolean; acknowledge: (frame: BrowserFrame) => void;
  control: InputClient; controlState: ControlUiState;
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const [drawn, setDrawn] = useState(0);
  const [decodeError, setDecodeError] = useState(false);
  const [fps, setFps] = useState(0);
  const count = useRef(0);
  useEffect(() => {
    const timer = setInterval(() => { setFps(count.current); count.current = 0; }, 1000);
    return () => clearInterval(timer);
  }, []);
  const running = session.status === 'running';
  useEffect(() => {
    if (!frame || !running || !connected) { setDrawn(0); return; }
    let done = false; let paint = 0;
    const image = new Image();
    const finish = () => { if (!done) { done = true; acknowledge(frame); } };
    image.onload = () => {
      paint = requestAnimationFrame(() => {
        const target = canvas.current; const context = target?.getContext('2d');
        if (target && context) {
          target.width = frame.width; target.height = frame.height;
          context.drawImage(image, 0, 0, frame.width, frame.height);
          setDrawn(frame.frameSequence); setDecodeError(false); count.current++;
        }
        finish();
      });
    };
    image.onerror = () => { setDecodeError(true); finish(); };
    image.src = `data:${frame.mimeType};base64,${frame.data}`;
    return () => { cancelAnimationFrame(paint); image.onload = null; image.onerror = null; finish(); };
  }, [frame, running, connected, acknowledge]);
  let message = '';
  if (session.status === 'closed') message = '浏览器 Session 已关闭';
  else if (session.status === 'failed') message = session.error?.includes('Page crashed') ? '浏览器页面异常终止' : '浏览器 Session 异常终止';
  else if (!connected || session.screencast.status === 'unavailable' || decodeError) message = '浏览器画面暂时不可用';
  else if (!drawn) message = '等待浏览器画面…';
  const live = !message && running;
  const controlled = controlState.mode === 'HUMAN CONTROL' && connected && running;
  useBrowserInput(canvas, textarea, controlled && live, session, drawn, control, setFocused);
  return <div className={`browser-panel ${controlled ? 'human-controlled' : ''} ${focused && controlled ? 'remote-focused' : ''}`}>
    <div className="browser-toolbar"><span className={live ? 'live-indicator' : 'view-indicator'} data-testid="view-status">{live ? '● LIVE' : message}</span>
      <span className="control-mode" data-testid="control-mode">{connected ? controlState.mode : controlState.mode === 'CONTROL LOST' ? 'CONTROL LOST' : 'VIEW ONLY'}</span>
      {controlled ? <button onClick={() => control.release()}>结束接管</button> : <button disabled={!live || !connected || controlState.mode === 'REQUESTING CONTROL'} onClick={() => control.acquire(session.id)}>{controlState.mode === 'REQUESTING CONTROL' ? '请求接管中…' : controlState.mode === 'AGENT CONTROL' ? '人工接管' : '接管浏览器'}</button>}
    </div>
    <div className="browser-stage" style={{ aspectRatio: `${session.viewport.width} / ${session.viewport.height}` }}>
      <canvas ref={canvas} aria-label={controlled ? '实时浏览器画面（可控制）' : '实时浏览器画面（只读）'} data-testid="browser-canvas" data-frame-sequence={drawn} hidden={!live} />
      <textarea ref={textarea} className="remote-text-input" aria-label="远程键盘输入" autoComplete="off" autoCapitalize="off" spellCheck={false} tabIndex={-1} readOnly={!controlled} />
      {message && <div className="view-placeholder" role="status"><span className="view-icon">▣</span><p>{message}</p>{session.screencast.error && <small>正在尝试恢复画面流，Timeline 仍可使用。</small>}</div>}
    </div>
    <div className="browser-footer"><span>{session.viewport.width} × {session.viewport.height}</span><span data-testid="fps">{live ? fps : 0} FPS · 显示帧率</span><span>{controlled ? focused ? '键盘正在输入远端 · 点击其他 UI 离开' : '点击画面获得远程键盘焦点' : 'VIEW ONLY · 接管后可操作'}</span></div>
    {controlState.error && <p className="control-error" role="alert">{controlState.error}</p>}
  </div>;
}
