import { useEffect, useRef, type RefObject } from 'react';
import { SpecialKeySchema, type InputAction, type Session } from '@repropath/protocol';
import type { InputClient } from './input-client.js';

export function useBrowserInput(canvas: RefObject<HTMLCanvasElement | null>, textarea: RefObject<HTMLTextAreaElement | null>,
  enabled: boolean, session: Session, frameSequence: number, control: InputClient, focused: (value: boolean) => void): void {
  const current = useRef({ enabled, session, frameSequence });
  current.current = { enabled, session, frameSequence };
  useEffect(() => {
    const target = canvas.current; const text = textarea.current; if (!target || !text) return;
    let composing = false; let lastCommit = ''; let compositionTimer: ReturnType<typeof setTimeout>;
    const keys = new Set<string>(); const buttons = new Set<'left' | 'right' | 'middle'>();
    const send = (input: InputAction) => {
      const state = current.current;
      if (state.enabled && state.session.activePageId) control.enqueue(state.session.id, state.session.activePageId, input, state.frameSequence || undefined);
    };
    const position = (event: { clientX: number; clientY: number }) => {
      const rect = target.getBoundingClientRect(); const viewport = current.current.session.viewport;
      return { x: Math.max(0, Math.min(viewport.width - 0.001, (event.clientX - rect.left) / Math.max(rect.width, 1) * viewport.width)),
        y: Math.max(0, Math.min(viewport.height - 0.001, (event.clientY - rect.top) / Math.max(rect.height, 1) * viewport.height)) };
    };
    const button = (value: number): 'left' | 'middle' | 'right' => value === 2 ? 'right' : value === 1 ? 'middle' : 'left';
    const pointer = (event: PointerEvent) => {
      if (!current.current.enabled || event.pointerType !== 'mouse') return;
      event.preventDefault();
      if (event.type === 'pointerdown') {
        text.focus({ preventScroll: true }); target.setPointerCapture(event.pointerId); buttons.add(button(event.button));
      }
      send({ type: event.type === 'pointerdown' ? 'pointer-down' : event.type === 'pointerup' ? 'pointer-up' : 'pointer-move',
        ...position(event), button: button(event.button), buttons: event.buttons & 7 });
      if (event.type === 'pointerup') {
        buttons.delete(button(event.button));
        if (!event.buttons && target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      }
    };
    const cancel = () => { if (buttons.size) { buttons.clear(); control.release(); } };
    const wheel = (event: WheelEvent) => {
      if (!current.current.enabled) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? current.current.session.viewport.height : 1;
      send({ type: 'wheel', ...position(event), deltaX: Math.max(-10000, Math.min(10000, event.deltaX * scale)), deltaY: Math.max(-10000, Math.min(10000, event.deltaY * scale)) });
    };
    const contextMenu = (event: MouseEvent) => event.preventDefault();
    const modifiers = (event: KeyboardEvent): ('Shift' | 'Control' | 'Alt' | 'Meta')[] => {
      const result: ('Shift' | 'Control' | 'Alt' | 'Meta')[] = [];
      if (event.shiftKey) result.push('Shift'); if (event.ctrlKey) result.push('Control');
      if (event.altKey) result.push('Alt'); if (event.metaKey) result.push('Meta'); return result;
    };
    const keyboard = (event: KeyboardEvent) => {
      if (!current.current.enabled) return;
      if (composing || event.isComposing || event.keyCode === 229) {
        const key = event.key === ' ' ? 'Space' : event.key;
        if (event.type === 'keyup' && keys.has(key)) { keys.delete(key); send({ type: 'key', key, action: 'up', modifiers: [] }); }
        return;
      }
      // Paste stays local long enough for clipboardData; only its text is committed remotely.
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyV') return;
      const special = SpecialKeySchema.safeParse(event.key === ' ' ? 'Space' : event.key);
      const key = special.success ? special.data : (event.ctrlKey || event.metaKey || event.altKey) && /^(Key[A-Z]|Digit[0-9])$/.test(event.code) ? event.code : undefined;
      if (!key) return;
      event.preventDefault();
      if (event.type === 'keyup' && !keys.has(key)) return;
      if (event.type === 'keydown') keys.add(key); else keys.delete(key);
      send({ type: 'key', key, action: event.type === 'keydown' ? 'down' : 'up', modifiers: modifiers(event) });
    };
    const commit = (value: string) => {
      // Keep WebSocket messages bounded; UTF-16 chunks avoid splitting a surrogate pair.
      for (let start = 0; start < value.length;) {
        let end = Math.min(start + 4096, value.length);
        if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
        send({ type: 'text', text: value.slice(start, end) }); start = end;
      }
      text.value = '';
    };
    const input = () => {
      if (composing) return;
      if (lastCommit && text.value === lastCommit) { text.value = ''; lastCommit = ''; return; }
      if (text.value) commit(text.value);
    };
    const compositionStart = () => { composing = true; };
    const compositionEnd = (event: CompositionEvent) => {
      composing = false; lastCommit = event.data; if (event.data) commit(event.data);
      clearTimeout(compositionTimer); compositionTimer = setTimeout(() => { lastCommit = ''; }, 0);
    };
    const paste = (event: ClipboardEvent) => {
      if (!current.current.enabled) return; event.preventDefault();
      const value = event.clipboardData?.getData('text/plain'); if (value) commit(value);
    };
    const blur = () => {
      focused(false); composing = false; text.value = '';
      for (const key of keys) send({ type: 'key', key, action: 'up', modifiers: [] });
      keys.clear();
    };
    const focus = () => focused(true);
    target.addEventListener('pointerdown', pointer); target.addEventListener('pointermove', pointer); target.addEventListener('pointerup', pointer);
    target.addEventListener('pointercancel', cancel); target.addEventListener('lostpointercapture', cancel);
    target.addEventListener('wheel', wheel, { passive: false }); target.addEventListener('contextmenu', contextMenu);
    text.addEventListener('keydown', keyboard); text.addEventListener('keyup', keyboard); text.addEventListener('input', input);
    text.addEventListener('compositionstart', compositionStart); text.addEventListener('compositionend', compositionEnd);
    text.addEventListener('paste', paste); text.addEventListener('blur', blur); text.addEventListener('focus', focus);
    window.addEventListener('blur', blur);
    return () => {
      blur(); clearTimeout(compositionTimer);
      target.removeEventListener('pointerdown', pointer); target.removeEventListener('pointermove', pointer); target.removeEventListener('pointerup', pointer);
      target.removeEventListener('pointercancel', cancel); target.removeEventListener('lostpointercapture', cancel);
      target.removeEventListener('wheel', wheel); target.removeEventListener('contextmenu', contextMenu);
      text.removeEventListener('keydown', keyboard); text.removeEventListener('keyup', keyboard); text.removeEventListener('input', input);
      text.removeEventListener('compositionstart', compositionStart); text.removeEventListener('compositionend', compositionEnd);
      text.removeEventListener('paste', paste); text.removeEventListener('blur', blur); text.removeEventListener('focus', focus);
      window.removeEventListener('blur', blur);
    };
  }, [canvas, textarea, control, focused]);
  useEffect(() => { if (!enabled) textarea.current?.blur(); }, [enabled, textarea]);
}
