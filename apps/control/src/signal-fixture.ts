import type { IncomingMessage, ServerResponse } from 'node:http';

export function handleSignalFixture(path: string, request: IncomingMessage, response: ServerResponse): boolean {
  if (!path.startsWith('/fixture/signal/')) return false;
  if (path.endsWith('/failed') || path.endsWith('/document-failed')) { request.socket.destroy(); return true; }
  const reply = () => {
    response.writeHead(path.endsWith('/500') || path.endsWith('/slow-500') ? 500 : path.endsWith('/404') ? 404 : 200, { 'Content-Type': 'application/json' });
    response.end('{"fixture":true}');
  };
  if (path.endsWith('/slow-500') || path.endsWith('/pending')) {
    const timer = setTimeout(reply, path.endsWith('/pending') ? 15_000 : 3500);
    response.on('close', () => clearTimeout(timer));
  } else reply();
  return true;
}
export function signalFixture(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Signal Fixture</title>
  <link rel="icon" href="data:,"><style>body{font:20px system-ui;margin:32px;background:#f4f7f9;color:#172e37}h1{font-size:28px} .grid{position:absolute;top:160px;left:32px;display:grid;grid-template-columns:repeat(3,300px);gap:18px}button{height:65px;font:18px system-ui;border:1px solid #9ab7b1;border-radius:8px;background:white;cursor:pointer}#result{position:absolute;top:590px;left:32px;right:32px;padding:20px;background:#dceee7}</style></head><body>
  <h1>Signal & Finding · 本地验收</h1><p>每次按钮操作产生真实浏览器事件，Finding 由人工判断。</p>
  <div class="grid">
  <button id="http500">HTTP 500</button><button id="failed">Request Failed</button><button id="pageerror">Page Error</button>
  <button id="console">Console Error</button><button id="duplicate">Duplicate POST ×3</button><button id="single">Single POST</button>
  <button id="http404">HTTP 404</button><button id="get">GET ×3</button><button id="warning">Console Warning</button>
  <button id="slow">Slow HTTP 500</button><button id="document">Document Failed</button><button id="combined">HTTP 500 + Console Error</button>
  <button id="pending">Pending Request</button><button id="privacy">Safe URL Privacy</button>
  </div><p id="result">等待操作</p><script>
  const req=(path,method='GET')=>fetch('/fixture/signal/'+path,{method}).catch(()=>{});
  const bind=(id,fn)=>document.getElementById(id).onclick=()=>{document.getElementById('result').textContent='最近操作：'+id;fn();};
  bind('http500',()=>req('500'));bind('failed',()=>req('failed'));
  bind('pageerror',()=>{throw new Error('Signal fixture page error');});
  bind('console',()=>console.error('Signal fixture console error'));
  bind('duplicate',()=>{for(let i=0;i<3;i++)req('mutate','POST');});bind('single',()=>req('mutate','POST'));
  bind('http404',()=>req('404'));bind('get',()=>{for(let i=0;i<3;i++)req('ok');});bind('warning',()=>console.warn('Signal fixture warning'));
  bind('slow',()=>req('slow-500'));bind('document',()=>{location.href='/fixture/signal/document-failed';});
  bind('combined',()=>{req('500');console.error('Signal fixture combined error');});
  bind('pending',()=>req('pending'));bind('privacy',()=>req('500?token=SUPER_SECRET&id=123'));
  if(new URL(location.href).searchParams.has('global'))console.error('Signal fixture global error');
  </script></body></html>`;
}
