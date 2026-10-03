import {VoiceTranscript} from '../public/voice-transcript.js';
import {transcriptKeys} from '../public/chat-transcript.js';
import {VoiceHealth} from '../public/voice-health.js';
import {beginCallAudioSession,configureMicrophoneEcho} from '../public/webrtc-voice.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8')
  .replace(/^import[^\n]*\n/gm,'')
  .replace(/  \(async\(\)=>\{try\{await bootstrap\(\);render\(\);\}catch\(error\).*\n/,'')
  .replace(/\}\)\(\);\s*$/,'globalThis.audit={state,loadBook,render,dialog,act,startVoice,stopVoice,updateLiveTranscript,setVoiceFailure(active,message){voice=active;lastVoiceError=message;}};})();');
function harness(overrides={}){
  const listeners={},nodes=new Map(),pending=[];
  const make=()=>({focus(){},click(){},replaceWith(){},querySelector(){return null;},append(){},textContent:'',value:'',innerHTML:'',hidden:false,dataset:{},classList:{remove(){},add(){},toggle(){}},setAttribute(){},querySelectorAll(){return []}});
  const input=make(),app=make();input.id='chat-input';
  Object.defineProperty(app,'innerHTML',{get(){return this.html||'';},set(value){this.html=value;input.value='';}});
  nodes.set('#app',app);
  const document={createElement(){const el=make();nodes.set('file-input',el);return el;},querySelector(selector){if(selector==='#chat-input')return app.innerHTML.includes('id="chat-input"')?input:null;if(!nodes.has(selector))nodes.set(selector,make());return nodes.get(selector);},querySelectorAll(){return [];},addEventListener(type,fn){listeners[type]=fn;}};
  // This harness checks application state. Real DOM identity, animation and
  // scrolling are exercised separately by scripts/chat-motion-qa.mjs.
  class ChatTranscriptView {constructor({target,rows,renderRow}){Object.assign(this,{target,renderRow});this.update(rows);}update(rows){this.target.innerHTML=rows.map(this.renderRow).join('');}dispose(){}follow(){}pause(){}capturePosition(){return {};}restorePosition(){}}
  const context={navigator:{},VoiceTranscript,transcriptKeys,ChatTranscriptView,VoiceHealth,configureMicrophoneEcho,beginCallAudioSession,document,window:{scrollTo(){}},WebSocket:{OPEN:1,CONNECTING:0,CLOSED:3},FormData:class {},localStorage:{setItem(){},getItem(){return null;}},setInterval(){},clearInterval(){},setTimeout(){},clearTimeout(){},fetch(url,options){return new Promise(resolve=>pending.push({url,options,resolve}));}};
  Object.assign(context,overrides);vm.runInNewContext(source,context);
  const result={audit:context.audit,listeners,nodes,pending,input,app,make};
  result.click=dataset=>listeners.click({target:{closest(){return {tagName:'BUTTON',dataset};}}});
  result.type=value=>{input.value=value;listeners.input({target:input});};
  result.submit=()=>listeners.submit({target:{id:'chat-form'},preventDefault(){}});
  result.chat=(bookId='a',sessionId='s1')=>{Object.assign(context.audit.state,{book:{id:bookId,title:bookId},sessions:[{id:sessionId,startedAt:Date.now(),turns:[]}],sessionId,view:'chat',settings:{mode:'mock'}});context.audit.render();};
  return result;
}
const response=(body,status=200)=>({ok:status<400,status,headers:{get(){return 'application/json';}},async json(){return body;}});
const book=id=>({book:{id,title:id},sessions:[{id:'s1',turns:[]}],claims:[],chapters:[]});
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('personal settings combine style and voice with automatic persistence',async()=>{
  class PersonalFormData {constructor(form){this.values=form.values;}get(key){return this.values[key]??null;}has(key){return Object.hasOwn(this.values,key);}}
  const h=harness({FormData:PersonalFormData});
  Object.assign(h.audit.state,{view:'user-settings',voiceModels:{test:{voices:['one']}},settings:{mode:'qwen',qwenVoiceModel:'test',qwenVoices:{test:'one'},qwenSpeechRate:'slow',manuscriptStyle:'plain'}});
  h.audit.render();assert.match(h.app.innerHTML,/个人设置/);assert.match(h.app.innerHTML,/聊天音色/);assert.match(h.app.innerHTML,/生成书稿的风格/);assert.match(h.app.innerHTML,/value="plain" selected/);
  const form={id:'user-preferences-form',values:{manuscriptStyle:'conversational',voice:'one',speechRate:'normal'},querySelectorAll(){return [];},querySelector(){return null;}};
  const saving=h.listeners.submit({target:form,preventDefault(){}});
  assert.equal(h.pending[0].url,'/api/user-preferences');
  assert.deepEqual(JSON.parse(h.pending[0].options.body),{manuscriptStyle:'conversational',model:'test',voice:'one',speechRate:'normal'});
  h.pending[0].resolve(response({manuscriptStyle:'conversational',qwenVoices:{test:'one'},qwenSpeechRate:'normal'}));await saving;
  assert.equal(h.audit.state.settings.manuscriptStyle,'conversational');
  Object.assign(h.audit.state.settings,{mode:'mock'});h.audit.render();assert.match(h.app.innerHTML,/生成书稿的风格/);
  form.values={manuscriptStyle:'plain'};
  h.listeners.change({target:{tagName:'SELECT',closest(){return form;}}});
  assert.deepEqual(JSON.parse(h.pending[1].options.body),{manuscriptStyle:'plain'});
  h.pending[1].resolve(response({manuscriptStyle:'plain'}));await flush();assert.equal(h.audit.state.settings.manuscriptStyle,'plain');
});

