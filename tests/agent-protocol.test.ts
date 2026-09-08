import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ToolCallSchema,RunSchema,safeArgs,safeUrl,dangerousTarget } from '@repropath/agent-protocol';
test('Agent protocol rejects invalid capabilities and redacts persisted arguments',()=>{
  for(const input of [
    {name:'delete_database',args:{}},{name:'click',args:{observationId:'obs',elementRef:null}},
    {name:'scroll',args:{deltaX:Infinity,deltaY:0}},{name:'scroll',args:{deltaX:0,deltaY:5001}},
    {name:'navigate',args:{url:'javascript:alert(1)'}},{name:'navigate',args:{url:'https://user:password@example.com/'}},
    {name:'type_text',args:{observationId:'obs',elementRef:'E1',text:'a'.repeat(4097)}},
    {name:'press_key',args:{key:'UnrestrictedJS',modifiers:[]}},{name:'wait',args:{ms:5001}},
  ])assert.equal(ToolCallSchema.safeParse(input).success,false);
  const call=ToolCallSchema.parse({name:'type_text',args:{observationId:'obs',elementRef:'E1',text:'不存储原文'}});assert.deepEqual(safeArgs(call),{observationId:'obs',elementRef:'E1',characterCount:5});
  assert.equal(safeUrl('https://user:secret@example.com/path?token=secret#secret'),'https://example.com/path');
  for(const name of ['删除账户','删除账号','delete account','支付','付款','pay','purchase','转账','transfer','修改密码','change password'])assert.equal(dangerousTarget(name),true,name);
  assert.equal(dangerousTarget('Login'),false);assert.equal(RunSchema.shape.goal.safeParse(' ').success,false);assert.equal(RunSchema.shape.goal.safeParse('a'.repeat(4001)).success,false);
});
test('Agent dependency boundary excludes browser and experimental SDK packages',async()=>{
  assert.doesNotMatch(JSON.parse(await readFile('package.json','utf8')).scripts.dev,/--kill-others/);
  const host=JSON.parse(await readFile('apps/agent-host/package.json','utf8'));assert.equal(host.dependencies.ai,'7.0.93');assert.equal(host.dependencies['@ai-sdk/openai-compatible'],'3.0.44');
  assert.doesNotMatch(JSON.stringify(host.dependencies),/playwright|mastra|pi-agent|mcp/);
  const protocol=await readFile('packages/agent-protocol/src/index.ts','utf8');assert.doesNotMatch(protocol,/from ['"](?:ai|@ai-sdk|.*experiments)/);
  for(const path of ['apps/control/package.json','apps/browser-worker/package.json','apps/web/package.json'])assert.doesNotMatch(await readFile(path,'utf8'),/"ai"|@ai-sdk|mastra|pi-agent/);
});
