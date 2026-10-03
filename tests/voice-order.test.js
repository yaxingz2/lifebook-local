import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import http from 'node:http';
import {TranscriptOrder} from '../src/transcript-order.js';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn) {
  const deadline=Date.now()+6000;
  while(Date.now()<deadline){if(await fn())return;await delay(20);}
  throw Error('voice audit condition timed out');
}
async function fixture(t,mode='qwen',qwenTurnDetection='semantic_vad'){
  const upstream=http.createServer((req,res)=>{req.resume();res.end('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n');});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const events=[];
  const emit=e=>client.send(JSON.stringify({type:'rtc_event',event:e}));
  const dir=await mkdtemp(join(tmpdir(),'lifebook-voice-order-'));
  const child=spawn(process.execPath,['src/server.js'],{cwd:join(import.meta.dirname,'..'),env:{...process.env,PORT:'0',LIFEBOOK_DATA_DIR:dir,NODE_ENV:'test',LIFEBOOK_WEBRTC_TEST_URL:`http://127.0.0.1:${upstream.address().port}`},stdio:['ignore','pipe','pipe']});
  let client;
  t.after(async()=>{
    client?.terminate();
    await new Promise(r=>upstream.close(r));
    const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;
    await rm(dir,{recursive:true,force:true});
  });
  const url=await new Promise((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>reject(Error('startup timeout')),10000);
    child.stdout.on('data',v=>{output+=v;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
    child.once('exit',()=>{clearTimeout(timer);reject(Error('server exited'));});
  });
  const boot=await(await fetch(url+'/api/bootstrap')).json();
  const api=async(path,method='GET',body)=>{
    const response=await fetch(url+path,{method,headers:{Origin:url,'X-LifeBook-Token':boot.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;
  };
  const book=await api('/api/books','POST',{title:'虚构语音回归测试'});
  // Make the opening in mock mode so no text or voice request can reach a paid service.
  const session=await api(`/api/books/${book.id}/sessions`,'POST',{});
  await api('/api/settings','PUT',{mode,region:'cn-beijing',workspaceId:'ws_test',apiKey:'fake-local-only',qwenTurnDetection});
  client=new WebSocket(url.replace('http:','ws:')+'/api/voice',['lifebook',boot.token],{origin:url});
  client.on('message',raw=>events.push(JSON.parse(raw)));
  await new Promise(r=>client.once('open',r));
  client.send(JSON.stringify({type:'start',bookId:book.id,sessionId:session.id,transport:'webrtc',offer:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'}));
  await until(()=>events.some(e=>e.type==='rtc_answer'));emit({type:'session.created'});
  await until(()=>events.some(e=>e.type==='rtc_command'&&e.event.type==='session.update'));emit({type:'session.updated'});
  await until(()=>events.some(e=>e.type==='ready'));
  client.send(JSON.stringify({type:'rtc_media_ready',startupId:events.find(e=>e.type==='ready').startupId}));
  return {emit,client,events,read:()=>api(`/api/books/${book.id}`),responses:()=>events.filter(e=>e.type==='rtc_command'&&e.event.type==='response.create').length,
    speech(id){emit({type:'input_audio_buffer.speech_started',item_id:id});emit({type:'input_audio_buffer.speech_stopped',item_id:id});},
    transcript(id,text){emit({type:'conversation.item.input_audio_transcription.completed',item_id:id,transcript:text});}};
}

test('completion ordering preserves long text, deduplicates, and ignores earlier connections',()=>{
  const order=new TranscriptOrder();order.observe('one');order.observe('two');
  const text='甲'.repeat(5000)+'末尾';
  assert.equal(order.complete('two','第二句。'),true);assert.equal(order.complete('one',text),true);
  assert.equal(order.complete('one','重复'),false);
  assert.equal(order.join(['two','one','one']).text,text+'第二句。');
  assert.equal(order.compare('one','old-connection'),0);
});

test('Qwen out-of-order transcriptions keep both conversation and claims in speech order',async t=>{
  const f=await fixture(t,'qwen');f.speech('one');f.speech('two');
  f.transcript('two','后来搬到北京。');
  await until(async()=> (await f.read()).claims.length===1);
  f.transcript('one','我出生在上海。');
  await until(async()=> (await f.read()).claims.length===2);
  const book=await f.read();
  assert.deepEqual(book.sessions[0].turns.filter(x=>x.role==='user').map(x=>x.text),['我出生在上海。','后来搬到北京。']);
  assert.deepEqual(book.claims.map(x=>x.text),['我出生在上海。','后来搬到北京。']);
});

test('stop keeps completed later speech and waits for a delayed earlier transcript',async t=>{
  const f=await fixture(t);f.speech('one');f.speech('two');f.transcript('two','第二句。');
  await until(async()=> (await f.read()).sessions[0].turns.some(x=>x.text==='第二句。'));
  f.client.send(JSON.stringify({type:'stop'}));
  await delay(2500);assert.ok(!f.events.some(e=>e.type==='stopped'));
  f.transcript('one','第一句。');
  await until(()=>f.events.some(e=>e.type==='stopped'));
  assert.deepEqual((await f.read()).sessions[0].turns.filter(x=>x.role==='user').map(x=>x.text),['第一句。','第二句。']);
  assert.equal(f.responses(),0);
});

test('Qwen late ASR is inserted before its assistant reply, including multiple turns and refresh',async t=>{
  const f=await fixture(t,'qwen');
  const answer=(id,text)=>{
    f.emit({type:'response.created',response:{id}});
    f.emit({type:'response.audio_transcript.delta',response_id:id,delta:text});
    f.emit({type:'response.audio_transcript.done',response_id:id,transcript:text});
    f.emit({type:'response.done',response:{id,status:'completed'}});
  };
  f.speech('u1');answer('a1','第一句回答');
  f.speech('u2');answer('a2','第二句回答');
  f.transcript('u2','第二句问题');f.transcript('u1','第一句问题');
  await until(async()=> (await f.read()).sessions[0].turns.filter(x=>x.viaVoice).length===4);
  const expected=['第一句问题','第一句回答','第二句问题','第二句回答'];
  assert.deepEqual((await f.read()).sessions[0].turns.filter(x=>x.viaVoice).map(x=>x.text),expected);
  // Read again as a fresh page load would. The order must be stored, not UI-only.
  assert.deepEqual((await f.read()).sessions[0].turns.filter(x=>x.viaVoice).map(x=>x.voiceOrder),[0,1,2,3]);
  assert.deepEqual((await f.read()).claims.map(x=>x.text),['第一句问题','第二句问题']);
});
test('Qwen interruption preserves preceding text and late cancelled events cannot erase the next reply',async t=>{
  const f=await fixture(t,'qwen');
  f.emit({type:'response.created',response:{id:'a1'}});
  f.emit({type:'response.audio_transcript.delta',response_id:'a1',delta:'已经显示的回答'});
  f.speech('u1');
  f.emit({type:'response.created',response:{id:'a2'}});
  f.emit({type:'response.audio_transcript.delta',response_id:'a2',delta:'新回答'});
  f.emit({type:'response.audio_transcript.done',response_id:'a1',transcript:'旧回答迟到的全文'});
  f.emit({type:'response.done',response:{id:'a1',status:'cancelled'}});
  f.emit({type:'response.audio_transcript.delta',response_id:'a2',delta:'继续'});
  f.emit({type:'response.done',response:{id:'a2',status:'completed'}});
  f.transcript('u1','等等，换个话题');
  await until(async()=> (await f.read()).sessions[0].turns.filter(x=>x.viaVoice).length===3);
  const saved=(await f.read()).sessions[0].turns.filter(x=>x.viaVoice);
  assert.deepEqual(saved.map(x=>x.text),['已经显示的回答','等等，换个话题','新回答继续']);
  assert.equal(saved[0].interrupted,true);
  assert.equal(f.events.filter(e=>e.type==='transcript'&&e.final&&e.turn?.providerResponseId==='a1').length,1);
});

for(const detection of ['server_vad','semantic_vad'])for(const order of ['cancel-first','speech-first'])
test(`Qwen interruption persists partial text and correction after refresh (${detection}, ${order})`,async t=>{
  const f=await fixture(t,'qwen',detection);
  f.emit({type:'response.created',response:{id:'partial'}});
  f.emit({type:'response.audio_transcript.delta',response_id:'partial',delta:'你妈妈当时教你做饭'});
  const cancelled={type:'response.done',response:{id:'partial',status:'cancelled'}};
  if(order==='cancel-first')f.emit(cancelled);
  f.speech('correction');
  if(order==='speech-first')f.emit(cancelled);
  f.emit({type:'response.created',response:{id:'corrected'}});
  f.emit({type:'response.audio_transcript.delta',response_id:'corrected',delta:'是外婆教你做饭，'});
  // Old text and duplicate cancellations must not alter the next answer.
  f.emit({type:'response.audio_transcript.delta',response_id:'partial',delta:'不应保存的旧内容'});
  f.emit({type:'response.audio_transcript.done',response_id:'partial',transcript:'不应保存的旧全文'});
  f.emit(cancelled);
  f.emit({type:'response.audio_transcript.delta',response_id:'corrected',delta:'我记下了。'});
  f.emit({type:'response.done',response:{id:'corrected',status:'completed'}});
  // User ASR may finish after the answer, including duplicate final metadata.
  f.transcript('correction','不是妈妈，是我外婆。');
  f.transcript('correction','不是妈妈，是我外婆。');
  await until(async()=>{const turns=(await f.read()).sessions[0].turns;return turns.some(t=>t.providerResponseId==='corrected')&&turns.some(t=>t.providerItemId==='correction');});
  const expected=['你妈妈当时教你做饭','不是妈妈，是我外婆。','是外婆教你做饭，我记下了。'];
  for(let refresh=0;refresh<2;refresh++){
    const book=await f.read(),saved=book.sessions[0].turns.filter(t=>t.viaVoice);
    assert.deepEqual(saved.map(t=>t.text),expected);
    assert.deepEqual(saved.map(t=>t.voiceOrder),[0,1,2]);
    assert.equal(saved[0].interrupted,true);
    assert.deepEqual(book.claims.map(c=>c.text),['不是妈妈，是我外婆。']);
  }
  assert.equal(f.events.filter(e=>e.type==='transcript'&&e.final&&e.turn?.providerResponseId==='partial').length,1);
  assert.ok(f.events.some(e=>e.type==='response_done'&&e.responseId==='corrected'&&e.status==='completed'));
});

test('Qwen cancellation before any text saves no empty turn and ignores late text',async t=>{
  const f=await fixture(t,'qwen');
  f.emit({type:'response.created',response:{id:'silent-cancel'}});
  f.emit({type:'response.done',response:{id:'silent-cancel',status:'cancelled'}});
  f.emit({type:'response.audio_transcript.delta',response_id:'silent-cancel',delta:'取消后迟到的文字'});
  f.speech('real-user');f.transcript('real-user','不是妈妈，是外婆。');
  await until(async()=> (await f.read()).sessions[0].turns.some(t=>t.providerItemId==='real-user'));
  assert.ok(!(await f.read()).sessions[0].turns.some(t=>t.providerResponseId==='silent-cancel'));
  assert.ok(!f.events.some(e=>e.type==='transcript'&&e.text==='取消后迟到的文字'));
});

 test('WebRTC refusal ends live context and removes the refused topic from later memory',async t=>{
  const f=await fixture(t);f.speech('old');f.transcript('old','我爷爷住在山上。');
  await until(async()=> (await f.read()).claims.length===1);
  f.speech('refusal');f.transcript('refusal','别再提爷爷。');
  await until(()=>f.events.some(e=>e.type==='error'&&e.message.includes('已避开')));
  const book=await f.read();assert.equal(book.sessions[0].turns.find(t=>t.providerItemId==='old').avoided,true);
  assert.ok(book.book.avoidedTopics.some(t=>t.topic==='爷爷'));await until(()=>f.client.readyState===WebSocket.CLOSED);
 });

for(const reason of ['invalid','failed'])test(`WebRTC ${reason} transcription does not prevent stop or lose completed speech`,async t=>{
 const f=await fixture(t);f.speech('missing');f.speech('valid');f.transcript('valid','这是需要保存的话。');
 await until(async()=> (await f.read()).claims.length===1);
 if(reason==='invalid')f.emit({type:'input_audio_buffer.speech_stopped',item_id:'missing',reason:'turn_invalid'});
 else f.emit({type:'conversation.item.input_audio_transcription.failed',item_id:'missing'});
 f.client.send(JSON.stringify({type:'stop'}));await until(()=>f.events.some(e=>e.type==='stopped'));
 assert.equal((await f.read()).sessions[0].turns.find(t=>t.role==='user').text,'这是需要保存的话。');
});
