import { createServer } from 'vite';
const server = await createServer({ root: 'apps/web', configFile: 'apps/web/vite.config.ts' });
await server.listen();
process.on('message', message => { if (message === 'shutdown') void server.close().then(() => process.disconnect?.()); });
