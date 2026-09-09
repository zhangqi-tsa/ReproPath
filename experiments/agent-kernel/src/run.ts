import { names, loadAdapter } from './common/adapters.js';
import { MockGateway } from './common/gateway.js';
import { FakeModel } from './common/fake-model.js';
const fake = new FakeModel(); const model = await fake.start();
try {
  for (const name of names) {
    fake.reset(); const gateway = new MockGateway();
    const result = await (await loadAdapter(name)).run({ model, gateway });
    console.log(JSON.stringify({ kernel: name, ...result, calls: gateway.calls }));
  }
} finally { await fake.close(); }
