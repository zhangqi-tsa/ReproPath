import { z } from 'zod';

export const SignalKindSchema = z.enum(['HTTP_5XX', 'REQUEST_FAILED', 'DOCUMENT_REQUEST_FAILED', 'PAGE_ERROR', 'CONSOLE_ERROR', 'DUPLICATE_REQUEST']);
export const SeveritySchema = z.enum(['high', 'medium', 'low']);
export const FindingStatusSchema = z.enum(['candidate', 'confirmed', 'not_issue', 'known_issue']);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const network = { requestId: z.string(), method: z.string(), safeEndpoint: z.string() };
export const SignalFactsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('HTTP_5XX'), ...network, status: z.number().int().min(500).max(599) }),
  z.object({ kind: z.literal('REQUEST_FAILED'), ...network, resourceType: z.string(), failureHash: hash }),
  z.object({ kind: z.literal('DOCUMENT_REQUEST_FAILED'), ...network, resourceType: z.string(), failureHash: hash }),
  z.object({ kind: z.literal('PAGE_ERROR'), safePage: z.string(), messageHash: hash }),
  z.object({ kind: z.literal('CONSOLE_ERROR'), safePage: z.string(), messageHash: hash }),
  z.object({ kind: z.literal('DUPLICATE_REQUEST'), method: z.string(), safeEndpoint: z.string(), count: z.number().int().min(2), windowMs: z.number().nonnegative().max(1000) }),
]);
export const SignalSchema = z.object({
  id: z.string().uuid(), sessionId: z.string(), pageId: z.string().optional(), actionId: z.string().uuid().optional(),
  kind: SignalKindSchema, severity: SeveritySchema, detectedAt: z.string().datetime(), fingerprint: hash,
  sourceEventIds: z.array(z.string()).max(1000), requestIds: z.array(z.string()).max(1000), facts: SignalFactsSchema,
});
export type Signal = z.infer<typeof SignalSchema>;
export const FindingSchema = z.object({
  id: z.string().uuid(), sessionId: z.string(), fingerprint: hash, signalKind: SignalKindSchema,
  status: FindingStatusSchema, severity: SeveritySchema, title: z.string(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), firstDetectedAt: z.string().datetime(), lastDetectedAt: z.string().datetime(),
  occurrenceCount: z.number().int().positive(), signalIds: z.array(z.string().uuid()).max(100), actionIds: z.array(z.string().uuid()).max(100),
  referencesTruncated: z.boolean(), revision: z.number().int().positive(),
});
export type Finding = z.infer<typeof FindingSchema>;
export type FindingStatus = z.infer<typeof FindingStatusSchema>;
export const DetectionStatsSchema = z.object({ signalsRetained: z.number().int().nonnegative(), signalsDropped: z.number().int().nonnegative(), findingsRetained: z.number().int().nonnegative(), findingsDropped: z.number().int().nonnegative(), runtimeDropped: z.number().int().nonnegative() });
export type DetectionStats = z.infer<typeof DetectionStatsSchema>;
export const SignalListSchema = z.object({ signals: SignalSchema.array().max(2000), stats: DetectionStatsSchema });
export const FindingListSchema = z.object({ findings: FindingSchema.array().max(500), stats: DetectionStatsSchema });
export const FindingPatchSchema = z.object({ status: FindingStatusSchema }).strict();
export const SignalCreatedSchema = z.object({ type: z.literal('signal-created'), signal: SignalSchema });
export const FindingUpdateSchema = z.object({ type: z.literal('finding-update'), finding: FindingSchema });
export const DetectionStatsUpdateSchema = z.object({ type: z.literal('detection-stats'), sessionId: z.string(), stats: DetectionStatsSchema });