test('legacy ended stories remain editable with one exit control',()=>{
  const h=harness();h.chat();h.audit.state.sessions[0].endedAt='2026-09-30T00:00:00Z';h.audit.render();
  assert.match(h.app.innerHTML,/data-action="voice-toggle"/);assert.match(h.app.innerHTML,/id="chat-form"/);
  assert.equal((h.app.innerHTML.match(/data-action="exit-chat"/g)||[]).length,1);
  assert.doesNotMatch(h.app.innerHTML,/已结束|停止本次聊天|返回总览/);
});
test('exit saves draft and re-entry selects the same story without ending or creating one',async()=>{
  const h=harness();h.chat();h.audit.state.sessions[0].endedAt='2026-09-30T00:00:00Z';h.type('未发送的下一句话');
  await h.click({action:'exit-chat'});assert.equal(h.audit.state.view,'book');assert.equal(h.pending.length,0);
  await h.click({session:'s1'});assert.equal(h.audit.state.sessionId,'s1');assert.equal(h.input.value,'未发送的下一句话');
  await h.click({action:'exit-chat'});await h.click({action:'continue-story'});
  assert.equal(h.audit.state.sessionId,'s1');assert.equal(h.audit.state.sessions.length,1);assert.equal(h.pending.length,0);
});
test('exit waits for voice to save before returning to overview',async()=>{
  const h=harness();h.chat();h.audit.setVoiceFailure({socket:{readyState:3}},'');
  const exiting=h.click({action:'exit-chat'});await flush();
  assert.equal(h.audit.state.view,'chat');assert.equal(h.audit.state.exiting,true);
  h.pending[0].resolve(response({...book('a'),sessions:[{id:'s1',turns:[{id:'last',role:'user',text:'最后一句'}]}]}));await exiting;
  assert.equal(h.audit.state.view,'book');assert.equal(h.audit.state.sessions[0].turns[0].text,'最后一句');assert.equal(h.audit.state.exiting,false);
  assert.ok(h.pending.every(r=>!r.url.endsWith('/end')));
});
test('exit does not pull the user back after another navigation',async()=>{
  const h=harness();h.chat();h.audit.setVoiceFailure({socket:{readyState:3}},'');
  const exiting=h.click({action:'exit-chat'});await flush();await h.click({view:'home'});
  h.pending[0].resolve(response(book('a')));await exiting;assert.equal(h.audit.state.view,'home');
});
test('exit during a pending text reply preserves its saved result in the same story',async()=>{
  const h=harness();h.chat();h.type('已发送的故事');const sending=h.submit();
  await h.click({action:'exit-chat'});assert.equal(h.audit.state.view,'book');
  h.pending[0].resolve(response({}));await flush();h.pending[1].resolve(response({...book('a'),sessions:[{id:'s1',turns:[{id:'saved',role:'user',text:'已发送的故事'}]}]}));await sending;
  assert.equal(h.audit.state.view,'book');await h.click({session:'s1'});
  assert.match(h.app.innerHTML,/已发送的故事/);assert.equal(h.audit.state.sessions.length,1);
});

