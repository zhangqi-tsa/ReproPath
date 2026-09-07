export function fixturePage(next: boolean): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>ReproPath Fixture${next ? ' — Next' : ''}</title>
<style>body{font:18px system-ui;max-width:760px;margin:60px auto;padding:24px;background:#f5f7fa;color:#172a38}button,a{display:inline-block;margin:8px;padding:12px}code{color:#315d88}</style>
<h1>ReproPath 本地测试页面${next ? ' · Next' : ''}</h1>
<p>页面加载后自动执行 console.log、API 请求和未捕获异常。可在 Timeline 中观察真实浏览器事件。</p>
<button id="request">Request API</button><button id="log">Console Log</button><button id="error">Throw Error</button>
<a id="navigate" href="/test-page${next ? '' : '/next'}">Navigate</a><p id="result">等待 API</p>
<script>
const request = () => fetch('/fixture/api/user').then(r => r.json()).then(value => {
  document.querySelector('#result').textContent = JSON.stringify(value);
  console.log('fixture API complete');
}).catch(console.error);
const log = () => console.log('hello from ReproPath fixture');
const fail = () => { throw new Error('ReproPath fixture intentional error'); };
document.querySelector('#request').onclick = request;
document.querySelector('#log').onclick = log;
document.querySelector('#error').onclick = fail;
log(); setTimeout(request, 150); setTimeout(fail, 300);
if (new URLSearchParams(location.search).has('navigate')) setTimeout(() => location.href = '/test-page/next', 700);
</script></html>`;
}
