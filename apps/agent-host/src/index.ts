import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { HostCommandSchema, type HostMessage, type ToolResult } from '@repropath/agent-protocol';
import { modelConfig, runKernel } from './kernel.js';
// SDK default loggers can include provider payloads. This isolated process only emits codes.
console.error=()=>{process.stderr.write('AGENT_SDK_ERROR\n');};
console.warn=()=>{process.stderr.write('AGENT_SDK_WARNING\n');};
const model=modelConfig();const port=Number(process.env.AGENT_HOST_PORT??4312);
const controlURL=process.env.AGENT_CONTROL_URL??'ws://127.0.0.1:4310/agent-host';
const runs=new Map<string,{epoch:string;abort:AbortController}>();
const pending=new Map<string,{resolve:(r:ToolResult)=>void;timer:ReturnType<typeof setTimeout>;runId:string}>();
let socket:WebSocket;let closing=false;let retry:ReturnType<typeof setTimeout>|undefined;
function send(message:HostMessage){if(socket.readyState===WebSocket.OPEN&&socket.bufferedAmount<1024*1024)socket.send(JSON.stringify(message));else throw Error('AGENT_HOST_UNAVAILABLE');}
function stop(runId:string){runs.get(runId)?.abort.abort();runs.delete(runId);for(const [id,p]of pending)if(p.runId===runId){clearTimeout(p.timer);p.resolve({ok:false,code:'MODEL_ABORTED'});pending.delete(id);}}
function connect(){
  socket=new WebSocket(controlURL,{maxPayload:256*1024});
  socket.on('open',()=>send({type:'agent-ready',version:1,modelAvailable:!!model}));
  socket.on('message',raw=>{try{
    const command=HostCommandSchema.parse(JSON.parse(raw.toString()));
    if(command.type==='agent-abort'){if(runs.get(command.runId)?.epoch===command.epoch)stop(command.runId);return;}
    if(command.type==='agent-tool-result'){const p=pending.get(command.id);if(p){clearTimeout(p.timer);pending.delete(command.id);p.resolve(command.result);}return;}
    if(!model)return;stop(command.run.id);const state={epoch:command.epoch,abort:new AbortController()};runs.set(command.run.id,state);
    const identity={version:1 as const,runId:command.run.id,sessionId:command.run.sessionId,epoch:command.epoch};
    void runKernel({run:command.run,steps:command.steps,model,signal:state.abort.signal,
      step:index=>send({type:'agent-step',...identity,index}),gateway:(call,stepIndex)=>new Promise(resolve=>{
        if(state.abort.signal.aborted){resolve({ok:false,code:'MODEL_ABORTED'});return;}
        const id=randomUUID();const timer=setTimeout(()=>{pending.delete(id);resolve({ok:false,code:'RUN_TIMEOUT'});stop(command.run.id);},20000);
        pending.set(id,{resolve,timer,runId:command.run.id});send({type:'agent-tool',...identity,id,stepIndex,call});
      }),
    }).then(result=>{if(runs.get(command.run.id)===state&&!state.abort.signal.aborted)send({type:'agent-end',...identity,...result});}).catch(()=>{if(!state.abort.signal.aborted)send({type:'agent-end',...identity,reason:'model_error',code:'MODEL_PROTOCOL_ERROR'});}).finally(()=>{if(runs.get(command.run.id)===state)stop(command.run.id);});
  }catch{socket.close(1008,'INVALID_AGENT_PROTOCOL');}});
  socket.on('error',()=>{});socket.on('close',()=>{for(const id of runs.keys())stop(id);if(!closing)retry=setTimeout(connect,1000);});
}
const server=createServer((req,res)=>{res.writeHead(req.url==='/health'?200:404,{'Content-Type':'application/json'});res.end(JSON.stringify({service:'agent-host',modelAvailable:!!model}));});
server.listen(port,'127.0.0.1');connect();
function shutdown(){closing=true;clearTimeout(retry);for(const id of runs.keys())stop(id);socket.close();server.close();process.disconnect?.();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);process.on('message',m=>{if(m==='shutdown')shutdown();});