test('story overview shows concrete titles and refreshes legacy titles in the background',async()=>{
  const h=harness();h.chat();h.audit.state.view='book';
  Object.assign(h.audit.state.sessions[0],{focus:{theme:'成长经历'},storyTitle:'第一次离家上大学',storyPreview:'爸爸陪我坐了一夜火车。',storyTitlePending:false});h.audit.render();
  assert.match(h.app.innerHTML,/<h3>第一次离家上大学<\/h3>/);assert.doesNotMatch(h.app.innerHTML,/<h3>成长经历<\/h3>/);
  Object.assign(h.audit.state.sessions[0],{storyTitle:'聊天中的原话',storyTitlePending:true,storyFingerprint:'f1'});h.audit.render();
  assert.equal(h.pending[0].url,'/api/books/a/story-titles');
  h.pending[0].resolve(response({sessions:[{id:'s1',storyTitle:'爸爸送我去上大学',storyTitlePending:false,storyFingerprint:'f1'}]}));await flush();
  assert.match(h.app.innerHTML,/<h3>爸爸送我去上大学<\/h3>/);assert.equal(h.pending.length,1);
});
test('late title results cannot rename corrected sessions or replace chat messages',async()=>{
  const h=harness();h.chat();h.audit.state.view='book';
  Object.assign(h.audit.state.sessions[0],{storyTitle:'旧内容',storyTitlePending:true,storyFingerprint:'old'});h.audit.render();
  Object.assign(h.audit.state.sessions[0],{storyTitle:'纠正后的内容',storyTitlePending:false,storyFingerprint:'new',turns:[{id:'latest',role:'user',text:'新原话'}]});
  h.pending[0].resolve(response({sessions:[{id:'s1',storyTitle:'旧标题',storyTitlePending:false,storyFingerprint:'old'}]}));await flush();
  assert.equal(h.audit.state.sessions[0].storyTitle,'纠正后的内容');assert.equal(h.audit.state.sessions[0].turns[0].text,'新原话');
});

test('voice failure remains visible after cleanup and chat refresh',async()=>{
  const h=harness();h.chat();Object.assign(h.audit.state,{webrtcAvailable:true,settings:{mode:'qwen',qwenConnection:'unified',qwenVoiceModel:'qwen-audio-3.0-realtime-flash'}});
  h.audit.setVoiceFailure({socket:{readyState:3}},'连接语音服务超时，请重试或检查当前网络。');
  const stopping=h.audit.stopVoice();await flush();
  h.pending[0].resolve(response(book('a')));await stopping;
  assert.match(h.app.innerHTML,/连接语音服务超时，请重试或检查当前网络。/);
  h.audit.render();assert.match(h.app.innerHTML,/连接语音服务超时，请重试或检查当前网络。/);
});

