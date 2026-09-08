import { z } from 'zod';
export const GATEWAY_VERSION = 1;
const id = z.string().min(1).max(100);
export const AgentErrorSchema = z.enum(['AGENT_HOST_UNAVAILABLE','AGENT_MODEL_UNAVAILABLE','AGENT_ALREADY_RUNNING','CONTROL_BUSY','CONTROL_NOT_OWNED','SESSION_NOT_RUNNING','RUN_NOT_RESUMABLE','RUN_TIMEOUT','MODEL_PROTOCOL_ERROR','MODEL_ABORTED','TOOL_VALIDATION_ERROR','TOOL_EXECUTION_ERROR','UNKNOWN_TOOL','STALE_OBSERVATION','STALE_ELEMENT','POLICY_BLOCKED','BUDGET_EXHAUSTED','ONE_TOOL_PER_TURN']);
export type AgentError = z.infer<typeof AgentErrorSchema>;
export const AgentKeySchema = z.union([z.enum(['Enter','Tab','Backspace','Delete','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Space','Shift','Control','Alt','Meta']), z.string().regex(/^(Key[A-Z]|Digit[0-9])$/)]);
export const AgentUrlSchema = z.string().max(8192).url().refine(s=>{try{const u=new URL(s);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}});
const ref = { observationId:id, elementRef:id };
export const toolSchemas = {
  observe_page:z.object({}).strict(), click:z.object(ref).strict(),
  type_text:z.object({...ref,text:z.string().min(1).max(4096)}).strict(),
  press_key:z.object({key:AgentKeySchema,modifiers:z.array(z.enum(['Control','Meta','Shift','Alt'])).max(4).default([])}).strict(),
  scroll:z.object({deltaX:z.number().finite().min(-5000).max(5000),deltaY:z.number().finite().min(-5000).max(5000)}).strict(),
  navigate:z.object({url:AgentUrlSchema}).strict(),go_back:z.object({}).strict(),
  wait:z.object({ms:z.number().int().positive().max(5000)}).strict(),finish:z.object({summary:z.string().max(4000)}).strict(),
};
export const ToolNameSchema=z.enum(['observe_page','click','type_text','press_key','scroll','navigate','go_back','wait','finish']);
export type ToolName=z.infer<typeof ToolNameSchema>;
export const ToolCallSchema=z.discriminatedUnion('name',[
  z.object({name:z.literal('observe_page'),args:toolSchemas.observe_page}),z.object({name:z.literal('click'),args:toolSchemas.click}),
  z.object({name:z.literal('type_text'),args:toolSchemas.type_text}),z.object({name:z.literal('press_key'),args:toolSchemas.press_key}),
  z.object({name:z.literal('scroll'),args:toolSchemas.scroll}),z.object({name:z.literal('navigate'),args:toolSchemas.navigate}),
  z.object({name:z.literal('go_back'),args:toolSchemas.go_back}),z.object({name:z.literal('wait'),args:toolSchemas.wait}),z.object({name:z.literal('finish'),args:toolSchemas.finish}),
]);
export type ToolCall=z.infer<typeof ToolCallSchema>;
export const ElementSchema=z.object({ref:id,role:z.string().max(100),name:z.string().max(200),tagName:z.string().max(30),editable:z.boolean(),disabled:z.boolean(),checked:z.boolean().optional(),selected:z.boolean().optional(),expanded:z.boolean().optional(),text:z.string().max(300).optional()});
export const FindingSummarySchema=z.object({id,kind:z.string().max(100),severity:z.string().max(30),title:z.string().max(300),status:z.string().max(30),occurrences:z.number().int().nonnegative()});
export const ObservationSchema=z.object({id,sessionId:id,pageId:id,createdAt:z.string(),url:z.string().max(8192),title:z.string().max(300),elements:z.array(ElementSchema).max(200),headings:z.array(z.string().max(300)).max(50),textSnippets:z.array(z.string().max(300)).max(100),findings:z.array(FindingSummarySchema).max(10),truncated:z.boolean()}).refine(o=>JSON.stringify([o.title,o.elements.map(e=>[e.name,e.text]),o.headings,o.textSnippets]).length<=24000);
export type PageObservation=z.infer<typeof ObservationSchema>;
export const RunSchema=z.object({id,sessionId:id,status:z.enum(['starting','running','paused_by_human','completed','failed','stopped']),goal:z.string().trim().min(1).max(4000),createdAt:z.string(),startedAt:z.string().optional(),completedAt:z.string().optional(),stepCount:z.number().int().min(0).max(20),limits:z.object({maxSteps:z.number().int().min(1).max(20),maxRuntimeMs:z.number().int().positive().max(300000)}),finishReason:z.enum(['goal_reached','budget_exhausted','run_timeout','stopped_by_user','session_ended','model_error','tool_error']).optional(),summary:z.string().max(4000).optional(),errorCode:AgentErrorSchema.optional()});
export type AgentRun=z.infer<typeof RunSchema>;
export const StepSchema=z.object({id,runId:id,sessionId:id,index:z.number().int().min(1).max(20),observationId:id.optional(),status:z.enum(['running','completed','failed']),tool:z.object({name:ToolNameSchema,safeArgs:z.record(z.string(),z.union([z.string().max(8192),z.number(),z.array(z.string())]))}).optional(),actionId:id.optional(),startedAt:z.string(),completedAt:z.string().optional(),resultSummary:z.string().max(500).optional(),errorCode:AgentErrorSchema.optional()});
export type AgentStep=z.infer<typeof StepSchema>;
export const ToolResultSchema=z.object({ok:z.boolean(),code:AgentErrorSchema.optional(),observation:ObservationSchema.optional(),actionId:id.optional(),summary:z.string().max(500).optional()});
export type ToolResult=z.infer<typeof ToolResultSchema>;
export const AgentRunUpdateSchema=z.object({type:z.literal('agent-run-update'),run:RunSchema});
export const AgentStepUpdateSchema=z.object({type:z.literal('agent-step-update'),step:StepSchema});
const capability={version:z.literal(1),runId:id,sessionId:id,epoch:id};
export const HostMessageSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('agent-ready'),version:z.literal(1),modelAvailable:z.boolean()}),
  z.object({type:z.literal('agent-tool'),...capability,id,stepIndex:z.number().int().min(0).max(20),call:ToolCallSchema}),
  z.object({type:z.literal('agent-step'),...capability,index:z.number().int().min(1).max(20)}),
  z.object({type:z.literal('agent-end'),...capability,reason:z.enum(['goal_reached','budget_exhausted','model_error','tool_error','run_timeout']),code:AgentErrorSchema.optional(),summary:z.string().max(4000).optional()}),
]);
export const HostCommandSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('agent-start'),version:z.literal(1),run:RunSchema,epoch:id,steps:z.array(StepSchema).max(5)}),
  z.object({type:z.literal('agent-abort'),runId:id,epoch:id}),
  z.object({type:z.literal('agent-tool-result'),id,result:ToolResultSchema}),
]);
export type HostMessage=z.infer<typeof HostMessageSchema>;export type HostCommand=z.infer<typeof HostCommandSchema>;
export const AgentOperationSchema=z.object({type:z.literal('agent-operation'),...capability,id,pageId:id,call:ToolCallSchema});
export type AgentOperation=z.infer<typeof AgentOperationSchema>;
export const AgentEpochSchema=z.object({type:z.literal('agent-epoch'),sessionId:id,epoch:id.nullable()});
export const AgentOperationResultSchema=z.object({type:z.literal('agent-operation-result'),id,sessionId:id,result:ToolResultSchema});
export function safeUrl(value:string):string{try{const u=new URL(value);return `${u.origin}${u.pathname}`.slice(0,8192);}catch{return '';}}
export function safeArgs(call:ToolCall):Record<string,string|number|string[]>{if(call.name==='type_text')return {observationId:call.args.observationId,elementRef:call.args.elementRef,characterCount:call.args.text.length};if(call.name==='navigate')return {url:safeUrl(call.args.url)};if(call.name==='finish')return {};return call.args;}
export const dangerousTarget=(name:string):boolean=>/删除[账帐]?[号户]|删除账户|delete\s*account|支付|付款|\b(pay|purchase|transfer)\b|转账|修改密码|change\s*password/i.test(name);
