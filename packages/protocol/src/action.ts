import { z } from 'zod';
export const ArtifactRefSchema = z.object({ id: z.string().uuid(), kind: z.enum(['screenshot', 'dom']), contentType: z.enum(['image/jpeg', 'text/plain; charset=utf-8']), byteLength: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export const EvidenceSnapshotSchema = z.object({ id: z.string().uuid(), sessionId: z.string(), actionId: z.string().uuid(), pageId: z.string(), phase: z.enum(['before', 'after']), capturedAt: z.string(), url: z.string(), title: z.string(), viewport: z.object({ width: z.number(), height: z.number() }), screenshot: ArtifactRefSchema.optional(), dom: ArtifactRefSchema.optional() });
export type EvidenceSnapshot = z.infer<typeof EvidenceSnapshotSchema>;
export const ActionTargetSchema = z.object({ tagName: z.string(), role: z.string().optional(), ariaLabel: z.string().optional(), name: z.string().optional(), type: z.string().optional(), text: z.string().max(120).optional(), testId: z.string().optional() });
export type ActionTarget = z.infer<typeof ActionTargetSchema>;
const point = { x: z.number(), y: z.number() }; const button = z.enum(['left', 'middle', 'right']);
export const ActionDetailSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), button, ...point }),
  z.object({ kind: z.literal('drag'), button, startX: z.number(), startY: z.number(), endX: z.number(), endY: z.number() }),
  z.object({ kind: z.literal('type'), characterCount: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('scroll'), totalDeltaX: z.number(), totalDeltaY: z.number(), eventCount: z.number().int() }),
  z.object({ kind: z.literal('key'), key: z.string(), modifiers: z.array(z.string()) }),
]);
export const ActionRecordSchema = z.object({ id: z.string().uuid(), sessionId: z.string(), pageId: z.string(), actor: z.enum(['human', 'agent', 'replay']), kind: z.enum(['click', 'drag', 'type', 'key', 'scroll']), status: z.enum(['recording', 'completed', 'interrupted']), startedAt: z.string(), completedAt: z.string().optional(), durationMs: z.number().optional(), sourceFrameSequence: z.number().optional(), target: ActionTargetSchema.optional(), detail: ActionDetailSchema, before: EvidenceSnapshotSchema.optional(), after: EvidenceSnapshotSchema.optional(), eventSequenceStart: z.number().int(), eventSequenceEnd: z.number().int().optional(), networkRequestIds: z.array(z.string()).max(1000), settle: z.object({ timedOut: z.boolean(), durationMs: z.number() }).optional(), evidenceStatus: z.enum(['pending', 'complete', 'partial', 'failed']) });
export type ActionRecord = z.infer<typeof ActionRecordSchema>;
export const ActionUpdateSchema = z.object({ type: z.literal('action-update'), action: ActionRecordSchema });
export const MAX_ACTIONS = 500;
