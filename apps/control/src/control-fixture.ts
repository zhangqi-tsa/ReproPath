export function controlFixture(): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>ReproPath Human Control Fixture</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:2400px;font:20px system-ui;background:#f4f7fa;color:#193f3b}h1{position:absolute;left:80px;top:25px;font-size:28px}button,input{font:20px system-ui;border:1px solid #8aaca4;border-radius:8px;padding:10px}button{background:#17604f;color:white;cursor:pointer}#target{position:absolute;left:80px;top:110px;width:240px;height:60px}label{position:absolute;left:80px;font-size:15px}#first{position:absolute;left:80px;top:240px;width:340px;height:50px}#second{position:absolute;left:80px;top:330px;width:340px;height:50px}#slider{position:absolute;left:80px;top:420px;width:340px;height:40px}#submit{position:absolute;left:80px;top:510px;width:240px;height:60px}aside{position:absolute;left:550px;top:110px;width:650px;padding:30px;background:white;border-radius:12px;line-height:1.8}#sentinel{position:absolute;left:80px;top:1900px;width:800px;height:150px;background:#c4ebd8;padding:40px}</style>
<h1>Human Control · 本地交互测试</h1><p id="evidence-state" style="position:absolute;left:550px;top:60px">BEFORE</p><button id="target">Remote Click Target</button>
<form id="form"><label for="first" style="top:210px">文本输入（仅记录长度）</label><input id="first" autocomplete="off">
<label for="second" style="top:300px">第二个输入框（Tab 目标）</label><input id="second" autocomplete="off">
<input id="slider" type="range" min="0" max="100" value="20" aria-label="Remote Slider"><button id="submit">本地表单测试</button></form>
<aside><h2>接管后直接操作画面</h2><p>支持点击、右键、中键、拖动、中文输入与粘贴、Tab / Backspace / Enter、Ctrl+A 与滚轮。</p><p id="result">等待操作</p><p>向下滚动到绿色区域，验证远端滚动。</p></aside>
<div style="position:absolute;top:650px;left:80px"><input type="password" value="REPROPATH_SECRET_SENTINEL_password"><input type="hidden" value="REPROPATH_SECRET_SENTINEL_hidden"><textarea>REPROPATH_SECRET_SENTINEL_textarea</textarea><div contenteditable="true">REPROPATH_SECRET_SENTINEL_editable</div><span data-secret="REPROPATH_SECRET_SENTINEL_attribute">Privacy fixture</span></div>
<!-- REPROPATH_SECRET_SENTINEL_comment --><template><script>REPROPATH_SECRET_SENTINEL_template</script></template>
<div id="sentinel">已滚动到远端页面底部</div><script>
const privateSentinel = 'REPROPATH_SECRET_SENTINEL_script';
const result = message => { document.querySelector('#result').textContent = message; console.log(message); };
document.querySelector('#target').onclick = () => { document.querySelector('#evidence-state').textContent = 'AFTER'; result('remote-click-ok'); fetch('/fixture/api/user?human=1'); fetch('/fixture/api/user?action=1');
const mode = new URLSearchParams(location.search);
if (mode.has('slow')) fetch('/fixture/api/slow');
if (mode.has('late')) fetch('/fixture/api/late');
if (mode.has('busy')) { const timer = setInterval(() => fetch('/fixture/api/user?poll=1'), 100); setTimeout(() => clearInterval(timer), 4500); }
};
document.querySelector('#target').oncontextmenu = event => { event.preventDefault(); result('remote-right-ok'); };
document.querySelector('#target').onmousedown = event => { if (event.button === 1) event.preventDefault(); };
document.querySelector('#target').onauxclick = event => { if (event.button === 1) result('remote-middle-ok'); };
for (const id of ['first', 'second']) {
  const input = document.getElementById(id);
  input.addEventListener('input', () => result('input-length: ' + input.value.length));
  input.addEventListener('focus', () => result('focus: ' + id));
  input.addEventListener('keydown', event => {
    if (['Enter','Tab','Backspace','Delete','Escape','ArrowLeft','ArrowRight','Home','End'].includes(event.key)) result('special-key: ' + event.key);
    if (event.key === 'Enter') result('enter-length: ' + input.value.length);
  });
}
document.querySelector('#slider').oninput = event => result('slider-value: ' + event.target.value);
document.querySelector('#form').onsubmit = event => { event.preventDefault(); result('form-submit-length: ' + document.querySelector('#first').value.length); };
new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) result('remote-scroll-ok'); }).observe(document.querySelector('#sentinel'));
</script></html>`;
}
