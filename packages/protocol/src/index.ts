import { z } from 'zod';

export const HttpUrl = z.string().max(8192).url().refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}, 'URL must use http:// or https:// and contain no credentials');
export const CreateSessionRequest = z.object({ url: HttpUrl });
export const SessionSchema = z.object({
  id: z.string(), status: z.enum(['starting', 'running', 'failed', 'closed']),
  requestedUrl: HttpUrl, currentUrl: z.string(), pageTitle: z.string(),
  createdAt: z.string().datetime(), error: z.string().optional(),
});
export type Session = z.infer<typeof SessionSchema>;
const base = { id: z.string(), sessionId: z.string(), sequence: z.number().int().positive(), timestamp: z.string().datetime() };
export const SessionEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('navigation'), payload: z.object({ url: z.string(), isMainFrame: z.boolean() }) }),
  z.object({ ...base, type: z.literal('request'), payload: z.object({ requestId: z.string(), url: z.string(), method: z.string(), resourceType: z.string() }) }),
  z.object({ ...base, type: z.literal('response'), payload: z.object({ requestId: z.string(), url: z.string(), status: z.number(), statusText: z.string() }) }),
  z.object({ ...base, type: z.literal('console'), payload: z.object({ level: z.string(), text: z.string() }) }),
  z.object({ ...base, type: z.literal('pageerror'), payload: z.object({ message: z.string(), stack: z.string().optional() }) }),
  z.object({ ...base, type: z.literal('requestfailed'), payload: z.object({ requestId: z.string(), url: z.string(), error: z.string() }) }),
  z.object({ ...base, type: z.literal('lifecycle'), payload: z.object({ status: SessionSchema.shape.status, message: z.string().optional() }) }),
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type SessionEventType = SessionEvent['type'];
export type EventData = SessionEvent extends infer E ? E extends SessionEvent ? Pick<E, 'type' | 'payload'> : never : never;
export const WorkerCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), session: SessionSchema }),
  z.object({ type: z.literal('close'), sessionId: z.string() }),
]);
export type WorkerCommand = z.infer<typeof WorkerCommandSchema>;
export const WorkerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), session: SessionSchema }),
  z.object({ type: z.literal('event'), event: SessionEventSchema }),
]);
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;
export const SubscriptionSchema = z.object({ type: z.literal('subscribe'), sessionId: z.string() });
export const ServerMessageSchema = z.discriminatedUnion('type', [
  ...WorkerMessageSchema.options,
  z.object({ type: z.literal('snapshot'), session: SessionSchema, events: z.array(SessionEventSchema) }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export interface ApiError { error: string }
