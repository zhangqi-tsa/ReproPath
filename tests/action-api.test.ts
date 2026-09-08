import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { LocalArtifactStore } from '@repropath/artifacts';
import { ActionRecordSchema, type ActionRecord } from '@repropath/protocol';
import { ActionStore } from '../apps/control/src/actions.js';
import { create, freePort, ready, service, subscribe, until } from './helpers.js';

test('M1.4 REST, realtime UI, artifact access control, refresh and closed evidence', {timeout:60000},async t=>{
  const wp=await freePort(),cp=await freePort(),vp=await freePort();const base=`http://127.0.0.1:${cp}`,web=`http://127.0.0.1:${vp}`;
  const dir=resolve('test-results',`api-evidence-${randomUUID()}`);await mkdir(dir,{recursive:true});
  const worker=service('apps/browser-worker/src/index.ts',{WORKER_PORT:String(wp),REPROPATH_ARTIFACT_DIR:dir,REPROPATH_AUTH_FILE:''});
  const control=service('apps/control/src/index.ts',{CONTROL_PORT:String(cp),WORKER_URL:`ws://127.0.0.1:${wp}/worker`,WEB_ORIGIN:web,REPROPATH_ARTIFACT_DIR:dir});
  const vite=service('tests/web-server.ts',{WEB_PORT:String(vp),CONTROL_URL:base});
  t.after(async()=>{await vite.stop();await control.stop();await worker.stop();});await ready(base,true);await until(async()=>{try{return(await fetch(web)).ok;}catch{return false;}},'vite');
  const session=await create(base,base+'/test-page/control');const stream=await subscribe(base,session.id);t.after(()=>stream.socket.close());
  const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1500,height:1100}});await page.goto(web+'/session/'+session.id);
  await page.getByTestId('view-status').filter({hasText:'LIVE'}).waitFor();await page.getByRole('button',{name:'接管浏览器',exact:true}).click();await page.getByTestId('control-mode').filter({hasText:'HUMAN CONTROL'}).waitFor();
  const click=async(x:number,y:number)=>{const canvas=page.getByTestId('browser-canvas');await canvas.scrollIntoViewIfNeeded();const rect=await canvas.boundingBox();assert.ok(rect);await page.mouse.click(rect.x+x/1440*rect.width,rect.y+y/900*rect.height);};
  await click(200,140);
  await until(()=>stream.messages.some(m=>m.type==='action-update'&&m.action.status==='completed'),'action live transport');
  const get=async()=>ActionRecordSchema.array().parse(await fetch(base+`/sessions/${session.id}/actions`).then(r=>r.json()));
  const first=(await get())[0]!;assert.equal(first.kind,'click');assert.equal(first.evidenceStatus,'complete');
  await page.getByRole('button',{name:/human · CLICK/}).click();await page.getByAltText('Before evidence').waitFor();await page.getByAltText('After evidence').waitFor();
  await until(async()=>page.getByText(/HTTP 200.*action=1/).count().then(n=>n>0),'network in Actions');
  await page.getByRole('button',{name:'查看 Sanitized DOM · Before'}).click();await page.locator('.evidence-dom').filter({hasText:'BEFORE'}).waitFor();
  const jpeg=await fetch(base+'/artifacts/'+first.before!.screenshot!.id);const bytes=Buffer.from(await jpeg.arrayBuffer());assert.equal(jpeg.headers.get('content-type'),'image/jpeg');assert.equal(createHash('sha256').update(bytes).digest('hex'),first.before!.screenshot!.sha256);
  const dom=await fetch(base+'/artifacts/'+first.before!.dom!.id);assert.equal(dom.headers.get('content-type'),'text/plain; charset=utf-8');assert.equal(dom.headers.get('cache-control'),'no-store');assert.equal(dom.headers.get('x-content-type-options'),'nosniff');assert.equal((await dom.text()).includes('REPROPATH_SECRET_SENTINEL'),false);
  const stray=await new LocalArtifactStore(dir).put('dom',Buffer.from('not referenced'));
  for(const path of ['/artifacts/../../secret','/artifacts/%2e%2e%2fsecret','/artifacts/%252e%252e%252fsecret','/artifacts/C:%5csecret','/artifacts/'+randomUUID(),'/artifacts/'+stray.id,`/sessions/${session.id}/actions/${randomUUID()}`,`/sessions/${randomUUID()}/actions`])assert.equal((await fetch(base+path)).status,404,path);
  await click(220,260);await page.keyboard.insertText('hello测试');await until(async()=> (await get()).some(a=>a.kind==='type'&&a.status==='completed'),'type complete');
  const typed=(await get()).find(a=>a.kind==='type')!;assert.deepEqual(typed.detail,{kind:'type',characterCount:7});assert.equal((await fetch(base+'/artifacts/'+typed.after!.dom!.id).then(r=>r.text())).includes('hello测试'),false);
  await page.reload();await page.getByTestId('control-mode').filter({hasText:'VIEW ONLY'}).waitFor();await page.getByRole('button',{name:/human · TYPE/}).waitFor();
  assert.equal(JSON.stringify(await get()).includes('hello测试'),false);assert.equal((worker.logs()+control.logs()+vite.logs()).includes('hello测试'),false);
  await page.getByRole('button',{name:'关闭 Session',exact:true}).click();await page.getByTestId('status').filter({hasText:'closed'}).waitFor();
  await page.getByRole('button',{name:/human · TYPE/}).click();await page.getByAltText('After evidence').waitFor();assert.equal((await fetch(base+'/artifacts/'+typed.after!.screenshot!.id)).status,200);
  assert.equal((await fetch(base+`/sessions/${session.id}/actions/${first.id}`)).status,200);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await writeFile(resolve(dir,first.before!.dom!.id),'tampered');assert.equal((await fetch(base+'/artifacts/'+first.before!.dom!.id)).status,404);
});

test('ArtifactStore immutable IDs, atomic failure, traversal rejection and persistent quota',async()=>{
  const dir=resolve('test-results',`store-${randomUUID()}`);const store=new LocalArtifactStore(dir,8);
  const ref=await store.put('dom',Buffer.from('1234'));const next=await store.put('dom',Buffer.from('abcd'));assert.notEqual(ref.id,next.id);
  await assert.rejects(new LocalArtifactStore(dir,8).put('dom',Buffer.from('x')));assert.equal((await store.read(ref.id)).toString(),'1234');assert.equal((await readdir(dir)).some(n=>n.endsWith('.tmp')),false);
  for(const id of ['../secret','/secret','%2e%2e','C:\\secret'])await assert.rejects(store.read(id));
});

test('Action metadata ring evicts old references and interrupts on Worker loss',()=>{
  const store=new ActionStore();const sample:ActionRecord={id:randomUUID(),sessionId:'S',pageId:'P',actor:'human',kind:'type',status:'recording',startedAt:new Date().toISOString(),detail:{kind:'type',characterCount:1},eventSequenceStart:1,networkRequestIds:[],evidenceStatus:'pending'};
  store.update(sample);for(let i=0;i<500;i++)store.update({...sample,id:randomUUID()});assert.equal(store.list('S').length,500);assert.equal(store.get('S',sample.id),undefined);
  assert.equal(store.interrupt('S',12).length,500);assert.ok(store.list('S').every(a=>a.status==='interrupted'));store.forget('S');assert.equal(store.list('S').length,0);
});
