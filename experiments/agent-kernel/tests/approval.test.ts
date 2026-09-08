import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolLoopAgent, tool } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { ObserveInput } from '../src/common/gateway.js';
import { FakeModel } from '../src/common/fake-model.js';
test('AI SDK native approval pauses execution',async()=>{
  const fake=new FakeModel(); const model=await fake.start();let executed=0;
  try{const provider=createOpenAICompatible({name:'bakeoff',baseURL:model.baseURL,apiKey:model.apiKey});
    const agent=new ToolLoopAgent({model:provider.chatModel(model.model),tools:{observe_page:tool({inputSchema:ObserveInput,needsApproval:true,execute:async()=>{executed++;return {};}})}});
    const r=await agent.generate({prompt:'observe'});assert.equal(executed,0);assert.match(JSON.stringify(r.content),/tool-approval-request/);
  }finally{await fake.close();}
});
