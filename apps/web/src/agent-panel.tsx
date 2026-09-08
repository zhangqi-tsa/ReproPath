import { useState } from 'react';
import type { AgentRun,AgentStep } from '@repropath/agent-protocol';
export function AgentPanel({sessionId,running,humanOwned,runs}:{sessionId:string;running:boolean;humanOwned:boolean;runs:{run:AgentRun;steps:AgentStep[]}[]}){
  const [goal,setGoal]=useState('检查登录按钮提交后是否出现异常。');const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const current=runs.at(-1);const active=runs.find(v=>['starting','running','paused_by_human'].includes(v.run.status));
  async function request(operation?:'stop'|'resume'){
    setBusy(true);setError('');try{const url=`/sessions/${sessionId}/agent-runs${operation&&current?`/${current.run.id}/${operation}`:''}`;const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:operation?undefined:JSON.stringify({goal})});const value=await response.json() as {error?:string};if(!response.ok)setError(value.error??'Agent 请求失败');}catch{setError('Agent 连接不可用');}finally{setBusy(false);}
  }
  return <section className="agent-panel" aria-label="AI Agent"><h2>AI Agent</h2>
    <p className="hint">启动 Agent 会把当前页面的有限语义观察、测试目标和近期 Finding 摘要发送给已配置的模型服务。不会主动发送 Cookie、Storage、完整 DOM、Evidence Screenshot 或请求/响应正文；页面可见文本仍可能包含业务敏感信息。请勿在目标中粘贴密码或 Token。</p>
    <label htmlFor="agent-goal">测试目标</label><textarea id="agent-goal" maxLength={4000} value={goal} onChange={e=>setGoal(e.target.value)} />
    <div className="agent-buttons"><button disabled={busy||!running||humanOwned||!!active||!goal.trim()} onClick={()=>void request()}>Start Agent</button>
      {active&&<button disabled={busy} onClick={()=>void request('stop')}>停止 Agent</button>}
      {current?.run.status==='paused_by_human'&&<button disabled={busy||humanOwned||!running} onClick={()=>void request('resume')}>继续 Agent</button>}</div>
    {current&&<><p data-testid="agent-status">{current.run.status}</p><p>步骤 {current.run.stepCount} / {current.run.limits.maxSteps} · {current.run.finishReason??''}</p>
      {current.run.status==='paused_by_human'&&<p>Agent 已被人工接管暂停；释放人工控制后，点击继续 Agent。</p>}
      {current.run.summary&&<p>{current.run.summary}</p>}{current.run.errorCode&&<p role="alert">{current.run.errorCode}</p>}
      <ol>{current.steps.map(s=><li key={s.id}>{s.index} · {s.tool?.name??'观察 / 模型等待'} · {s.status} {s.errorCode??''}{s.actionId&&<small> · Action {s.actionId}</small>}</li>)}</ol></>}
    {error&&<p role="alert">{error}</p>}
    {runs.length>1&&<details><summary>此前 Agent Runs（{runs.length-1}）</summary>{runs.slice(0,-1).map(v=><p key={v.run.id}>{v.run.goal} · {v.run.status} · {v.run.summary}</p>)}</details>}
  </section>;
}
