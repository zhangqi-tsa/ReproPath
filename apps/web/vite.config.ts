import { defineConfig } from 'vite';
const control = process.env.CONTROL_URL ?? 'http://127.0.0.1:4310';
export default defineConfig({ server: { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 5173), strictPort: true, proxy: {
  '/sessions': control, '/events': { target: control, ws: true }, '/health': control,
} } });
