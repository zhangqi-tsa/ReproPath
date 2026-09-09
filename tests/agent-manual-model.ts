// Local acceptance helper only. Never loaded by production services.
import { AgentFakeModel } from './agent-model.js';
const fake=new AgentFakeModel();const phases=new Map<string,number>();
fake.plan=(o)=>{
  const request=fake.requests.at(-1)!;const goal=JSON.parse(request.messages.at(-1)!.content).goal as string;
  const phase=phases.get(o.sessionId)??0;phases.set(o.sessionId,(phase+1)%4);
  const call=phase===0||phase===2?{name:'observe_page',args:{}}:phase===1?{name:'click',args:{observationId:o.id,elementRef:o.elements.find(e=>e.name==='Login')!.ref}}:{name:'finish',args:{summary:'登录提交后出现 HTTP 500，已记录现场。'}};
  return {calls:[call],delayMs:phase===0&&goal.includes('延迟')?3000:250};
};
console.log(JSON.stringify({baseURL:await fake.start(),model:'fixture'}));
const stop=()=>{void fake.close().then(()=>process.exit(0));};process.on('SIGINT',stop);process.on('SIGTERM',stop);
