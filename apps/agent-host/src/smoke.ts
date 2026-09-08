import assert from 'node:assert/strict';
import { ToolLoopAgent,tool,stepCountIs } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { toolSchemas } from '@repropath/agent-protocol';
import { modelConfig } from './kernel.js';
console.error=()=>process.stderr.write('MODEL_PROTOCOL_ERROR\n');console.warn=()=>{};
const config=modelConfig();
if(!config)console.log('SKIP: configure REPROPATH_AGENT_BASE_URL / REPROPATH_AGENT_API_KEY / REPROPATH_AGENT_MODEL');
else{
  try{
    const provider=createOpenAICompatible({name:'repropath',baseURL:config.baseURL,apiKey:config.apiKey});let executed=false,sawTool=false;
    const agent=new ToolLoopAgent({model:provider.chatModel(config.model),maxRetries:0,stopWhen:stepCountIs(1),tools:{finish:tool({inputSchema:toolSchemas.finish,execute:async({summary})=>{assert.ok(summary.includes('你好'));executed=true;return {ok:true};}})}});
    const stream=await agent.stream({prompt:'This is a smoke test. Call finish once with summary exactly 你好 ReproPath.',abortSignal:AbortSignal.timeout(60000)});
    for await(const part of stream.fullStream){if(part.type==='tool-call')sawTool=true;if(part.type==='error')throw Error('MODEL_PROTOCOL_ERROR');}
    assert.ok(sawTool&&executed);console.log('PASS: real streaming tool call + Unicode');
    const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),50);const started=Date.now();
    try{const second=await agent.stream({prompt:'Call finish with 你好 ReproPath.',abortSignal:abort.signal});for await(const _part of second.fullStream){if(abort.signal.aborted)break;}}catch{assert.ok(abort.signal.aborted);}finally{clearTimeout(timer);}
    assert.ok(Date.now()-started<1000);console.log('PASS: real provider path AbortSignal bounded');
    assert.equal(toolSchemas.type_text.safeParse({observationId:123,elementRef:null,text:'invalid'}).success,false);
    console.log('PASS: local malformed tool schema rejected (adversarial SDK model-call handling covered by pnpm test)');
  }catch{console.log('FAIL: AGENT_SMOKE_ERROR');process.exitCode=1;}
}
