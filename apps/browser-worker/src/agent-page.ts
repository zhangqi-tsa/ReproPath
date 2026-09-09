import { randomUUID } from 'node:crypto';
import type { ElementHandle, Page } from 'playwright';
import { safeUrl, type PageObservation, type AgentOperation, type ToolResult } from '@repropath/agent-protocol';
import type { ActionRecord } from '@repropath/protocol';
import type { ActionRecorder } from './action-recorder.js';
export class AgentPage {
  private refs=new Map<string,ElementHandle>();private observationId?:string;private epoch?:string;private generation=0;private waits=new Set<()=>void>();
  constructor(private page:()=>Page|undefined,private pageId:()=>string|null,private recorder:ActionRecorder,private delayBeforeMutation=0){}
  private blockedNavigation=false;
  async guardNavigations(page:Page,allowedUrl:string){
    const origin=new URL(allowedUrl).origin;
    const cdp=await page.context().newCDPSession(page);
    const {frameTree}=await cdp.send('Page.getFrameTree');
    const onRequest=(event:{frameId:string;requestId:string;request:{url:string}})=>{void (async()=>{
      if(this.epoch&&event.frameId===frameTree.frame.id&&new URL(event.request.url).origin!==origin){
        this.blockedNavigation=true;
        // 204 cancels the document replacement without committing an error page.
        await cdp.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:204});
      }else await cdp.send('Fetch.continueRequest',{requestId:event.requestId});
    })().catch(()=>{});};
    cdp.on('Fetch.requestPaused',onRequest);
    page.once('close',()=>cdp.removeListener('Fetch.requestPaused',onRequest));
    // CDP pauses every redirect hop; Playwright route() only sees the first URL.
    await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*',resourceType:'Document',requestStage:'Request'}]});
  }
  setEpoch(epoch:string|null){this.epoch=epoch??undefined;this.blockedNavigation=false;this.invalidate();for(const cancel of this.waits)cancel();this.waits.clear();this.recorder.interrupt();}
  invalidate(){this.generation++;this.observationId=undefined;for(const ref of this.refs.values())void ref.dispose().catch(()=>{});this.refs.clear();}
  private delay(ms:number){return new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);this.waits.delete(done);resolve();};const timer=setTimeout(done,ms);this.waits.add(done);});}
  async observe(sessionId:string):Promise<PageObservation>{
    this.invalidate();const generation=this.generation;const page=this.page();if(!page)throw Error('STALE_OBSERVATION');
    const selected=await page.evaluateHandle(()=>Array.from(document.querySelectorAll('button,a[href],input,textarea,select,[role],[contenteditable="true"],[tabindex]')).slice(0,2000).filter(e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&!e.closest('[hidden],[aria-hidden="true"]');}).slice(0,200));
    try {
    const extract=(nodes:Element[])=>{
      let remaining=19000,truncated=false;
      const clip=(text:string,max:number)=>{const value=text.replace(/\s+/g,' ').trim();const n=Math.min(max,remaining);if(value.length>n)truncated=true;const out=value.slice(0,n);remaining-=out.length;return out;};
      const content=(element:Element)=>{const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let text='',node:Node|null;let seen=0;while((node=walker.nextNode())&&seen++<1000&&text.length<1000){if(!node.parentElement?.closest('input,textarea,select,[contenteditable],script,style,noscript'))text+=' '+node.textContent;}return text;};
      const elements=nodes.map((e,i)=>{
        const tagName=e.tagName.toLowerCase();const type=e.getAttribute('type');const editable=e.matches('input,textarea,[contenteditable="true"]');
        const labelled=(e.getAttribute('aria-labelledby')??'').split(/\s+/).slice(0,10).map(id=>document.getElementById(id)).filter((n):n is HTMLElement=>!!n).map(content).join(' ');
        const label='labels'in e?Array.from((e as HTMLInputElement).labels??[]).slice(0,5).map(content).join(' '):'';
        const text=editable?'':content(e);
        return {ref:`E${i+1}`,tagName,role:(e.getAttribute('role')??(tagName==='button'?'button':tagName==='a'?'link':tagName==='select'?'combobox':type==='checkbox'?'checkbox':editable?'textbox':'generic')).slice(0,100),name:clip(e.getAttribute('aria-label')||labelled||label||text||e.getAttribute('placeholder')||'',200),text:clip(text,300),editable,disabled:e.matches(':disabled,[aria-disabled="true"]'),...('checked'in e?{checked:Boolean((e as HTMLInputElement).checked)}:{}),...(e.hasAttribute('aria-expanded')?{expanded:e.getAttribute('aria-expanded')==='true'}:{})};
      });
      const visible=(e:Element)=>{const r=e.getBoundingClientRect();return !!(r.width&&r.height)&&getComputedStyle(e).visibility!=='hidden'&&!e.closest('[hidden],[aria-hidden="true"]');};
      const hs=Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')).filter(visible);const headings=hs.slice(0,50).map(e=>clip(content(e),300));
      const snippets:string[]=[];const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node:Node|null,scan=0;
      while((node=walker.nextNode())&&scan++<5000){const parent=node.parentElement;if(!parent||parent.closest('input,textarea,select,[contenteditable],script,style,noscript')||!visible(parent))continue;const text=(node.textContent??'').trim();if(!text)continue;if(snippets.length>=100||remaining<=0){truncated=true;break;}snippets.push(clip(text,300));}
      return {elements,headings,textSnippets:snippets,title:clip(document.title,300),truncated:truncated||nodes.length>=200||hs.length>50||scan>=5000};
    };
    // Only trusted, repository-owned extractor code is serialized; no model/page code enters here.
    const evaluator=new Function('nodes',`const __name = value => value; return (${extract.toString()})(nodes);`) as (nodes:Element[])=>ReturnType<typeof extract>;
    const data=await selected.evaluate(evaluator);
    const props=await selected.getProperties();
    if(generation!==this.generation){for(const h of props.values())await h.dispose();throw Error('STALE_OBSERVATION');}
    for(const [key,h]of props){const element=h.asElement();if(element)this.refs.set(`E${Number(key)+1}`,element);else await h.dispose();}
    this.observationId=randomUUID();return {id:this.observationId,sessionId,pageId:this.pageId()!,createdAt:new Date().toISOString(),url:safeUrl(page.url()),findings:[],...data};
    } finally { await selected.dispose().catch(()=>{}); }
  }
  async execute(command:AgentOperation):Promise<ToolResult>{
    const page=this.page();const valid=()=>this.epoch===command.epoch&&this.pageId()===command.pageId&&!!page&&!page.isClosed();
    if(!valid()||!page)return {ok:false,code:'CONTROL_NOT_OWNED'};
    if(this.blockedNavigation){this.blockedNavigation=false;return {ok:false,code:'POLICY_BLOCKED'};}
    const call=command.call;
    try{
      if(call.name==='observe_page'){const observation=await this.observe(command.sessionId);return valid()?{ok:true,observation}:{ok:false,code:'CONTROL_NOT_OWNED'};}
      if(call.name==='wait'){await this.delay(call.args.ms);return valid()?{ok:true,summary:'wait completed'}:{ok:false,code:'CONTROL_NOT_OWNED'};}
      if(call.name==='finish')return {ok:false,code:'UNKNOWN_TOOL'};
      const generation=this.generation;
      let element:ElementHandle|undefined;
      if('observationId'in call.args){if(call.args.observationId!==this.observationId)return {ok:false,code:'STALE_OBSERVATION'};element=this.refs.get(call.args.elementRef);if(!element||!await element.evaluate(e=>e.isConnected))return {ok:false,code:'STALE_ELEMENT'};}
      if(this.delayBeforeMutation)await this.delay(this.delayBeforeMutation);
      if(!valid())return {ok:false,code:'CONTROL_NOT_OWNED'};
      if(element&&generation!==this.generation)return {ok:false,code:'STALE_OBSERVATION'};
      // Resolve actionability without scheduling a late auto-waiting mutation.
      if(element)await element.waitForElementState('visible',{timeout:3000});
      if(!valid())return {ok:false,code:'CONTROL_NOT_OWNED'};
      const box=element?await element.boundingBox():undefined;
      if(element&&(!box||!await element.evaluate(e=>e.isConnected)))return {ok:false,code:'STALE_ELEMENT'};
      const point=box?{x:box.x+box.width/2,y:box.y+box.height/2}:undefined;
      // A trial Playwright click can scroll. Use read-only hit testing instead.
      const hit=async()=>!!element&&!!point&&await element.evaluate((e,p)=>{const target=document.elementFromPoint(p.x,p.y);return !!target&&(e===target||e.contains(target));},point);
      if(call.name==='click'&&!await hit())return {ok:false,code:'STALE_ELEMENT'};
      const detail:ActionRecord['detail']=call.name==='click'?{kind:'click',button:'left',x:point!.x,y:point!.y}:call.name==='type_text'?{kind:'type',characterCount:call.args.text.length}:call.name==='press_key'?{kind:'key',key:call.args.key,modifiers:call.args.modifiers}:call.name==='scroll'?{kind:'scroll',totalDeltaX:call.args.deltaX,totalDeltaY:call.args.deltaY,eventCount:1}:{kind:'navigation',url:call.name==='navigate'?safeUrl(call.args.url):'back'};
      const actionId=await this.recorder.execute(command.pageId,'agent',detail,valid,async()=>{
        if(!valid())return;
        if(element&&(!await element.evaluate(e=>e.isConnected)||generation!==this.generation))throw Error('STALE_ELEMENT');
        if(!valid())return;
        if(call.name==='click'){await page.mouse.move(point!.x,point!.y);if(valid()&&await hit()&&valid())await page.mouse.click(point!.x,point!.y);else throw Error('STALE_ELEMENT');}
        else if(call.name==='type_text'){if(!await element!.evaluate(e=>e instanceof Element&&e.matches('input,textarea,[contenteditable="true"]')))throw Error('NOT_EDITABLE');await element!.focus();if(valid())await page.keyboard.insertText(call.args.text);}
        else if(call.name==='press_key'){const keys=call.args.modifiers;const key=call.args.key.startsWith('Key')?call.args.key.slice(3):call.args.key.startsWith('Digit')?call.args.key.slice(5):call.args.key==='Space'?' ':call.args.key;await page.keyboard.press([...keys,key].join('+'));}
        else if(call.name==='scroll')await page.mouse.wheel(call.args.deltaX,call.args.deltaY);
        else if(call.name==='navigate')await page.goto(call.args.url,{waitUntil:'domcontentloaded',timeout:15000});
        else await page.goBack({waitUntil:'domcontentloaded',timeout:15000});
      },point,element);
      this.invalidate();if(this.blockedNavigation){this.blockedNavigation=false;return {ok:false,code:'POLICY_BLOCKED',actionId};}return valid()?{ok:true,actionId,summary:`${call.name} completed`}:{ok:false,code:'CONTROL_NOT_OWNED'};
    }catch{const blocked=this.blockedNavigation;this.blockedNavigation=false;return {ok:false,code:valid()?(blocked?'POLICY_BLOCKED':'TOOL_EXECUTION_ERROR'):'CONTROL_NOT_OWNED'};}
  }
}
