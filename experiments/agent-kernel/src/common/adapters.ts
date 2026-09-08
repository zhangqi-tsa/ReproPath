import type { KernelAdapter } from './types.js';
export const names = ['ai-sdk', 'pi', 'mastra'] as const;
export type KernelName = typeof names[number];
export async function loadAdapter(name: KernelName): Promise<KernelAdapter> { return (await import(`../${name}/index.js`)).adapter as KernelAdapter; }
