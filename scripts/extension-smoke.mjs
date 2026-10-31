import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
const profile = await mkdtemp(join(tmpdir(), 'web-trans-smoke-'));
const proc = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new','--disable-gpu','--no-first-run','--enable-unsafe-extension-debugging','--remote-debugging-port=0','--remote-allow-origins=*','--user-data-dir='+profile,'about:blank'], { windowsHide:true, stdio:['ignore','ignore','pipe'] });
let socket, page, article, worker;
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><head><title>Extension integration fixture</title></head><body><article><h1>English heading</h1><p id="paragraph">Actual extension integration test.</p></article></body></html>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
function connect(url) { return new Promise((resolve,reject)=>{ const ws=new WebSocket(url);ws.addEventListener('open',()=>{let i=0;const pending=new Map();ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p.reject(new Error(JSON.stringify(m.error)));else p.resolve(m.result);}});resolve({ws,call:(method,params={})=>new Promise((resolve,reject)=>{const id=++i;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));})});});ws.addEventListener('error',reject);}); }
try {
 const url=await new Promise((resolve,reject)=>{let out='';const timeout=setTimeout(()=>reject(new Error('startup timeout')),15000);proc.stderr.on('data',b=>{out+=b;const m=out.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timeout);resolve(m[1]);}});});
 socket=await connect(url);
 const loaded=await socket.call('Extensions.loadUnpacked',{path:fileURLToPath(new URL('../extension/', import.meta.url))});console.log('Loaded extension',loaded);
 const target=await socket.call('Target.createTarget',{url:`chrome-extension://${loaded.id}/options.html`});
 const port=new URL(url).port;let targetList;for(let i=0;i<30;i++){targetList=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targetList.some(t=>t.id===target.targetId))break;await new Promise(r=>setTimeout(r,100));}
 page=await connect(targetList.find(t=>t.id===target.targetId).webSocketDebuggerUrl);
 async function evaluate(expression){const r=await page.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
 await new Promise(r=>setTimeout(r,800));
 console.log('Actual settings page:',await evaluate(`({title:document.title,hint:document.querySelector('#keyHint')?.textContent,status:document.querySelector('#status')?.textContent})`));
 const background = await evaluate(`chrome.runtime.sendMessage({type:'GET_CONFIG'})`);
 console.log('Actual background:',background); if (!background.ok) throw new Error('Real extension background rejected its own settings page');
 const png=await page.call('Page.captureScreenshot',{format:'png'});await writeFile(new URL('../settings-preview.png', import.meta.url),Buffer.from(png.data,'base64'));
 const fixtureURL=`http://127.0.0.1:${server.address().port}/`;
 const articleTarget=await socket.call('Target.createTarget',{url:fixtureURL});
 await new Promise(r=>setTimeout(r,400));
 const infos=await socket.call('Target.getTargets',{filter:[{type:'tab',exclude:false}]});
 const tabTarget=infos.targetInfos.find(t=>t.url===fixtureURL);console.log('Tab action target:',tabTarget);
 await socket.call('Extensions.triggerAction',{id:loaded.id,targetId:tabTarget?.targetId || articleTarget.targetId});
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 worker=await connect(targets.find(t=>t.type==='service_worker' && t.url.includes(loaded.id)).webSocketDebuggerUrl);
 await worker.call('Runtime.evaluate',{expression:`chrome.permissions.contains=async()=>true;globalThis.fetch=async(url,options)=>{const segments=JSON.parse(JSON.parse(options.body).messages[1].content).segments;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({translations:segments.map(s=>({id:s.id,text:'中文测试译文'}))})}}],usage:{total_tokens:15}}),{status:200});}`});
 const saved=await evaluate(`chrome.runtime.sendMessage({type:'SAVE_CONFIG',config:{endpoint:'https://mock.example.test/v1/chat/completions',model:'mock'},key:'mock-key-not-real'})`);
 if(!saved.ok)throw new Error(JSON.stringify(saved));
 const tabId=await evaluate(`chrome.tabs.query({}).then(tabs=>tabs.find(t=>t.url===${JSON.stringify(fixtureURL)})?.id)`);
 if(!tabId)throw new Error('activeTab grant unavailable');
 const started=await evaluate(`chrome.runtime.sendMessage({type:'START',tabId:${tabId},scope:'article'})`);if(!started.ok)throw new Error(JSON.stringify(started));
 article=await connect(targets.find(t=>t.id===articleTarget.targetId).webSocketDebuggerUrl);
 let translated=false;for(let i=0;i<60;i++){const r=await article.call('Runtime.evaluate',{expression:`document.querySelector('#paragraph [data-bilingual-reader]')?.shadowRoot.textContent.includes('中文测试译文')`,returnByValue:true});if(r.result.value){translated=true;break;}await new Promise(r=>setTimeout(r,100));}
 if(!translated)throw new Error('Actual extension failed to translate DOM');
 console.log('PASS: real manifest, settings, worker, activeTab grant, script injection, messaging and bilingual DOM (mock model only).');
 await socket.call('Browser.close');
}finally{article?.ws.close();worker?.ws.close();page?.ws.close();socket?.ws.close();proc.kill();await new Promise(r=>server.close(r));}
