import { z } from 'zod';
import { BrowserInputSchema, ControlAcquireSchema, ControlReleaseSchema, ControlStateSchema, ControlErrorSchema, InputResultSchema, InputResetSchema, HumanInputPayloadSchema } from './input.js';
export * from './input.js';

export const HttpUrl = z.string().max(8192).url().refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}, 'URL must use http:// or https:// and contain no credentials');
export const CreateSessionRequest = z.object({ url: HttpUrl });
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 } as const;
export const ViewportSchema = z.object({ width: z.number().int().positive(), height: z.number().int().positive() });
export const SessionSchema = z.object({
  id: z.string(), status: z.enum(['starting', 'running', 'failed', 'closed']),
  requestedUrl: HttpUrl, currentUrl: z.string(), pageTitle: z.string(),
  createdAt: z.string().datetime(), error: z.string().optional(),
  activePageId: z.string().nullable(), viewport: ViewportSchema,
  screencast: z.object({ status: z.enum(['idle', 'starting', 'live', 'unavailable', 'stopped']), error: z.string().optional() }),
});
export type Session = z.infer<typeof SessionSchema>;
const base = { id: z.string(), sessionId: z.string(), sequence: z.number().int().positive(), timestamp: z.string().datetime() };
const pageBase = { ...base, pageId: z.string().min(1) };
export const SessionEventSchema = z.discriminatedUnion('type', [
  z.object({ ...pageBase, type: z.literal('human-input'), payload: HumanInputPayloadSchema }),
  z.object({ ...pageBase, type: z.literal('navigation'), payload: z.object({ url: z.string(), frameId: z.string().min(1), isMainFrame: z.boolean() }) }),
  z.object({ ...pageBase, type: z.literal('request'), payload: z.object({ requestId: z.string(), url: z.string(), method: z.string(), resourceType: z.string() }) }),
  z.object({ ...pageBase, type: z.literal('response'), payload: z.object({ requestId: z.string(), url: z.string(), status: z.number(), statusText: z.string() }) }),
  z.object({ ...pageBase, type: z.literal('console'), payload: z.object({ level: z.string(), text: z.string(), url: z.string(), lineNumber: z.number().int(), columnNumber: z.number().int() }) }),
  z.object({ ...pageBase, type: z.literal('pageerror'), payload: z.object({ message: z.string(), stack: z.string().optional() }) }),
  z.object({ ...pageBase, type: z.literal('requestfailed'), payload: z.object({ requestId: z.string(), url: z.string(), error: z.string() }) }),
  z.object({ ...base, type: z.literal('lifecycle'), payload: z.object({ status: SessionSchema.shape.status, message: z.string().optional() }) }),
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type SessionEventType = SessionEvent['type'];
export type EventData = SessionEvent extends infer E ? E extends SessionEvent ? Pick<E, 'type' | 'payload'> : never : never;
export type PageEventData = Exclude<EventData, { type: 'lifecycle' }>;
// Frames have their own sequence and transport acknowledgement. They are NEVER SessionEvents.
export const MAX_FRAME_DATA_LENGTH = 2 * 1024 * 1024;
export const BrowserFrameSchema = z.object({
  type: z.literal('browser-frame'), sessionId: z.string(), pageId: z.string(),
  frameSequence: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(),
  mimeType: z.literal('image/jpeg'), data: z.string().min(1).max(MAX_FRAME_DATA_LENGTH),
});
export type BrowserFrame = z.infer<typeof BrowserFrameSchema>;
export const FrameAckSchema = z.object({
  type: z.literal('frame-ack'), sessionId: z.string(), pageId: z.string(), frameSequence: z.number().int().positive(),
});
export type FrameAck = z.infer<typeof FrameAckSchema>;
export const WorkerCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), session: SessionSchema }),
  z.object({ type: z.literal('close'), sessionId: z.string() }),
  FrameAckSchema,
  BrowserInputSchema, InputResetSchema,
]);
export type WorkerCommand = z.infer<typeof WorkerCommandSchema>;
export const WorkerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), session: SessionSchema }),
  z.object({ type: z.literal('event'), event: SessionEventSchema }),
  BrowserFrameSchema,
  InputResultSchema,
]);
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;
export const SubscriptionSchema = z.object({ type: z.literal('subscribe'), sessionId: z.string() });
export const ClientMessageSchema = z.discriminatedUnion('type', [SubscriptionSchema, FrameAckSchema, BrowserInputSchema, ControlAcquireSchema, ControlReleaseSchema]);
export const ServerMessageSchema = z.discriminatedUnion('type', [
  ...WorkerMessageSchema.options,
  z.object({ type: z.literal('snapshot'), session: SessionSchema, events: z.array(SessionEventSchema) }),
  z.object({ type: z.literal('error'), message: z.string() }),
  ControlStateSchema, ControlErrorSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export interface ApiError { error: string }
