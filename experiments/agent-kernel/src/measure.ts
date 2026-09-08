import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { names } from './common/adapters.js';
interface Entry { from?:string;version:string;path:string;dependencies?:Record<string,Entry>;optionalDependencies?:Record<string,Entry> }
const pnpm=process.env.npm_execpath;
if(!pnpm)throw Error('Run with pnpm agent:bakeoff:measure');
const output=execFileSync(process.execPath,[pnpm,'list','--depth','Infinity','--json'],{encoding:'utf8',maxBuffer:100*1024*1024});
const root=JSON.parse(output)[0] as {dependencies:Record<string,Entry>;devDependencies:Record<string,Entry>};
const roots:Record<string,string[]>={ 'ai-sdk':['ai','@ai-sdk/openai-compatible','@ai-sdk/mcp','zod'],pi:['@earendil-works/pi-agent-core','@earendil-works/pi-ai','@modelcontextprotocol/sdk','zod'],mastra:['@mastra/core','@mastra/mcp','@ai-sdk/openai-compatible','zod'],'pi-coding-optional':['@earendil-works/pi-coding-agent'] };
const allRoots={...root.dependencies,...root.devDependencies};
function collect(entries:Record<string,Entry>, found=new Set<string>()):Set<string>{for(const [name,e]of Object.entries(entries)){found.add(`${e.from??name}@${e.version}`);collect(e.dependencies??{},found);collect(e.optionalDependencies??{},found);}return found;}
const candidates:Record<string,unknown>={};for(const [name,selected]of Object.entries(roots)){const graph=collect(Object.fromEntries(selected.map(n=>[n,allRoots[n]!] )));candidates[name]={direct:selected.length,transitive:graph.size-selected.length,total:graph.size,packages:[...graph].sort()};}
const licenses=[];for(const [name,e]of Object.entries(allRoots)){const metadata=JSON.parse(await readFile(join(e.path,'package.json'),'utf8'));licenses.push({name,version:e.version,license:metadata.license,repository:metadata.repository});}
const loc:Record<string,unknown>={};for(const name of names){const lines=(await readFile(`src/${name}/index.ts`,'utf8')).trimEnd().split(/\r?\n/);loc[name]={physical:lines.length,nonBlankNonComment:lines.filter(s=>s.trim()&&!s.trim().startsWith('//')).length};}
await mkdir('results',{recursive:true});
await writeFile('results/dependencies.json',JSON.stringify({command:'pnpm list --depth Infinity --json',method:'Unique name@version in pnpm-reported closure, including reported peer/optional entries (not physical disk count); excludes root dev tools from candidate closures; transitive excludes chosen direct roots.',experimentDirect:Object.keys(root.dependencies).length,experimentDevDirect:Object.keys(root.devDependencies).length,experimentProductionTotal:collect(root.dependencies).size,experimentAllTotal:collect(allRoots).size,candidates,licenses,adapterLOC:loc},null,2));
console.log(JSON.stringify({candidates,loc},(key,value)=>key==='packages'?undefined:value,2));
