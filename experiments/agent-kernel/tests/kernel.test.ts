import { test } from 'node:test';
import assert from 'node:assert/strict';
import { names, loadAdapter } from '../src/common/adapters.js';
import { FakeModel, normalPlan, type Reply } from '../src/common/fake-model.js';
import { MockGateway } from '../src/common/gateway.js';
import { LocalMCP } from '../src/common/mcp.js';
const call = (name: string, args: unknown = {}): Reply => ({ calls: [{ name, args }] });
for (const name of names) {
  test(`${name}: acceptance`, async t => {
    const adapter = await loadAdapter(name); const fake = new FakeModel(); const model = await fake.start();
    const run = (plan: Reply[] = normalPlan, gateway = new MockGateway(), extra = {}) => { fake.reset(plan); return adapter.run({ model, gateway, ...extra }); };
    try {
      await t.test('normal / observation / events', async () => {
        const gateway = new MockGateway(); const r = await run(normalPlan, gateway);
        assert.equal(r.reason, 'completed'); assert.deepEqual(gateway.calls, ['observe_page','click','observe_page','finish']);
        assert.match(JSON.stringify(fake.requests), /HTTP_5XX/); assert.equal(r.events.filter(e => e.type === 'tool-result').length, 4);
        assert.equal(r.events[0]?.type, 'run-start'); assert.equal(r.events.at(-1)?.type, 'run-finish');
      });
      await t.test('stream message', async () => { const r = await run([{ text: '流式结果' }]); assert.ok(r.events.some(e => e.type === 'message' && e.text.includes('流式结果'))); });
      await t.test('invalid schema', async () => { const g = new MockGateway(); const r = await run([call('click', { observationId: 123, elementRef: null })], g); assert.equal(g.calls.length, 0); assert.equal(r.error, 'TOOL_VALIDATION_ERROR'); });
      await t.test('unknown tool', async () => { const g = new MockGateway(); const r = await run([call('delete_database')], g); assert.equal(g.calls.length, 0); assert.equal(r.error, 'UNKNOWN_TOOL'); });
      await t.test('one tool per turn', async () => { const g = new MockGateway(); const r = await run([{ calls: [{name:'observe_page',args:{}},{name:'observe_page',args:{}}] }], g); assert.ok(g.calls.length <= 1); assert.equal(r.error, 'ONE_TOOL_PER_STEP'); });
      await t.test('parallel click click finish blocked',async()=>{ const g=new MockGateway();const click={name:'click',args:{observationId:'obs-1',elementRef:'E3'}};const r=await run([normalPlan[0]!,{calls:[click,click,{name:'finish',args:{summary:'bad'}}]}],g);assert.equal(r.error,'ONE_TOOL_PER_STEP');assert.ok(g.clickCount<=1);assert.equal(g.finishCount,0);assert.equal(g.calls.filter(c=>c==='click').length,1); });
      await t.test('stale recovery', async () => { const g = new MockGateway(); const r = await run([normalPlan[0]!,normalPlan[1]!,normalPlan[1]!,normalPlan[2]!,normalPlan[3]!],g); assert.equal(r.reason,'completed'); assert.equal(g.clickCount,1); assert.match(JSON.stringify(fake.requests[3]),/STALE_OBSERVATION/); });
      await t.test('budget 10', async () => { const r = await run(Array.from({length:30},()=>call('observe_page'))); assert.equal(r.reason,'budget_exhausted'); assert.equal(r.steps,10); assert.equal(fake.requests.length,10); });
      await t.test('20 steps bounded context', async () => { const r = await run(Array.from({length:25},()=>call('observe_page')),new MockGateway(),{maxSteps:20,recentTurns:2}); assert.equal(r.steps,20); assert.ok(Math.max(...r.contextSizes)<=6); assert.ok(fake.requests.at(-1)!.messages.length<=7); assert.doesNotMatch(JSON.stringify(fake.requests.at(-1)), /obs-1"/); });
      await t.test('model protocol error', async () => { const r=await run([{protocolError:true}]); assert.equal(r.error,'MODEL_PROTOCOL_ERROR'); });
      await t.test('tool execution error', async () => { const r=await run(normalPlan,new MockGateway({throwOnClick:true})); assert.equal(r.error,'TOOL_EXECUTION_ERROR'); });
      await t.test('timeout 500ms', async () => { const start=performance.now(); const r=await run([{delayMs:2000,text:'late'}],new MockGateway(),{timeoutMs:500}); assert.equal(r.error,'RUN_TIMEOUT'); assert.ok(performance.now()-start<1000); });
      await t.test('plain abort',async()=>{const c=new AbortController();const timer=setTimeout(()=>c.abort(),30);const start=performance.now();const g=new MockGateway();const r=await run([{delayMs:2000,text:'late'}],g,{signal:c.signal});clearTimeout(timer);assert.equal(r.reason,'aborted');assert.ok(performance.now()-start<1000);assert.equal(g.calls.length,0);assert.ok(r.events.some(e=>e.type==='run-error'&&e.code==='ABORTED'));});
      for (const during of ['model','tool'] as const) await t.test(`takeover ${during} / resume`,async()=>{
        const g=new MockGateway({clickDelayMs:300}); const controller=new AbortController(); let abortedAt=0;
        const r=await run(during==='model'?[{delayMs:2000,text:'late'}]:normalPlan,g,{signal:controller.signal,onEvent:(e:{type:string;tool?:string})=>{ if ((during==='model'&&e.type==='model-start')||(during==='tool'&&e.type==='tool-call'&&e.tool==='click')) setTimeout(()=>{abortedAt=performance.now();controller.abort('human_takeover');},20); }});
        assert.equal(r.reason,'paused_by_human'); assert.ok(performance.now()-abortedAt<1000); await new Promise(r=>setTimeout(r,350)); assert.equal(g.clickCount,0);
        assert.equal((await g.click({observationId:'obs-1',elementRef:'E3'})).code,'STALE_OBSERVATION');
        const fresh=g.observeCount+1; const resumed=await run([call('observe_page'),call('click',{observationId:`obs-${fresh}`,elementRef:'E3'}),call('observe_page'),normalPlan[3]!],g); assert.equal(resumed.reason,'completed'); assert.equal(g.clickCount,1);
      });
      for(const fail of [false,true]) await t.test(`MCP allowlist echo error=${fail}`,async()=>{
        const mcp=new LocalMCP(fail); const url=await mcp.start(); try { const r=await run([call('echo',{text:'hello'}),{text:'done'}],new MockGateway(),{mcpURL:url}); assert.equal(mcp.echoCount,1); assert.equal(mcp.dangerousCount,0); assert.deepEqual(fake.requests[0]!.tools!.map(t=>t.function.name),['echo']); assert.equal(r.error,fail?'MCP_ERROR':undefined); }finally{await mcp.close();}
      });
      await t.test('MCP hallucinated dangerous tool rejected',async()=>{const mcp=new LocalMCP();const url=await mcp.start();try{const r=await run([call('dangerous_delete')],new MockGateway(),{mcpURL:url});assert.equal(r.error,'UNKNOWN_TOOL');assert.equal(mcp.dangerousCount,0);}finally{await mcp.close();}});
    } finally { await fake.close(); }
  });
}
