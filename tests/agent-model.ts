import { createServer } from 'node:http';
import { once } from 'node:events';
import type { PageObservation } from '@repropath/agent-protocol';
export interface FakeReply {calls?:{name:string;args:unknown}[];text?:string;delayMs?:number;broken?:boolean}
export type Plan=(observation:PageObservation,index:number)=>FakeReply;
export const happy:Plan=(o,i)=>i===0?{calls:[{name:'observe_page',args:{}}]}:i===1?{calls:[{name:'click',args:{observationId:o.id,elementRef:o.elements.find(e=>e.name==='Login')!.ref}}]}:i===2?{calls:[{name:'observe_page',args:{}}]}:{calls:[{name:'finish',args:{summary:'登录提交后出现 HTTP 500。'}}]};
export class AgentFakeModel{
  requests:{messages:{role:string;content:string}[];tools:unknown[]}[]=[];plan:Plan=happy;aborted=0;private timers=new Set<ReturnType<typeof setTimeout>>();
  private server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));const body=JSON.parse(Buffer.concat(chunks).toString());const i=this.requests.length;this.requests.push(body);
    const message=body.messages.findLast((m:{role:string})=>m.role==='user');let observation:PageObservation;try{observation=JSON.parse(message.content).observation;}catch{observation={} as PageObservation;}
    const reply=this.plan(observation,i);let sent=false;
    const send=()=>{if(res.destroyed)return;sent=true;if(reply.broken){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"broken":true}');return;}res.writeHead(200,{'Content-Type':'text/event-stream'});
      const chunk=(delta:unknown,finish:string|null=null)=>res.write(`data: ${JSON.stringify({id:`fake-${i}`,object:'chat.completion.chunk',created:0,model:body.model,choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
      chunk({role:'assistant',...(reply.calls?{tool_calls:reply.calls.map((c,j)=>({index:j,id:`call-${i}-${j}`,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))}:{content:reply.text??'完成'})});chunk({},reply.calls?'tool_calls':'stop');res.end('data: [DONE]\n\n');};
    const timer=setTimeout(()=>{this.timers.delete(timer);send();},reply.delayMs??0);this.timers.add(timer);res.on('close',()=>{if(!sent)this.aborted++;clearTimeout(timer);this.timers.delete(timer);});
  });
  async start(){this.server.listen(0,'127.0.0.1');await once(this.server,'listening');const address=this.server.address();if(!address||typeof address==='string')throw Error('port');return `http://127.0.0.1:${address.port}/v1`;}
  reset(plan:Plan=happy){this.plan=plan;this.requests=[];}
  async close(){for(const t of this.timers)clearTimeout(t);this.server.closeAllConnections();await new Promise<void>(r=>this.server.close(()=>r()));}
}
