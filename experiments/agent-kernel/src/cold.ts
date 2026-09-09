import { loadAdapter, type KernelName } from './common/adapters.js';
const adapter = await loadAdapter(process.argv[2] as KernelName);
if (typeof adapter.run !== 'function') throw Error('adapter unavailable');
console.log('ready');
