import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { DefaultResourceLoader, loadSkillsFromDir, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
test('Pi SDK trusted inline extension / resource loader / in-memory session', async()=>{
  const cwd=resolve('tests/fixtures'); let loaded=0;
  const loader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager:SettingsManager.inMemory(),noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
    extensionFactories:[api=>{loaded++;api.registerCommand('fixture',{description:'Trusted inert fixture',handler:async()=>{}});} ],
    skillsOverride:()=>loadSkillsFromDir({dir:resolve(cwd,'skills'),source:'bakeoff-fixture'}),
  });
  await loader.reload(); assert.equal(loaded,1);assert.equal(loader.getExtensions().errors.length,0);assert.equal(loader.getExtensions().extensions.length,1);
  assert.equal(loader.getSkills().skills[0]?.name,'fixture');assert.deepEqual(loader.getAgentsFiles().agentsFiles,[]);
  const session=SessionManager.inMemory(cwd);assert.equal(session.getSessionFile(),undefined);assert.equal(session.getEntries().length,0);
});