test('latest book selection wins even when earlier click completes later',async()=>{
  const h=harness();const first=h.click({book:'a'}),second=h.click({book:'b'});
  h.pending[1].resolve(response(book('b')));await second;
  h.audit.state.view='chapters';h.pending[0].resolve(response(book('a')));await first;
  assert.equal(h.audit.state.book.id,'b');assert.equal(h.audit.state.view,'chapters');
});
test('navigation to settings cancels pending book navigation',async()=>{
  const h=harness();const first=h.click({book:'a'});await h.click({view:'settings'});
  h.pending[0].resolve(response(book('a')));await first;
  assert.equal(h.audit.state.view,'settings');assert.equal(h.audit.state.book,null);
});
test('drafts survive refreshes and remain attached to their session',()=>{
  const h=harness();h.chat();h.type('尚未发送');h.audit.render();assert.equal(h.input.value,'尚未发送');
  h.chat('a','s2');assert.equal(h.input.value,'');h.type('第二段草稿');h.chat();assert.equal(h.input.value,'尚未发送');
});
test('successful send preserves next draft entered while awaiting the reply',async()=>{
  const h=harness();h.chat();h.type('本次发送');const sending=h.submit();h.type('下一句话');
  h.pending[0].resolve(response({}));await flush();h.pending[1].resolve(response(book('a')));await sending;
  assert.equal(h.input.value,'下一句话');assert.equal(JSON.parse(h.pending[0].options.body).text,'本次发送');
});
test('failed send restores sent text without discarding newer input',async()=>{
  const h=harness();h.chat();h.type('本次发送');const sending=h.submit();h.type('下一句话');
  h.pending[0].resolve(response({error:'失败'},500));await sending;
  assert.equal(h.input.value,'本次发送\n下一句话');
});
test('refresh failure after successful send does not duplicate the submitted draft',async()=>{
  const h=harness();h.chat();h.type('本次发送');const sending=h.submit();h.type('下一句话');
  h.pending[0].resolve(response({}));await flush();h.pending[1].resolve(response({error:'刷新失败'},500));await sending;
  assert.equal(h.input.value,'下一句话');
});
test('partial manuscript preview dispatches to the progress endpoint',async()=>{
  const h=harness();const click=h.click({action:'preview-manuscript',bookId:'a'});
  assert.equal(h.pending[0].url,'/api/books/a/manuscript/progress');h.pending[0].resolve(response({chapters:[]}));await click;
  assert.equal(h.audit.state.view,'home');
});
test('dialog errors become visible',async()=>{
  const h=harness(),root=h.make(),error=h.make(),confirm=h.make();error.hidden=true;
  root.querySelector=selector=>selector==='[data-dialog-confirm]'?confirm:selector==='.dialog-error'?error:h.make();h.nodes.set('#dialog-root',root);
  h.audit.dialog({title:'新书',body:'',onConfirm:async()=>{throw new Error('保存失败');}});await confirm.onclick();
  assert.equal(error.textContent,'保存失败');assert.equal(error.hidden,false);
});
test('render captures final DOM draft under the previously rendered session',()=>{
  const h=harness();h.chat();h.input.value='尚未触发 input 的输入法文字';
  h.chat('b','s2');assert.equal(h.input.value,'');
  h.chat('a','s1');assert.equal(h.input.value,'尚未触发 input 的输入法文字');
});
test('background refresh cannot supersede pending user book selection',async()=>{
  const h=harness();h.chat();const navigating=h.click({book:'b'});
  await h.audit.loadBook('a',{background:true});assert.equal(h.pending.length,1);
  h.pending[0].resolve(response(book('b')));await navigating;assert.equal(h.audit.state.book.id,'b');
});
test('creating a session cannot pull user back after navigation',async()=>{
  const h=harness();h.chat();h.audit.state.sessions=[];
  const starting=h.click({action:'start-chat'});assert.equal(h.pending[0].url,'/api/books/a/sessions');
  await h.click({view:'home'});h.pending[0].resolve(response({id:'new-session'}));await starting;
  assert.equal(h.audit.state.view,'home');assert.equal(h.audit.state.sessionId,'s1');assert.equal(h.pending.length,1);
});
test('backup upload sends raw JSON without base64 expansion',async()=>{
  const h=harness();await h.audit.act('restore',{});const input=h.nodes.get('file-input');
  const backup={format:'lifebook',book:{title:'测试'},checksum:'test'};
  input.files=[{size:100,text:async()=>JSON.stringify(backup)}];const restoring=input.onchange();await flush();
  assert.equal(h.pending[0].url,'/api/restore');assert.deepEqual(JSON.parse(h.pending[0].options.body),backup);
  h.pending[0].resolve(response({error:'测试结束'},400));await restoring;
});
test('oversize backup is rejected before reading file contents',async()=>{
  const h=harness();await h.audit.act('restore',{});const input=h.nodes.get('file-input');let read=false;
  input.files=[{size:100*1024*1024+1,text:async()=>{read=true;return '{}';}}];await input.onchange();
  assert.equal(read,false);assert.equal(h.pending.length,0);assert.match(h.nodes.get('#toast').textContent,/100 MB/);
});

