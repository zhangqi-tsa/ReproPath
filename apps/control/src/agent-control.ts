import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { HostMessageSchema, RunSchema, dangerousTarget, safeArgs, safeUrl, type AgentRun, type AgentStep, type HostCommand, type PageObservation, type ToolCall, type ToolResult, type AgentError, type AgentOperation } from '@repropath/agent-protocol';
import type { Session, ServerMessage, WorkerCommand } from '@repropath/protocol';
import type { ControlAuthority } from './control-authority.js';
interface RecordRun {run:AgentRun;steps:AgentStep[];epoch?:string;observation?:PageObservation;timer?:ReturnType<typeof setTimeout>;usedStep?:number;inFlight:boolean;secrets:string[];elapsed:number;clock?:number}
export class AgentControl {
  private host?:WebSocket;private modelAvailable=false;
  private records=new Map<string,RecordRun>();
  private pending=new Map<string,{runId:string;resolve:(r:ToolResult)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(private deps:{session:(id:string)=>Session|undefined;authority:ControlAuthority;worker:(message:WorkerCommand)=>void;broadcast:(id:string,message:ServerMessage)=>void;findings:(id:string)=>PageObservation['findings'];limits?:{maxSteps:number;maxRuntimeMs:number}}){
    deps.authority.onAgentRevoked=(_session,id,reason)=>{const r=this.records.get(id);if(!r||!r.epoch)return;this.invalidate(r);if(['starting','running'].includes(r.run.status)){r.run.status=reason==='human_takeover'?'paused_by_human':'stopped';if(reason!=='human_takeover'){r.run.finishReason='session_ended';r.run.completedAt=new Date().toISOString();}this.publish(r);}};
  }
  health(){return {agentHostConnected:this.host?.readyState===WebSocket.OPEN,modelAvailable:this.modelAvailable};}
  attach(socket:WebSocket){if(this.host){socket.close(1013,'ONE_AGENT_HOST');return;}this.host=socket;this.modelAvailable=false;
    socket.on('message',raw=>{try{const m=HostMessageSchema.parse(JSON.parse(raw.toString()));
      if(m.type==='agent-ready'){this.modelAvailable=m.modelAvailable;return;}
      const r=this.records.get(m.runId);if(!r||r.epoch!==m.epoch||r.run.sessionId!==m.sessionId||!this.owned(r))return;
      if(m.type==='agent-step'){
        if(m.index!==r.run.stepCount+1||m.index>r.run.limits.maxSteps){this.end(r,'completed','budget_exhausted');return;}
        r.run.stepCount=m.index;r.run.status='running';const step:AgentStep={id:randomUUID(),runId:r.run.id,sessionId:r.run.sessionId,index:m.index,status:'running',startedAt:new Date().toISOString()};r.steps.push(step);this.deps.broadcast(r.run.sessionId,{type:'agent-step-update',step});this.publish(r);return;
      }
      if(m.type==='agent-end'){this.end(r,m.reason==='budget_exhausted'?'completed':'failed',m.reason==='goal_reached'?'model_error':m.reason,m.code);return;}
      void this.tool(r,m.call,m.stepIndex).then(result=>this.send({type:'agent-tool-result',id:m.id,result})).catch(()=>this.send({type:'agent-tool-result',id:m.id,result:{ok:false,code:'TOOL_EXECUTION_ERROR'}}));
    }catch{socket.close(1008,'INVALID_AGENT_PROTOCOL');}});
    socket.on('error',()=>{});socket.on('close',()=>{if(this.host!==socket)return;this.host=undefined;this.modelAvailable=false;for(const r of this.records.values())if(r.epoch)this.end(r,'failed','model_error','AGENT_HOST_UNAVAILABLE');});
  }
  private send(message:HostCommand){if(this.host?.readyState===WebSocket.OPEN){if(this.host.bufferedAmount>1024*1024){this.host.terminate();return;}this.host.send(JSON.stringify(message));}}
  private publish(r:RecordRun){this.deps.broadcast(r.run.sessionId,{type:'agent-run-update',run:structuredClone(r.run)});}
  list(sessionId:string){return [...this.records.values()].filter(r=>r.run.sessionId===sessionId).map(r=>({run:r.run,steps:r.steps}));}
  get(sessionId:string,id:string){const r=this.records.get(id);return r?.run.sessionId===sessionId?{run:r.run,steps:r.steps}:undefined;}
  private unavailable(sessionId:string):AgentError|undefined {if(this.deps.session(sessionId)?.status!=='running')return 'SESSION_NOT_RUNNING';if(!this.health().agentHostConnected)return 'AGENT_HOST_UNAVAILABLE';if(!this.modelAvailable)return 'AGENT_MODEL_UNAVAILABLE';}
  start(sessionId:string,goal:string):{run?:AgentRun;error?:AgentError}{
    const error=this.unavailable(sessionId);if(error)return {error};
    if(this.deps.authority.humanOwned(sessionId))return {error:'CONTROL_BUSY'};
    if([...this.records.values()].some(r=>r.run.sessionId===sessionId&&['starting','running','paused_by_human'].includes(r.run.status)))return {error:'AGENT_ALREADY_RUNNING'};
    if(this.deps.authority.busy(sessionId))return {error:'CONTROL_BUSY'};
    const entries=[...this.records.values()].filter(r=>r.run.sessionId===sessionId);if(entries.length>=20){const oldest=entries.find(r=>['completed','failed','stopped'].includes(r.run.status));if(oldest)this.records.delete(oldest.run.id);}
    const run=RunSchema.parse({id:randomUUID(),sessionId,status:'starting',goal,createdAt:new Date().toISOString(),stepCount:0,limits:this.deps.limits??{maxSteps:20,maxRuntimeMs:300000}});
    const r:RecordRun={run,steps:[],inFlight:false,secrets:[],elapsed:0};this.records.set(run.id,r);this.launch(r);return {run:r.run};
  }
  resume(sessionId:string,id:string):{run?:AgentRun;error?:AgentError}|undefined {const r=this.records.get(id);if(!r||r.run.sessionId!==sessionId)return;
    if(r.run.status!=='paused_by_human')return {error:'RUN_NOT_RESUMABLE'};const error=this.unavailable(sessionId);if(error)return {error};if(this.deps.authority.busy(sessionId))return {error:'CONTROL_BUSY'};
    if(r.run.stepCount>=r.run.limits.maxSteps){this.end(r,'completed','budget_exhausted');return {run:r.run};}this.launch(r);return {run:r.run};
  }
  stop(sessionId:string,id:string){const r=this.records.get(id);if(!r||r.run.sessionId!==sessionId)return;if(!['starting','running','paused_by_human'].includes(r.run.status))return {error:'RUN_NOT_RESUMABLE' as AgentError};this.end(r,'stopped','stopped_by_user');return {run:r.run};}
  private launch(r:RecordRun){const epoch=this.deps.authority.acquireAgent(r.run.sessionId,r.run.id);if(!epoch)throw Error('CONTROL_BUSY');r.epoch=epoch;r.observation=undefined;r.inFlight=false;r.usedStep=undefined;r.run.status='running';r.run.startedAt??=new Date().toISOString();r.clock=Date.now();
    const remaining=Math.max(1,r.run.limits.maxRuntimeMs-r.elapsed);r.timer=setTimeout(()=>this.end(r,'failed','run_timeout','RUN_TIMEOUT'),remaining);this.publish(r);
    this.send({type:'agent-start',version:1,epoch,run:{...r.run,limits:{...r.run.limits,maxRuntimeMs:remaining}},steps:r.steps.slice(-5)});
  }
  private owned(r:RecordRun){return !!r.epoch&&['starting','running'].includes(r.run.status)&&this.deps.session(r.run.sessionId)?.status==='running'&&this.deps.authority.ownedByAgent(r.run.sessionId,r.run.id,r.epoch);}
  private invalidate(r:RecordRun,code:AgentError='MODEL_ABORTED'){const epoch=r.epoch;r.epoch=undefined;r.observation=undefined;clearTimeout(r.timer);if(r.clock){r.elapsed+=Date.now()-r.clock;r.clock=undefined;}if(epoch)this.send({type:'agent-abort',runId:r.run.id,epoch});
    for(const [id,p]of this.pending)if(p.runId===r.run.id){clearTimeout(p.timer);p.resolve({ok:false,code:'CONTROL_NOT_OWNED'});this.pending.delete(id);}
    for(const s of r.steps)if(s.status==='running'){s.status='failed';s.errorCode=code;s.completedAt=new Date().toISOString();this.deps.broadcast(r.run.sessionId,{type:'agent-step-update',step:s});}
  }
  private end(r:RecordRun,status:AgentRun['status'],reason:AgentRun['finishReason'],code?:AgentError){r.run.status=status;r.run.finishReason=reason;r.run.errorCode=code;r.run.completedAt=new Date().toISOString();const owned=!!r.epoch;this.invalidate(r,code);if(owned)this.deps.authority.revoke(r.run.sessionId,'agent_ended');this.publish(r);r.secrets=[];}
  sessionEnded(sessionId:string){for(const r of this.records.values())if(r.run.sessionId===sessionId&&['starting','running','paused_by_human'].includes(r.run.status))this.end(r,'stopped','session_ended');}
  navigation(sessionId:string){for(const r of this.records.values())if(r.run.sessionId===sessionId)r.observation=undefined;}
  forget(sessionId:string){this.sessionEnded(sessionId);for(const [id,r]of this.records)if(r.run.sessionId===sessionId)this.records.delete(id);}
  shutdown(){for(const r of this.records.values())if(['starting','running','paused_by_human'].includes(r.run.status))this.end(r,'stopped','session_ended');this.host?.close();}
  workerResult(id:string,result:ToolResult){const p=this.pending.get(id);if(!p)return;clearTimeout(p.timer);this.pending.delete(id);p.resolve(result);}
  private rpc(r:RecordRun,call:ToolCall):Promise<ToolResult>{const session=this.deps.session(r.run.sessionId);if(!this.owned(r)||!session?.activePageId)return Promise.resolve({ok:false,code:'CONTROL_NOT_OWNED'});
    const id=randomUUID();return new Promise(resolve=>{const timer=setTimeout(()=>{this.pending.delete(id);resolve({ok:false,code:'RUN_TIMEOUT'});this.end(r,'failed','run_timeout','RUN_TIMEOUT');},18000);this.pending.set(id,{runId:r.run.id,resolve,timer});
      const command:AgentOperation={type:'agent-operation',version:1,id,sessionId:r.run.sessionId,runId:r.run.id,epoch:r.epoch!,pageId:session.activePageId!,call};this.deps.worker(command);
    });
  }
  private async tool(r:RecordRun,call:ToolCall,index:number):Promise<ToolResult>{
    const epoch=r.epoch;if(!this.owned(r))return {ok:false,code:'CONTROL_NOT_OWNED'};
    if(r.inFlight)return {ok:false,code:'ONE_TOOL_PER_TURN'};
    if(index===0&&call.name!=='observe_page')return {ok:false,code:'TOOL_VALIDATION_ERROR'};
    if(index>0&&(index!==r.run.stepCount||r.usedStep===index))return {ok:false,code:'ONE_TOOL_PER_TURN'};
    if(index>0)r.usedStep=index;
    const step=index>0?r.steps.find(s=>s.index===index):undefined;
    if(step){step.tool={name:call.name,safeArgs:safeArgs(call)};step.observationId=r.observation?.id;}
    if(call.name==='type_text')r.secrets.push(call.args.text);
    let result:ToolResult;
    const session=this.deps.session(r.run.sessionId)!;
    const obs=r.observation;
    const elementRef='elementRef'in call.args?call.args.elementRef:undefined;
    const element=obs?.elements.find(e=>e.ref===elementRef);
    if(!['observe_page','wait','finish'].includes(call.name)&&(!obs||obs.pageId!==session.activePageId))result={ok:false,code:'STALE_OBSERVATION'};
    else if('observationId'in call.args&&(!obs||obs.id!==call.args.observationId||obs.pageId!==session.activePageId))result={ok:false,code:'STALE_OBSERVATION'};
    else if('elementRef'in call.args&&!element)result={ok:false,code:'STALE_ELEMENT'};
    else if(call.name==='click'&&dangerousTarget(`${element?.name} ${element?.text}`))result={ok:false,code:'POLICY_BLOCKED'};
    else if(call.name==='navigate'&&new URL(call.args.url).origin!==new URL(session.requestedUrl).origin)result={ok:false,code:'POLICY_BLOCKED'};
    else if(call.name==='finish'){
      r.run.summary=r.secrets.reduce((s,v)=>s.split(v).join('[redacted]'),call.args.summary);result={ok:true,summary:'检查结束'};
    }else {r.inFlight=true;try{result=await this.rpc(r,call);}finally{if(r.epoch===epoch)r.inFlight=false;}}
    if(r.epoch!==epoch||!this.owned(r))return {ok:false,code:'CONTROL_NOT_OWNED'};
    if(result.observation){result.observation.findings=this.deps.findings(r.run.sessionId).slice(-10);r.observation=result.observation;}
    else if(result.ok&&!['wait','finish'].includes(call.name))r.observation=undefined;
    if(step){step.status=result.ok?'completed':'failed';step.completedAt=new Date().toISOString();step.actionId=result.actionId;step.errorCode=result.code;step.resultSummary=result.code??`${call.name} completed`;this.deps.broadcast(r.run.sessionId,{type:'agent-step-update',step:structuredClone(step)});}
    if(call.name==='finish'&&result.ok)this.end(r,'completed','goal_reached');return result;
  }
}
