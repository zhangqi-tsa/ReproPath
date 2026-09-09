import { z } from 'zod';

export const MouseButtonSchema = z.enum(['left', 'middle', 'right']);
export const ModifierSchema = z.enum(['Shift', 'Control', 'Alt', 'Meta']);
export const SpecialKeySchema = z.enum(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'Shift', 'Control', 'Alt', 'Meta']);
export const KeySchema = z.union([SpecialKeySchema, z.string().regex(/^(Key[A-Z]|Digit[0-9])$/)]);
const position = { x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() };
const pointer = { ...position, button: MouseButtonSchema, buttons: z.number().int().min(0).max(7) };
export const InputActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pointer-move'), ...pointer }),
  z.object({ type: z.literal('pointer-down'), ...pointer }),
  z.object({ type: z.literal('pointer-up'), ...pointer }),
  z.object({ type: z.literal('wheel'), ...position, deltaX: z.number().finite().min(-10000).max(10000), deltaY: z.number().finite().min(-10000).max(10000) }),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(4096) }),
  z.object({ type: z.literal('key'), key: KeySchema, action: z.enum(['down', 'up', 'press']), modifiers: z.array(ModifierSchema).max(4) }),
]);
export type InputAction = z.infer<typeof InputActionSchema>;
export const BrowserInputSchema = z.object({
  type: z.literal('browser-input'), sessionId: z.string(), pageId: z.string(), leaseId: z.string().uuid(),
  inputSequence: z.number().int().positive().safe(), sourceFrameSequence: z.number().int().positive().safe().optional(), input: InputActionSchema,
});
export type BrowserInput = z.infer<typeof BrowserInputSchema>;
export const InputErrorCodeSchema = z.enum(['INPUT_REJECTED', 'STALE_PAGE', 'CONTROL_NOT_OWNED', 'SESSION_NOT_RUNNING', 'INVALID_INPUT', 'INPUT_OUT_OF_ORDER', 'INPUT_BACKPRESSURE']);
export type InputErrorCode = z.infer<typeof InputErrorCodeSchema>;
export const InputResultSchema = z.object({
  type: z.literal('input-result'), sessionId: z.string(), leaseId: z.string(), inputSequence: z.number().int(),
  ok: z.boolean(), code: InputErrorCodeSchema.optional(), message: z.string().optional(),
});
export type InputResult = z.infer<typeof InputResultSchema>;
export const ControlAcquireSchema = z.object({ type: z.literal('control-acquire'), sessionId: z.string() });
export const ControlReleaseSchema = z.object({ type: z.literal('control-release'), sessionId: z.string(), leaseId: z.string().uuid() });
export const ControlStateSchema = z.object({
  type: z.literal('control-state'), sessionId: z.string(), status: z.enum(['available', 'controlled']),
  heldBySelf: z.boolean(), leaseId: z.string().uuid().optional(), reason: z.string().optional(),
  owner: z.enum(['human','agent']).optional(),
});
export type ControlState = z.infer<typeof ControlStateSchema>;
export const ControlErrorSchema = z.object({ type: z.literal('control-error'), sessionId: z.string(), code: z.enum(['CONTROL_NOT_OWNED', 'CONTROL_BUSY', 'SESSION_NOT_RUNNING']), message: z.string() });
export const InputResetSchema = z.object({ type: z.literal('input-reset'), sessionId: z.string() });

const auditBase = { inputSequence: z.number().int().positive(), sourceFrameSequence: z.number().int().positive().optional() };
export const HumanInputPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ ...auditBase, kind: z.literal('pointer-down'), ...pointer }),
  z.object({ ...auditBase, kind: z.literal('pointer-up'), ...pointer }),
  z.object({ ...auditBase, kind: z.literal('wheel'), ...position, deltaX: z.number(), deltaY: z.number() }),
  z.object({ ...auditBase, kind: z.literal('text'), characterCount: z.number().int().nonnegative() }),
  z.object({ ...auditBase, kind: z.literal('key'), key: KeySchema, action: z.enum(['down', 'up', 'press']), modifiers: z.array(ModifierSchema) }),
]);
export type HumanInputPayload = z.infer<typeof HumanInputPayloadSchema>;
export function inputSummary(message: BrowserInput): HumanInputPayload | undefined {
  const { input, inputSequence, sourceFrameSequence } = message;
  const base = { inputSequence, sourceFrameSequence };
  if (input.type === 'pointer-move') return undefined;
  if (input.type === 'text') return { ...base, kind: 'text', characterCount: input.text.length }; // UTF-16 code units.
  const { type, ...fields } = input;
  return HumanInputPayloadSchema.parse({ ...base, kind: type, ...fields });
}