function deletionDialog(h){
 const root=h.make(),confirm=h.make();root.querySelector=selector=>selector==='[data-dialog-confirm]'?confirm:h.make();
 h.nodes.set('#dialog-root',root);return {root,confirm};
}
test('memory page exposes individual deletion and whole session management even without claims',()=>{
 const h=harness();h.chat();h.audit.state.view='memory';h.audit.state.claims=[{id:'c',text:'虚构回忆',sourceTurnId:'t'}];h.audit.render();
 assert.match(h.app.innerHTML,/data-action="delete-claim"/);assert.match(h.app.innerHTML,/data-action="delete-session"/);
 h.audit.state.claims=[];h.audit.render();assert.match(h.app.innerHTML,/data-action="delete-session"/);
});
test('deleting a memory requires confirmation and targets the original turn',async()=>{
 const h=harness();h.chat();h.audit.state.sessions[0].turns=[{id:'t',role:'user',text:'原话'}];h.audit.state.claims=[{id:'c',sourceTurnId:'t'}];
 const d=deletionDialog(h);await h.audit.act('delete-claim',{dataset:{claim:'c'}});
 assert.equal(h.pending.length,0);assert.match(d.root.innerHTML,/删除这条回忆及原话/);
 const deleting=d.confirm.onclick();assert.equal(h.pending[0].url,'/api/books/a/sessions/s1/turns/t');assert.equal(h.pending[0].options.method,'DELETE');
 h.pending[0].resolve(response({ok:true}));await flush();h.pending[1].resolve(response(book('a')));await deleting;
});
test('deleting a session confirms first and clears the deleted selection',async()=>{
 const h=harness();h.chat();const d=deletionDialog(h);await h.audit.act('delete-session',{dataset:{sessionId:'s1'}});
 assert.equal(h.pending.length,0);assert.match(d.root.innerHTML,/其他聊天会保留/);
 const deleting=d.confirm.onclick();assert.equal(h.pending[0].url,'/api/books/a/sessions/s1');assert.equal(h.pending[0].options.method,'DELETE');
 h.pending[0].resolve(response({ok:true}));await flush();h.pending[1].resolve(response({...book('a'),sessions:[]}));await deleting;
 assert.equal(h.audit.state.sessionId,null);assert.equal(h.audit.state.sessions.length,0);
});


test('voice diagnostics export is available after a fresh page and manual interruption is absent',async()=>{
  const h=harness();h.chat();assert.doesNotMatch(h.app.innerHTML,/voice-interrupt|interrupt-voice|打断，让我说|打断并说话|microphone-input|speaker-echo-guard/);
  assert.match(h.app.innerHTML,/导出诊断日志/);
  const result=h.audit.act('voice-health-download',{});
  assert.equal(h.pending[0].url,'/api/voice-diagnostics');
  h.pending[0].resolve({ok:true,headers:{get(){return 'text/plain';}},async text(){return '';}});
  await result;
});

test('streaming assistant text is visible without refreshing the book or replacing the composer',()=>{
  const h=harness();h.chat();h.type('下一段还未发送');
  const active={bookId:'a',sessionId:'s1',transcript:new VoiceTranscript()};h.audit.setVoiceFailure(active,'');
  h.audit.updateLiveTranscript(active,{type:'response.created',response:{id:'one'}});
  h.audit.updateLiveTranscript(active,{type:'response.audio_transcript.delta',response_id:'one',delta:'第一句<测试>'});
  assert.match(h.nodes.get('#live-transcript').innerHTML,/第一句&lt;测试&gt;/);
  assert.equal(h.pending.length,0);assert.equal(h.input.value,'下一段还未发送');assert.equal(h.audit.state.sessions[0].turns.length,0);
  h.audit.render();assert.match(h.app.innerHTML,/第一句&lt;测试&gt;/);
  h.audit.state.sessions[0].turns.push({id:'saved',role:'assistant',text:'第一句<测试>',providerResponseId:'one'});
  h.audit.render();assert.equal((h.app.innerHTML.match(/第一句&lt;测试&gt;/g)||[]).length,1);
});

test('late voice deltas cannot leak into a different book or session',()=>{
  const h=harness();h.chat();const active={bookId:'a',sessionId:'s1',transcript:new VoiceTranscript()};h.audit.setVoiceFailure(active,'');
  h.audit.updateLiveTranscript(active,{type:'response.created',response:{id:'one'}});
  h.chat('b','s2');const before=h.nodes.get('#live-transcript').innerHTML;
  h.audit.updateLiveTranscript(active,{type:'response.audio_transcript.delta',response_id:'one',delta:'私人故事'});
  assert.equal(h.nodes.get('#live-transcript').innerHTML,before);assert.ok(!h.app.innerHTML.includes('私人故事'));
});

