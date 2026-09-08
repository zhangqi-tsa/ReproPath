import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { names, loadAdapter, type KernelName } from './common/adapters.js';
import { FakeModel } from './common/fake-model.js';
import { MockGateway } from './common/gateway.js';
const stats = (values: number[]) => { const s=[...values].sort((a,b)=>a-b); return { medianMs:(s[Math.floor((s.length-1)/2)]!+s[Math.floor(s.length/2)]!)/2,p95Ms:s[Math.ceil(s.length*.95)-1],samplesMs:values }; };
async function cold(name: KernelName): Promise<number> {
  const start=performance.now(); const child=spawn(process.execPath,['--import','tsx','src/cold.ts',name],{stdio:['ignore','pipe','pipe']});
  return new Promise((resolve,reject)=>{ let ready:number|undefined; let output=''; const timer=setTimeout(()=>{child.kill();reject(Error('cold timeout'));},30000);
    child.stdout.on('data',data=>{output+=String(data);if(output.includes('ready')&&ready===undefined)ready=performance.now()-start;});
    child.on('error',reject); child.on('exit',code=>{clearTimeout(timer);if(code!==0||ready===undefined)reject(Error('cold failed'));else resolve(ready);});
  });
}
const fake=new FakeModel(); const model=await fake.start(); const results:Record<string,unknown>={};
try { for(const name of names){
  console.log(`${name}: 10 cold starts`); const coldSamples:number[]=[];for(let i=0;i<10;i++)coldSamples.push(await cold(name));
  console.log(`${name}: 100 fake loops`);const adapter=await loadAdapter(name);const warm:number[]=[];
  for(let i=0;i<100;i++){fake.reset();const gateway=new MockGateway();const start=performance.now();const r=await adapter.run({model,gateway});warm.push(performance.now()-start);if(r.reason!=='completed'||gateway.finishCount!==1||fake.requests.length!==4)throw Error(`${name} iteration ${i} failed`);}
  results[name]={cold:stats(coldSamples),fakeLoop:stats(warm)};
}}finally{await fake.close();}
await mkdir('results',{recursive:true});await writeFile('results/benchmark.json',JSON.stringify({date:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,method:'Sequential; cold=spawn to ready stdout (SDK imports + exported runnable adapter, no model/MCP initialization); warm=4-step native SDK loop + localhost HTTP fake, imports excluded, 100 samples including first run; not model latency.',results},null,2));
console.log(JSON.stringify(results,(_key,value)=>Array.isArray(value)?`n=${value.length}`:value,2));
