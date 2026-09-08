import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { LocalArtifactStore, type ArtifactStore } from '@repropath/artifacts';
import { DEFAULT_VIEWPORT, type ActionRecord, type BrowserInput, type InputAction, type Session, type WorkerMessage } from '@repropath/protocol';
import { BrowserRuntime } from '../apps/browser-worker/src/runtime.js';
import { controlFixture } from '../apps/control/src/control-fixture.js';
import { ActionRecorder } from '../apps/browser-worker/src/action-recorder.js';
import { EvidenceCapture } from '../apps/browser-worker/src/evidence.js';
import { until } from './helpers.js';

const pointer = (type: 'pointer-down'|'pointer-up'|'pointer-move', x=200, y=140, button: 'left'|'right'|'middle'='left'): InputAction => ({type,x,y,button,buttons:type==='pointer-up'?0:button==='left'?1:button==='right'?2:4});

test('M1.4 real input normalization, evidence, privacy, bounded settle and failure isolation', {timeout:120000}, async t => {
  const server=createServer((req,res)=> { if(req.url?.startsWith('/fixture/api/')) { const timer=setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');},req.url.includes('slow')?1500:req.url.includes('late')?3000:0);res.on('close',()=>clearTimeout(timer)); } else {res.writeHead(200,{'Content-Type':'text/html'});res.end(controlFixture());} });
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const directory=resolve('test-results',`evidence-${randomUUID()}`);await mkdir(directory,{recursive:true});const store=new LocalArtifactStore(directory);
  const browser=await chromium.launch();const messages:WorkerMessage[]=[];const actions=new Map<string,ActionRecord>();
  let runtime=new BrowserRuntime(m=>{messages.push(m);if(m.type==='action-update')actions.set(m.action.id,m.action);},15000,async()=>browser,undefined,store);
  t.after(async()=>{await runtime.closeAll();server.close();});
  const make=async(suffix='')=>{const s:Session={id:randomUUID(),status:'starting',requestedUrl:base+'/test-page/control'+suffix,currentUrl:'',pageTitle:'',createdAt:new Date().toISOString(),activePageId:null,viewport:{...DEFAULT_VIEWPORT},screencast:{status:'idle'}};await runtime.start(s);const state=messages.filter(m=>m.type==='state'&&m.session.id===s.id).at(-1);assert.ok(state?.type==='state');return state.session;};
  let session=await make();let seq=0;const leaseId=randomUUID();
  const send=async(input:InputAction)=>{const message:BrowserInput={type:'browser-input',sessionId:session.id,pageId:session.activePageId!,leaseId,inputSequence:++seq,input};await runtime.input(message);const result=messages.at(-1);assert.ok(result?.type==='input-result'&&result.ok);};
  const current=()=>[...actions.values()].filter(a=>a.sessionId===session.id);
  const done=async(count:number)=>{await until(()=>current().length===count&&current().at(-1)?.status==='completed','action completed',10000);return current().at(-1)!;};
  await t.test('down/up is one click with true before/after JPEG/DOM and request correlation',async()=>{
    await send(pointer('pointer-down'));await send(pointer('pointer-up'));const a=await done(1);assert.equal(a.kind,'click');assert.equal(a.evidenceStatus,'complete');assert.equal(a.target?.tagName,'button');assert.equal(a.target?.text,'Remote Click Target');assert.equal(a.settle?.timedOut,false);
    for(const phase of [a.before!,a.after!]){const bytes=await store.read(phase.screenshot!.id);assert.equal(bytes[0],255);assert.equal(bytes[1],216);assert.equal(bytes.length,phase.screenshot!.byteLength);assert.equal(createHash('sha256').update(bytes).digest('hex'),phase.screenshot!.sha256);}
    assert.notEqual(a.before!.screenshot!.sha256,a.after!.screenshot!.sha256);assert.notEqual(a.before!.dom!.sha256,a.after!.dom!.sha256);
    const before=(await store.read(a.before!.dom!.id)).toString(),after=(await store.read(a.after!.dom!.id)).toString();assert.ok(before.includes('>BEFORE<'));assert.ok(after.includes('>AFTER<'));
    assert.equal(after.includes('REPROPATH_SECRET_SENTINEL'),false);assert.equal(/<script|<style|<!--|onclick=|data-secret=/i.test(after),false);
    const request=messages.find(m=>m.type==='event'&&m.event.type==='request'&&m.event.payload.url.endsWith('?action=1'));assert.ok(request?.type==='event'&&request.event.type==='request');assert.ok(a.networkRequestIds.includes(request.event.payload.requestId));
    const inputs=messages.filter(m=>m.type==='event'&&m.event.type==='human-input');assert.ok(inputs.every(m=>m.type==='event'&&m.event.sequence>=a.eventSequenceStart&&m.event.sequence<=a.eventSequenceEnd!));
  });
  await t.test('right/middle clicks, drag and 10000 pointer moves have correct Action cardinality',async()=>{
    for(const button of ['right','middle'] as const){await send(pointer('pointer-down',200,140,button));await send(pointer('pointer-up',200,140,button));await done(current().length);assert.equal(current().at(-1)?.kind,'click');}
    const before=current().length;const noise:ActionRecord[]=[];const recorder=new ActionRecorder(session.id,()=>browser.contexts()[0]!.pages()[0],()=>0,new EvidenceCapture(store),a=>noise.push(a));for(let i=0;i<10000;i++){const m:BrowserInput={type:'browser-input',sessionId:session.id,pageId:session.activePageId!,leaseId,inputSequence:i+1,input:pointer('pointer-move',i%1000,50)};await recorder.before(m);recorder.after(m);}assert.equal(noise.length,0);assert.equal(current().length,before);
    await send(pointer('pointer-down',150,440));await send(pointer('pointer-move',390,440));await send(pointer('pointer-up',390,440));const a=await done(before+1);assert.equal(a.kind,'drag');assert.equal(a.detail.kind,'drag');
  });
  await t.test('text chunks merge, key pairs normalize, form DOM and screenshot are masked',async()=>{
    await send(pointer('pointer-down',220,260));await send(pointer('pointer-up',220,260));await done(current().length);
    const before=current().length;await send({type:'text',text:'hello'});await send({type:'text',text:'测试'});const a=await done(before+1);
    assert.deepEqual(a.detail,{kind:'type',characterCount:7});assert.equal(JSON.stringify(a).includes('hello'),false);const dom=(await store.read(a.after!.dom!.id)).toString();assert.equal(dom.includes('hello'),false);assert.equal(dom.includes('hello测试'),false);
    const image=(await store.read(a.after!.screenshot!.id)).toString('base64');const page=browser.contexts()[0]!.pages()[0]!;
    const pixel=await page.evaluate(async image=>{const img=new Image();img.src='data:image/jpeg;base64,'+image;await img.decode();const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;const ctx=canvas.getContext('2d')!;ctx.drawImage(img,0,0);return [...ctx.getImageData(100,260,1,1).data];},image);assert.ok(pixel.slice(0,3).every(n=>Math.abs(n-51)<5));
    const start=current().length;await send({type:'key',key:'Control',action:'down',modifiers:[]});assert.equal(current().length,start);
    for(const key of ['KeyA','Backspace','Enter'] as const){const modifiers=key==='KeyA'?['Control' as const]:[];await send({type:'key',key,action:'down',modifiers});await send({type:'key',key,action:'up',modifiers});await done(current().length);}
    await send({type:'key',key:'Control',action:'up',modifiers:[]});assert.equal(current().length,start+3);
  });
  await t.test('wheel burst groups into one scroll',async()=>{const start=current().length;for(let i=0;i<4;i++)await send({type:'wheel',x:600,y:600,deltaX:0,deltaY:500});const a=await done(start+1);assert.deepEqual(a.detail,{kind:'scroll',totalDeltaX:0,totalDeltaY:2000,eventCount:4});});
  await t.test('slow response participates in settle; late response remains correlated past endSequence',async()=>{
    await runtime.close(session.id);session=await make('?slow=1');await send(pointer('pointer-down'));await send(pointer('pointer-up'));const slow=await done(1);assert.equal(slow.settle?.timedOut,false);assert.ok(slow.settle!.durationMs>=1400);
    await runtime.close(session.id);session=await make('?late=1');await send(pointer('pointer-down'));await send(pointer('pointer-up'));const late=await done(1);assert.equal(late.settle?.timedOut,true);
    await until(()=>messages.some(m=>m.type==='event'&&m.event.sessionId===session.id&&m.event.type==='response'&&m.event.payload.url.endsWith('/late')),'late response');
    const response=messages.find(m=>m.type==='event'&&m.event.sessionId===session.id&&m.event.type==='response'&&m.event.payload.url.endsWith('/late'));assert.ok(response?.type==='event'&&response.event.type==='response');assert.ok(late.networkRequestIds.includes(response.event.payload.requestId));assert.ok(response.event.sequence>late.eventSequenceEnd!);
  });
  await t.test('continuous requests settle within bound and incomplete pointer closes as interrupted',async()=>{
    await runtime.close(session.id);session=await make('?busy=1');await send(pointer('pointer-down'));await send(pointer('pointer-up'));const a=await done(1);assert.equal(a.settle?.timedOut,true);assert.ok(a.settle!.durationMs<2400);
    await send(pointer('pointer-down'));const id=current().at(-1)!.id;await runtime.close(session.id);assert.equal(actions.get(id)?.status,'interrupted');assert.ok(actions.get(id)?.before?.screenshot);
  });
  await t.test('quota and write failure do not prevent real click',async()=>{
    const page=await browser.newPage();await page.goto(base);const a=[...actions.values()][0]!;const quota=new EvidenceCapture(store,1);const snapshot=await quota.capture(page,a,'before',true);assert.equal(snapshot.dom,undefined);assert.equal(snapshot.screenshot,undefined);await page.close();
    const broken:ArtifactStore={put:async()=>{throw new Error('simulated');},read:async()=>{throw new Error('unavailable');}};
    runtime=new BrowserRuntime(m=>{messages.push(m);if(m.type==='action-update')actions.set(m.action.id,m.action);},15000,async()=>browser,undefined,broken);
    session=await make();await send(pointer('pointer-down'));await send(pointer('pointer-up'));const failed=await done(1);assert.equal(failed.evidenceStatus,'failed');assert.ok(messages.some(m=>m.type==='event'&&m.event.sessionId===session.id&&m.event.type==='console'&&m.event.payload.text==='remote-click-ok'));
    assert.equal(browser.contexts().at(-1)?.pages()[0]?.isClosed(),false);
  });
});



// Quota policy unit check; browser effects are covered by the real Runtime test above.
test('Recorder stops new evidence after 500 Actions while continuing bounded metadata', async () => {
  const enabled: boolean[] = []; const updates: ActionRecord[] = [];
  const page = { isClosed: () => false, evaluate: async () => undefined } as unknown as import('playwright').Page;
  const capture = { capture: async (_page: unknown, action: ActionRecord, phase: 'before'|'after', allow: boolean) => {
    enabled.push(allow); return { id: randomUUID(), sessionId: 'S', actionId: action.id, pageId: 'P', phase, capturedAt: new Date().toISOString(), url: '', title: '', viewport: DEFAULT_VIEWPORT };
  } } as unknown as EvidenceCapture;
  const recorder = new ActionRecorder('S', () => page, () => 1, capture, a => updates.push(a));
  for (let i=0;i<501;i++) { await recorder.before({ type:'browser-input',sessionId:'S',pageId:'P',leaseId:randomUUID(),inputSequence:i+1,input:pointer('pointer-down') }); recorder.interrupt(); }
  assert.equal(enabled.length,501); assert.ok(enabled.slice(0,500).every(Boolean)); assert.equal(enabled[500],false);
  assert.equal(updates.at(-1)?.status,'interrupted'); assert.equal(updates.at(-1)?.evidenceStatus,'partial');
});
