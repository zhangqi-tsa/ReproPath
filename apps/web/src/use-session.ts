import { useCallback, useEffect, useRef, useState } from 'react';
import { ServerMessageSchema, SessionSchema, ActionRecordSchema, type ActionRecord, type BrowserFrame, type Session, type SessionEvent } from '@repropath/protocol';
import { InputClient, type ControlUiState } from './input-client.js';

export function useSession(id: string | undefined) {
  const [session, setSession] = useState<Session>();
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [actions, setActions] = useState<ActionRecord[]>([]);
  const [frame, setFrame] = useState<BrowserFrame>();
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('未订阅');
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const [controlState, setControlState] = useState<ControlUiState>({ mode: 'VIEW ONLY', error: '' });
  const controlRef = useRef<InputClient | undefined>(undefined);
  controlRef.current ??= new InputClient(() => socketRef.current, setControlState);
  const control = controlRef.current;
  const acknowledge = useCallback((value: BrowserFrame) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'frame-ack',
      sessionId: value.sessionId, pageId: value.pageId, frameSequence: value.frameSequence }));
  }, []);
  useEffect(() => {
    setSession(undefined); setEvents([]); setActions([]); setFrame(undefined); setError(''); setConnection(id ? '恢复 Session…' : '未订阅');
    control.lost();
    if (!id) return;
    let disposed = false; let retry: ReturnType<typeof setTimeout>;
    let current: Session | undefined; let pendingFrame: BrowserFrame | undefined;
    const abort = new AbortController();
    function acceptState(value: Session): void {
      current = value; setSession(value);
      if (['closed', 'failed'].includes(value.status) || value.screencast.status === 'unavailable') {
        if (['closed', 'failed'].includes(value.status)) control.lost();
        if (pendingFrame) acknowledge(pendingFrame);
        pendingFrame = undefined; setFrame(undefined);
      }
    }
    function connect(): void {
      if (disposed) return;
      setConnection('连接中');
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events`);
      socketRef.current = socket;
      socket.onopen = () => {
        setActions([]);
        socket.send(JSON.stringify({ type: 'subscribe', sessionId: id }));
        void fetch(`/sessions/${encodeURIComponent(id!)}/actions`, { signal: abort.signal }).then(async response => {
          if (!response.ok) throw new Error();
          const restored = ActionRecordSchema.array().parse(await response.json());
          if (!disposed) setActions(current => [...new Map([...restored, ...current].map(action => [action.id, action])).values()].slice(-500));
        }).catch(() => { if (!disposed) setError('Actions 恢复失败，请重连后重试'); });
      };
      socket.onmessage = message => {
        if (disposed) return;
        try {
          const data = ServerMessageSchema.parse(JSON.parse(String(message.data)));
          if (data.type === 'action-update') { setActions(previous => [...new Map([...previous, data.action].map(action => [action.id, action])).values()].slice(-500)); return; }
          if (data.type === 'control-state') { control.accept(data); return; }
          if (data.type === 'control-error') { control.denied(data.message); return; }
          if (data.type === 'input-result') { control.result(data); return; }
          if (data.type === 'snapshot') { acceptState(data.session); setEvents(data.events); setConnection('实时连接'); }
          else if (data.type === 'state') acceptState(data.session);
          else if (data.type === 'event') setEvents(previous => previous.some(event => event.id === data.event.id) ? previous : [...previous, data.event].slice(-10_000));
          else if (data.type === 'browser-frame') {
            if (data.sessionId !== id || data.pageId !== current?.activePageId || current.status !== 'running') { acknowledge(data); return; }
            pendingFrame = data; setFrame(data);
          } else { setError(data.message); setConnection('Session 不可用'); }
        } catch { setError('无法解析服务端消息'); }
      };
      socket.onclose = () => {
        control.lost();
        if (!disposed) { setConnection('连接中断，正在重连'); setFrame(undefined); retry = setTimeout(connect, 1000); }
      };
      socket.onerror = () => socket.close();
    }
    void (async () => {
      try {
        const response = await fetch(`/sessions/${encodeURIComponent(id)}`, { signal: abort.signal });
        if (!response.ok) throw new Error(response.status === 404 ? 'Session 不存在或已过期。Control 重启后请创建新 Session。' : '无法恢复 Session，请稍后刷新重试。');
        const value = SessionSchema.parse(await response.json());
        if (!disposed) { acceptState(value); connect(); }
      } catch (error) { if (!disposed) { setError(String(error)); setConnection('恢复失败'); } }
    })();
    return () => { disposed = true; abort.abort(); clearTimeout(retry); control.dispose(); socketRef.current?.close(); socketRef.current = undefined; };
  }, [id, acknowledge, control]);
  return { session, events, actions, frame, error, connection, acknowledge, control, controlState };
}
