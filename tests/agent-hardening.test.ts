import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { AgentPage } from '../apps/browser-worker/src/agent-page.js';
import { ActionRecorder } from '../apps/browser-worker/src/action-recorder.js';
import { EvidenceCapture } from '../apps/browser-worker/src/evidence.js';
import { LocalArtifactStore } from '@repropath/artifacts';
import type { ActionRecord } from '@repropath/protocol';
import { SessionSchema } from '@repropath/protocol';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { AgentControl } from '../apps/control/src/agent-control.js';
import { ControlAuthority } from '../apps/control/src/control-authority.js';
import { until } from './helpers.js';
import type { HostCommand } from '@repropath/agent-protocol';

test('Host agent-end reasons map to terminal Run states and revoke ownership',async()=>{
  const session=SessionSchema.parse({id:'session',status:'running',requestedUrl:'http://127.0.0.1/',currentUrl:'http://127.0.0.1/',pageTitle:'test',createdAt:new Date().toISOString(),activePageId:'page',viewport:{width:1440,height:900},screencast:{status:'live'}});
  const authority=new ControlAuthority({session:()=>session,subscribers:new Map(),ready:()=>true,writable:()=>true,send:()=>{},worker:()=>{}});
  const control=new AgentControl({session:()=>session,authority,worker:()=>{},broadcast:()=>{},findings:()=>[]});
  const server=new WebSocketServer({port:0,host:'127.0.0.1'});await once(server,'listening');server.on('connection',socket=>control.attach(socket));
  const socket=new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}`);const messages:HostCommand[]=[];socket.on('message',raw=>messages.push(JSON.parse(raw.toString())));await once(socket,'open');
  try{
    socket.send(JSON.stringify({type:'agent-ready',version:1,modelAvailable:true}));await until(()=>control.health().modelAvailable,'Host ready');
    for(const reason of ['goal_reached','budget_exhausted','run_timeout','model_error','tool_error'] as const){
      const {run}=control.start('session','test');assert.ok(run);await until(()=>messages.some(m=>m.type==='agent-start'&&m.run.id===run.id),'start command');
      const start=messages.find(m=>m.type==='agent-start'&&m.run.id===run.id);assert.ok(start?.type==='agent-start');
      socket.send(JSON.stringify({type:'agent-end',version:1,sessionId:'session',runId:run.id,epoch:start.epoch,reason}));
      await until(()=>!!control.get('session',run.id)!.run.completedAt,'terminal state');
      assert.equal(control.get('session',run.id)!.run.status,['goal_reached','budget_exhausted'].includes(reason)?'completed':'failed');assert.equal(control.get('session',run.id)!.run.finishReason,reason);assert.equal(authority.busy('session'),false);
    }
  }finally{control.shutdown();socket.terminate();await new Promise<void>(r=>server.close(()=>r()));}
});

test('Agent document origin fence and observed element attribution in real Chromium',async t=>{
  let externalRequests=0;
  const external=createServer((_req,res)=>{externalRequests++;res.setHeader('Access-Control-Allow-Origin','*');res.end('external');});
  await new Promise<void>(r=>external.listen(0,'127.0.0.1',r));
  const outside=`http://127.0.0.1:${(external.address() as {port:number}).port}`;
  const server=createServer((req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{Location:outside});res.end();return;}
    res.setHeader('Content-Type','text/html');res.end(`<a href="/next">Same</a><a href="${outside}">External</a><button onclick="location.href='${outside}'">JS</button><a href="/redirect">Redirect</a><form action="${outside}"><button>Submit</button></form><button aria-label="Nested"><span>Child</span></button><input aria-label="First" value="PRIVATE_FIRST"><input aria-label="Second" value="PRIVATE_SECOND">`);
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser=await chromium.launch();
  try{
    const page=await browser.newPage();const actions:ActionRecord[]=[];
    const recorder=new ActionRecorder('hardening',()=>page,()=>0,new EvidenceCapture(new LocalArtifactStore('test-results/agent-hardening')),a=>actions.push(a));
    const agent=new AgentPage(()=>page,()=> 'page',recorder);
    await agent.guardNavigations(page,origin);await page.goto(origin);agent.setEpoch('epoch');
    const command={type:'agent-operation' as const,version:1 as const,id:'req',runId:'run',sessionId:'hardening',epoch:'epoch',pageId:'page'};
    const click=async(name:string)=>{const o=await agent.observe('hardening');return agent.execute({...command,call:{name:'click',args:{observationId:o.id,elementRef:o.elements.find(e=>e.name===name)!.ref}}});};
    await t.test('same-origin anchor allowed',async()=>{assert.equal((await click('Same')).ok,true);assert.equal(page.url(),origin+'/next');});
    for(const name of ['External','JS','Redirect','Submit'])await t.test(`${name} document navigation blocked without replacing page`,async()=>{
      const before=page.url();const count=externalRequests;const result=await click(name);assert.equal(result.code,'POLICY_BLOCKED');assert.equal(page.url(),before);assert.equal(externalRequests,count);assert.equal(await page.locator('button[aria-label=Nested]').count(),1);
    });
    await t.test('cross-origin API and child frame allowed',async()=>{
      assert.equal(await page.evaluate(async url=>(await fetch(url)).text(),outside),'external');
      await page.evaluate(url=>{const frame=document.createElement('iframe');frame.src=url;document.body.append(frame);},outside);
      await page.frameLocator('iframe').locator('body').waitFor();assert.ok(externalRequests>=2);
    });
    await t.test('observed parent and unfocused input attribution excludes values',async()=>{
      assert.equal((await click('Nested')).ok,true);assert.equal(actions.at(-1)!.target?.tagName,'button');assert.equal(actions.at(-1)!.target?.ariaLabel,'Nested');
      await page.getByLabel('First').focus();const o=await agent.observe('hardening');const result=await agent.execute({...command,call:{name:'type_text',args:{observationId:o.id,elementRef:o.elements.find(e=>e.name==='Second')!.ref,text:'PRIVATE_TYPED'}}});
      assert.equal(result.ok,true);assert.equal(actions.at(-1)!.target?.ariaLabel,'Second');assert.doesNotMatch(JSON.stringify(actions),/PRIVATE_FIRST|PRIVATE_SECOND|PRIVATE_TYPED/);
    });
    await t.test('Human navigation unrestricted after epoch revoked',async()=>{agent.setEpoch(null);await page.goto(outside);assert.equal(new URL(page.url()).origin,outside);});
  }finally{await browser.close();await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>external.close(()=>r()))]);}
});
