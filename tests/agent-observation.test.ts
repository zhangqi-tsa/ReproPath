import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { AgentPage } from '../apps/browser-worker/src/agent-page.js';
import { ActionRecorder } from '../apps/browser-worker/src/action-recorder.js';
import { EvidenceCapture } from '../apps/browser-worker/src/evidence.js';
import { LocalArtifactStore } from '@repropath/artifacts';
import { agentFixture } from '../apps/control/src/agent-fixture.js';
import { ObservationSchema } from '@repropath/agent-protocol';
import type { ActionRecord } from '@repropath/protocol';
test('Agent semantic extraction real Chromium',async()=>{const browser=await chromium.launch();try{const page=await browser.newPage();await page.setContent(agentFixture());const recorder=new ActionRecorder('fixture',()=>page,()=>0,new EvidenceCapture(new LocalArtifactStore()),()=>{});const agent=new AgentPage(()=>page,()=> 'page',recorder);agent.setEpoch('epoch');const o=await agent.observe('fixture');assert.ok(o.elements.some(e=>e.name==='Login'));assert.doesNotMatch(JSON.stringify(o),/PRIVATE_PASSWORD|PRIVATE_TEXTAREA|INITIAL_PRIVATE_VALUE|Hidden button/);const o2=await agent.observe('fixture');assert.notEqual(o.id,o2.id);agent.setEpoch(null);}finally{await browser.close();}});
test('Observation bounds, stale refs, detached refs and delayed epoch fence',async()=>{
  const browser=await chromium.launch();try{const page=await browser.newPage();await page.setContent(agentFixture());const actions:ActionRecord[]=[];const recorder=new ActionRecorder('fixture',()=>page,()=>0,new EvidenceCapture(new LocalArtifactStore()),a=>actions.push(a));const agent=new AgentPage(()=>page,()=> 'page',recorder,250);agent.setEpoch('epoch');
    const first=await agent.observe('fixture');const second=await agent.observe('fixture');const command={type:'agent-operation' as const,version:1 as const,id:'request',runId:'run',sessionId:'fixture',epoch:'epoch',pageId:'page'};
    assert.equal((await agent.execute({...command,call:{name:'click',args:{observationId:first.id,elementRef:first.elements.find(e=>e.name==='Login')!.ref}}})).code,'STALE_OBSERVATION');assert.equal(actions.length,0);
    await page.locator('#login').evaluate(e=>e.remove());assert.equal((await agent.execute({...command,call:{name:'click',args:{observationId:second.id,elementRef:second.elements.find(e=>e.name==='Login')!.ref}}})).code,'STALE_ELEMENT');assert.equal(actions.length,0);
    await page.setContent(agentFixture());const third=await agent.observe('fixture');const pending=agent.execute({...command,call:{name:'click',args:{observationId:third.id,elementRef:third.elements.find(e=>e.name==='Login')!.ref}}});setTimeout(()=>agent.setEpoch(null),30);assert.equal((await pending).code,'CONTROL_NOT_OWNED');await new Promise(r=>setTimeout(r,300));assert.equal(actions.length,0);assert.equal(await page.evaluate('window.loginCount'),0);
    await page.setContent('<h1>Bounds</h1>'+Array.from({length:250},()=>`<button>${'x'.repeat(500)}</button>`).join(''));const bounded=ObservationSchema.parse(await agent.observe('fixture'));assert.equal(bounded.elements.length,200);assert.equal(bounded.truncated,true);assert.ok(bounded.headings.length<=50);assert.ok(bounded.textSnippets.length<=100);assert.ok(bounded.elements.reduce((n,e)=>n+e.name.length+(e.text?.length??0),0)<=20000);agent.setEpoch(null);
  }finally{await browser.close();}
});
