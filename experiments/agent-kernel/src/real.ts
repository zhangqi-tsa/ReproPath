import { names, loadAdapter } from './common/adapters.js';
import { MockGateway } from './common/gateway.js';
const { AGENT_BASE_URL: baseURL, AGENT_API_KEY: apiKey, AGENT_MODEL: model } = process.env;
if (!baseURL || !apiKey || !model) console.log('SKIP: AGENT_BASE_URL / AGENT_API_KEY / AGENT_MODEL are required');
else for (const name of names) {
  const gateway = new MockGateway();
  const result = await (await loadAdapter(name)).run({ model: { baseURL, apiKey, model }, gateway });
  const passed = result.reason === 'completed' && gateway.clickCount > 0 && gateway.observeCount >= 2 && gateway.finishCount === 1;
  console.log(JSON.stringify({ name, passed, reason: result.reason, error: result.error, steps: result.steps }));
  if (!passed) process.exitCode = 1;
}