test('stopping chat does not display the text model thinking placeholder',async()=>{
  const h=harness();h.chat();const stopping=h.click({action:'pause-voice'});
  h.audit.render();assert.doesNotMatch(h.app.innerHTML,/正在思考如何接着聊/);
  h.pending[0].resolve(response(book('a')));await stopping;
  assert.doesNotMatch(h.app.innerHTML,/正在思考如何接着聊/);
});

test('saving and paused voice chat keep one stable continuation control across both refreshes',async()=>{
  const h=harness();h.chat();Object.assign(h.audit.state,{webrtcAvailable:true,settings:{mode:'qwen',qwenConnection:'unified',qwenVoiceModel:'qwen-audio-3.0-realtime-flash'}});
  const saved={...book('a'),sessions:[{id:'s1',turns:[{id:'t1',role:'user',text:'小时候的一件事。'}]}]};
  h.audit.setVoiceFailure({socket:{readyState:3}},'');
  const stopping=h.click({action:'pause-voice'});await flush();
  const control=()=>h.app.innerHTML.match(/<button[^>]*data-action="voice-toggle"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.equal(h.audit.state.paused,true);assert.match(control(),/正在保存…/);assert.match(control(),/disabled/);
  assert.equal((h.app.innerHTML.match(/data-action="voice-toggle"/g)||[]).length,1);
  h.pending[0].resolve(response(saved));await flush();
  assert.equal(h.pending.length,2);assert.match(control(),/正在保存…/);assert.match(control(),/disabled/);
  h.pending[1].resolve(response(saved));await stopping;
  assert.match(control(),/继续语音聊天/);assert.doesNotMatch(control(),/disabled/);
  assert.doesNotMatch(h.app.innerHTML,/resume-chat|stopped-actions/);assert.match(h.app.innerHTML,/改用文字/);
  const before=control();h.audit.render();assert.equal(control(),before);
});

test('optional text can resume a paused chat and clear its stopped state',async()=>{
  const h=harness();h.chat();h.audit.state.paused=true;h.audit.render();h.type('接着刚才的回忆。');
  const sending=h.submit();assert.equal(h.audit.state.paused,false);
  assert.match(h.app.innerHTML,/随时可以接着聊/);assert.match(h.app.innerHTML,/正在思考如何接着聊/);
  h.pending[0].resolve(response({}));await flush();h.pending[1].resolve(response(book('a')));await sending;
  assert.equal(h.audit.state.paused,false);
});

test('text thinking placeholder belongs only to the session awaiting a text reply',async()=>{
  const h=harness();h.chat();h.type('这是一段回忆');const sending=h.submit();
  assert.match(h.app.innerHTML,/正在思考如何接着聊/);
  h.chat('b','s2');assert.doesNotMatch(h.app.innerHTML,/正在思考如何接着聊/);
  h.pending[0].resolve(response({}));await sending;
  h.chat();assert.doesNotMatch(h.app.innerHTML,/正在思考如何接着聊/);
});

function captureHarness({storage,ios=false,overrides={}}={}){
  const requests=[],session={type:'auto'};
  const navigator={userAgent:ios?'Mozilla/5.0 (iPhone) CriOS/154.0':'',audioSession:session,mediaDevices:{getSupportedConstraints:()=>({echoCancellation:true}),getUserMedia(constraints){
    assert.equal(session.type,ios?'auto':'play-and-record','platform-specific routing order before permission');
    return new Promise((resolve,reject)=>requests.push({resolve,reject,constraints}));
  }}};
  const h=harness({...(storage?{localStorage:storage}:{}),navigator,beginCallAudioSession,window:{WebSocket:{},RTCPeerConnection:{},scrollTo(){}},...overrides});
  h.chat();Object.assign(h.audit.state,{token:'test-token',view:'home',webrtcAvailable:true,settings:{mode:'qwen',qwenConnection:'unified',qwenVoiceModel:'qwen-audio-3.0-realtime-flash',qwenVoiceTransport:'webrtc'}});
  return {...h,requests,session};
}

test('iOS preconnection stays silent until default capture exists, then starts the same native player',async()=>{
  let h,playCount=0,track;
  const socket={readyState:1,sent:[],addEventListener(){},send(raw){this.sent.push(JSON.parse(raw));},close(){this.readyState=3;}};
  const rtc={activate(options){assert.equal(options.stream.getAudioTracks()[0],track);assert.equal(track.enabled,true);assert.equal(h.session.type,'play-and-record');this.stream=options.stream;playCount++;},muteInput(){track.enabled=false;},close(){track.stop();}};
  class Prepared {
    constructor(){this.ready=Promise.resolve();this.health={data:{}};}
    claim(){return true;}
    unlock(){playCount++;}
    take(){return {socket,rtc};}
    close(){this.closed=true;}
  }
  h=captureHarness({ios:true,overrides:{VoicePreparation:Prepared,location:{protocol:'https:',host:'example.test'},window:{WebSocket:class{},RTCPeerConnection:class{},scrollTo(){}}}});
  h.listeners.pointerdown();const starting=h.audit.startVoice();await flush();
  assert.equal(playCount,0,'permission is pending: no playback-only audio route');assert.equal(h.session.type,'auto');
  track={readyState:'live',enabled:true,label:'default',getSettings:()=>({echoCancellation:true,sampleRate:48000}),addEventListener(){},stop(){this.readyState='ended';}};
  const stream={getAudioTracks:()=>[track],getTracks:()=>[track]};h.requests[0].resolve(stream);await starting;
  assert.equal(playCount,1);assert.equal(track.enabled,true);assert.equal(h.requests.length,1);
  assert.deepEqual(socket.sent.map(e=>e.type),['start']);assert.equal(socket.sent[0].offer,undefined,'reuse preparation');
  socket.readyState=3;await h.audit.stopVoice();assert.equal(track.readyState,'ended');assert.equal(h.session.type,'auto');
});

test('cancelled iOS permission does not play or activate a late microphone',async()=>{
  const h=captureHarness({ios:true}),starting=h.audit.startVoice();await flush();await h.audit.stopVoice();
  let stopped=0;h.requests[0].resolve({getTracks:()=>[{stop(){assert.equal(h.session.type,'auto');stopped++;}}]});
  await starting;assert.equal(stopped,1);assert.equal(h.session.type,'auto');
});

test('opening protection never invites speech early and restores the normal conversation status on release',async()=>{
  let rtcOptions;const listeners={};
  const socket={readyState:1,sent:[],addEventListener(type,fn){(listeners[type]??=[]).push(fn);},send(raw){this.sent.push(JSON.parse(raw));},close(){this.readyState=3;}};
  const rtc={activate(options){rtcOptions=options;},async ready(){rtcOptions.onStartupProtection('waiting');return true;},muteInput(){},close(){}};
  class Prepared {constructor(){this.ready=Promise.resolve();this.health={data:{}};}claim(){return true;}take(){return {socket,rtc};}close(){this.closed=true;}}
  const h=captureHarness({ios:true,overrides:{VoicePreparation:Prepared,location:{protocol:'https:',host:'example.test'},window:{WebSocket:class{},RTCPeerConnection:class{},scrollTo(){}}}});
  h.listeners.pointerdown();const starting=h.audit.startVoice();await flush();
  const track={readyState:'live',enabled:true,getSettings:()=>({echoCancellation:true,sampleRate:48000}),addEventListener(){},stop(){this.readyState='ended';}};
  h.requests[0].resolve({getTracks:()=>[track],getAudioTracks:()=>[track]});await starting;
  const message=async data=>{for(const fn of listeners.message||[])await fn({data:JSON.stringify(data)});};
  await message({type:'ready',startupId:'one'});assert.equal(socket.sent.at(-1).type,'rtc_media_ready');
  for(const state of ['speaking','listening']){await message({type:'state',state});assert.match(h.nodes.get('#voice-status').textContent,/开场准备中/);assert.match(h.nodes.get('[data-action="voice-toggle"]').innerHTML,/正在准备/);}
  rtcOptions.onStartupProtection('settling');assert.doesNotMatch(h.nodes.get('#voice-status').textContent,/可以先开口/);
  rtcOptions.onStartupProtection('open');assert.match(h.nodes.get('#voice-status').textContent,/可以说话/);assert.match(h.nodes.get('[data-action="voice-toggle"]').innerHTML,/暂停语音/);assert.equal(socket.sent.at(-1).type,'voice_probe');
  await message({type:'state',state:'speaking'});assert.match(h.nodes.get('#voice-status').textContent,/可以先开口/);
  socket.readyState=3;await h.audit.stopVoice();
});

test('cancel while permission is pending stops late capture before restoring audio routing',async()=>{
  const h=captureHarness(),starting=h.audit.startVoice();await flush();assert.equal(h.requests.length,1);
  await h.audit.stopVoice();assert.equal(h.session.type,'play-and-record');
  let stopped=0;h.requests[0].resolve({getTracks:()=>[{stop(){assert.equal(h.session.type,'play-and-record');stopped++;}}]});
  await starting;assert.equal(stopped,1);assert.equal(h.session.type,'auto');
});

test('permission denial releases call routing and allows another start',async()=>{
  const h=captureHarness(),starting=h.audit.startVoice();await flush();h.requests[0].reject(Error('permission denied'));
  await assert.rejects(starting,/permission denied/);assert.equal(h.session.type,'auto');
  const retry=h.audit.startVoice();await flush();assert.equal(h.requests.length,2);await h.audit.stopVoice();
  h.requests[1].reject(Error('cancelled'));await retry;assert.equal(h.session.type,'auto');
});

test('late permission denial from a cancelled call cannot stop the new call',async()=>{
  const h=captureHarness(),first=h.audit.startVoice();await flush();await h.audit.stopVoice();
  const second=h.audit.startVoice();await flush();assert.equal(h.requests.length,2);
  h.requests[0].reject(Error('old request'));await first;assert.equal(h.session.type,'play-and-record');
  const duplicate=h.audit.startVoice();await duplicate;assert.equal(h.requests.length,2,'new call is still active');
  await h.audit.stopVoice();h.requests[1].reject(Error('cancelled'));await second;assert.equal(h.session.type,'auto');
});

test('cancelling during echo configuration never connects RTP capture',async()=>{
  const h=captureHarness(),starting=h.audit.startVoice();await flush();let finishConfiguration,stopped=0;
  const track={readyState:'live',label:'Test microphone',getCapabilities:()=>({echoCancellation:[true,'all']}),getSettings:()=>({echoCancellation:true}),
    applyConstraints:()=>new Promise(resolve=>{finishConfiguration=resolve;}),stop(){stopped++;this.readyState='ended';}};
  h.requests[0].resolve({getTracks:()=>[track],getAudioTracks:()=>[track]});await flush();
  assert.equal(typeof finishConfiguration,'function');
  await h.audit.stopVoice();finishConfiguration();await starting;
  assert.ok(stopped>=1);assert.equal(h.session.type,'auto');
});

test('RTP capture follows the default device in one request',async()=>{
  const h=captureHarness(),starting=h.audit.startVoice();await flush();
  const {audio,video}=h.requests[0].constraints;
  assert.equal(video,false);assert.equal(audio.echoCancellation,true);
  assert.equal(audio.deviceId,undefined);assert.equal(audio.advanced,undefined);
  assert.equal(h.requests.length,1);assert.equal(audio.noiseSuppression,true);assert.equal(audio.autoGainControl,true);
  await h.audit.stopVoice();h.requests[0].reject(Error('cancelled'));await starting;
});

// Stale preferences from the removed picker must never affect default capture.
test('saved microphone and speaker-mode preferences cannot change capture or settings UI',async()=>{
  const reads=[];const storage={getItem(key){reads.push(key);return key==='lifebook.microphone.v1'?'saved-phone-id':key==='lifebook.speakerEchoGuard.v1'?'true':null;},setItem(){}};
  const h=captureHarness({storage});Object.assign(h.audit.state,{view:'voice-settings',voiceModels:{}});h.audit.render();
  assert.doesNotMatch(h.app.innerHTML,/microphone-input|麦克风输入|speaker-echo|打断并说话/);
  const starting=h.audit.startVoice();await flush();
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].constraints.audio.deviceId,undefined);
  assert.equal(reads.includes('lifebook.microphone.v1'),false);assert.equal(reads.includes('lifebook.speakerEchoGuard.v1'),false);
  await h.audit.stopVoice();h.requests[0].reject(Error('cancelled'));await starting;
});
