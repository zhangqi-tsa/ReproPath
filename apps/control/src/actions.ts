import { MAX_ACTIONS, type ActionRecord, type ArtifactRef } from '@repropath/protocol';
export class ActionStore {
  private sessions = new Map<string, Map<string, ActionRecord>>();
  update(action: ActionRecord): void {
    let actions = this.sessions.get(action.sessionId);
    if (!actions) { actions = new Map(); this.sessions.set(action.sessionId, actions); }
    actions.set(action.id, action);
    while (actions.size > MAX_ACTIONS) actions.delete(actions.keys().next().value!);
  }
  list(id: string): ActionRecord[] { return [...(this.sessions.get(id)?.values() ?? [])]; }
  get(sessionId: string, id: string): ActionRecord | undefined { return this.sessions.get(sessionId)?.get(id); }
  forget(id: string): void { this.sessions.delete(id); }
  artifact(id: string): ArtifactRef | undefined {
    for (const actions of this.sessions.values()) for (const action of actions.values()) {
      const ref = [action.before?.screenshot, action.before?.dom, action.after?.screenshot, action.after?.dom].find(ref => ref?.id === id);
      if (ref) return ref;
    }
    return undefined;
  }
  interrupt(sessionId: string, sequence: number): ActionRecord[] {
    const changed: ActionRecord[] = [];
    for (const action of this.list(sessionId)) if (action.status === 'recording') {
      action.status = 'interrupted'; action.completedAt = new Date().toISOString(); action.durationMs = Date.now() - Date.parse(action.startedAt);
      action.eventSequenceEnd = Math.max(sequence, action.eventSequenceStart); action.evidenceStatus = action.before?.dom || action.before?.screenshot ? 'partial' : 'failed'; changed.push(action);
    }
    return changed;
  }
}
