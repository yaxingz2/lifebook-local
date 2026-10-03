import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket} from 'ws';
import {WebRtcVoice} from '../public/webrtc-voice.js';
import {diagnosticMetrics} from '../src/voice-diagnostics.js';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=7000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await delay(20);}throw Error('WebRTC fixture timed out');}

for(const qwenTurnDetection of ['server_vad','semantic_vad'])test(`WebRTC authenticated signalling, final speech saving, duplicate ASR and resume memory (${qwenTurnDetection})`,async t=>{
  const offers=[];const signal=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);offers.push({authorization:req.headers.authorization,body:Buffer.concat(chunks).toString()});res.writeHead(200,{'Content-Type':'application/sdp'});res.end('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n');});
  await new Promise(r=>signal.listen(0,'127.0.0.1',r));
  const dir=await mkdtemp(join(tmpdir(),'lifebook-rtc-'));
  const child=spawn(process.execPath,['src/server.js'],{cwd:join(import.meta.dirname,'..'),env:{...process.env,PORT:'0',NODE_ENV:'test',LIFEBOOK_DATA_DIR:dir,LIFEBOOK_SHARED_CONFIG_DIR:dir,LIFEBOOK_WEBRTC_TEST_URL:`http://127.0.0.1:${signal.address().port}/signal`},stdio:['ignore','pipe','pipe']});
  const peers=[];t.after(async()=>{for(const c of peers)c.terminate();const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;await new Promise(r=>signal.close(r));await rm(dir,{recursive:true,force:true});});
  const url=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('startup timeout')),10000);child.stdout.on('data',c=>{text+=c;const m=text.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});});
  const boot=await(await fetch(url+'/api/bootstrap')).json();assert.equal(boot.settings.qwenVoiceTransport,'webrtc');
  const api=async(path,method='GET',body)=>{const r=await fetch(url+path,{method,headers:{Origin:url,'X-LifeBook-Token':boot.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  assert.equal((await api('/api/settings','PUT',{mode:'qwen',qwenConnection:'unified',apiKey:'fake-key-for-rtc-test',qwenTurnDetection})).status,200);
  assert.equal((await api('/api/settings','PUT',{mode:'qwen',qwenConnection:'unified',qwenVoiceTransport:'unknown',apiKey:'must-not-save'})).status,400);
  assert.equal((await api('/api/voice-preferences','PUT',{model:'qwen-audio-3.0-realtime-flash',voice:'longanlufeng',speechRate:'fast'})).status,200);
  const book=(await api('/api/books','POST',{title:'WebRTC 验收（虚构素材）'})).data;
  const session=(await api(`/api/books/${book.id}/sessions`,'POST',{voice:true})).data;
  const asset=await fetch(url+'/webrtc-voice.js');assert.equal(asset.status,200);assert.notEqual((await fetch(url+'/microphone-input.js')).status,200);assert.equal((await fetch(url+'/voice-transcript.js')).status,200);
  for(const settings of [{mode:'openai'},{mode:'qwen',qwenVoiceTransport:'websocket'},{mode:'qwen',qwenVoiceModel:'qwen-audio-3.1-realtime-plus'}]){
    assert.equal((await api('/api/settings','PUT',{...settings,apiKey:'must-not-save'})).status,400);
  }
  assert.equal((await api('/api/settings')).data.hasKey,true);
  assert.equal((await fetch(url+'/audio-worklet.js')).status,404);
  assert.equal((await fetch(url+'/barge-in.js')).status,404);
  const legacy=new WebSocket(url.replace('http:','ws:')+'/api/voice',['lifebook',boot.token],{origin:url});peers.push(legacy);
  const legacyEvents=[];legacy.on('message',raw=>legacyEvents.push(JSON.parse(raw)));await new Promise(r=>legacy.once('open',r));
  legacy.send(JSON.stringify({type:'start',bookId:book.id,sessionId:session.id,transport:'websocket'}));
  await until(()=>legacyEvents.some(e=>e.type==='error'));assert.equal(offers.length,0);
  const invalid=new WebSocket(url.replace('http:','ws:')+'/api/voice',['lifebook',boot.token],{origin:url});peers.push(invalid);
  const invalidEvents=[];invalid.on('message',raw=>invalidEvents.push(JSON.parse(raw)));await new Promise(r=>invalid.once('open',r));
  invalid.send(JSON.stringify({type:'start',bookId:book.id,sessionId:session.id,transport:'webrtc',offer:'not an SDP offer'}));
  await until(()=>invalidEvents.some(e=>e.type==='error'));assert.equal(offers.length,0);
  const unauthorized=new WebSocket(url.replace('http:','ws:')+'/api/voice',['lifebook','wrong-token'],{origin:url});peers.push(unauthorized);
  unauthorized.on('error',()=>{});const denied=await new Promise(r=>unauthorized.on('unexpected-response',(_req,res)=>{res.resume();r(res.statusCode);unauthorized.terminate();}));assert.equal(denied,403);assert.equal(offers.length,0);
  async function connect(resume=false,ack=true,prepare=false){
    const events=[];const client=new WebSocket(url.replace('http:','ws:')+'/api/voice',['lifebook',boot.token],{origin:url});peers.push(client);
    client.on('message',raw=>events.push(JSON.parse(raw)));await new Promise(r=>client.once('open',r));
    const emit=e=>client.send(JSON.stringify({type:'rtc_event',event:e}));
    const offer='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
    if(prepare){
      client.send(JSON.stringify({type:'prepare',transport:'webrtc',offer}));
      await until(()=>events.some(x=>x.type==='rtc_answer'));emit({type:'session.created'});
      await until(()=>events.some(x=>x.type==='rtc_command'&&x.event.type==='session.update'));emit({type:'session.updated'});
      await until(()=>events.some(x=>x.type==='prepared'));await delay(150);
      assert.ok(!events.some(x=>x.type==='ready'||x.type==='usage'||x.type==='rtc_command'&&['response.create','conversation.item.create'].includes(x.event.type)),'preparation must not start or bill a conversation');
      const untouched=(await api(`/api/books/${book.id}`)).data.sessions[0];assert.equal(untouched.turns.length,0);assert.equal(untouched.voiceRuns,undefined);
      assert.equal(events.filter(x=>x.type==='rtc_answer').length,1);
    }
    client.send(JSON.stringify({type:'start',bookId:book.id,sessionId:session.id,transport:'webrtc',resume,...(prepare?{}:{offer})}));
    if(!prepare){await until(()=>events.some(x=>x.type==='rtc_answer'));emit({type:'session.created'});}
    await until(()=>events.filter(x=>x.type==='rtc_command'&&x.event.type==='session.update').length===(prepare?2:1));emit({type:'session.updated'});
    await until(()=>events.some(x=>x.type==='ready'));
    const confirm=()=>client.send(JSON.stringify({type:'rtc_media_ready',startupId:events.find(x=>x.type==='ready').startupId,metrics:{rtcMicReady:true,rtcStartupMs:350}}));
    if(ack){confirm();await until(()=>events.some(x=>x.type==='rtc_command'&&x.event.type==='response.create'));}
    return {client,events,emit,confirm};
  }
  const first=await connect(false,false,true);assert.equal(first.events.find(e=>e.type==='ready').opening,true);assert.equal(offers[0].authorization,'Bearer fake-key-for-rtc-test');
  assert.equal(offers.length,1,'activation reuses the prepared SDP handshake');
  assert.ok(!JSON.stringify(first.events).includes('fake-key-for-rtc-test'));
  await delay(150);assert.ok(!first.events.some(e=>e.type==='rtc_command'&&e.event.type==='response.create'),'never greet before mic readiness');
  first.client.send(JSON.stringify({type:'rtc_media_ready',startupId:'old-connection'}));
  await delay(50);assert.ok(!first.events.some(e=>e.type==='rtc_command'&&e.event.type==='response.create'),'ignore stale readiness');
  first.confirm();first.confirm();first.emit({type:'session.updated'});
  await until(()=>first.events.some(e=>e.type==='rtc_command'&&e.event.type==='response.create'));
  await delay(50);assert.equal(first.events.filter(e=>e.type==='rtc_command'&&e.event.type==='response.create').length,1);
  first.emit({type:'response.created'});
  first.emit({type:'input_audio_buffer.speech_started',item_id:'speech-last',audio_start_ms:0});
  first.emit({type:'response.done',response:{id:'old',status:'cancelled'}});
  first.client.send(JSON.stringify({type:'stop'}));
  await delay(3800);assert.ok(!first.events.some(e=>e.type==='stopped'),'pending final speech must survive stop');
  const transcript='等一下，不是王老师，是黄老师，应该是四年级。';
  first.emit({type:'input_audio_buffer.speech_stopped',item_id:'speech-last',audio_end_ms:1800});
  first.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'speech-last',transcript});
  first.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'speech-last',transcript});
  await until(()=>first.events.some(e=>e.type==='stopped'));
  const saved=(await api(`/api/books/${book.id}`)).data;const users=saved.sessions[0].turns.filter(v=>v.role==='user');assert.equal(users.length,1);assert.equal(users[0].text,transcript);assert.equal(saved.claims.length,1);
  assert.equal(first.events.filter(e=>e.type==='rtc_command'&&e.event.type==='session.update').length,2);
  const initial=first.events.filter(e=>e.type==='rtc_command'&&e.event.type==='session.update').at(-1).event.session;
  assert.deepEqual(initial.turn_detection,qwenTurnDetection==='server_vad'?{type:'server_vad',threshold:0.75,silence_duration_ms:1200}:{type:'smart_turn'});
  assert.equal(initial.voice,'longanlufeng');assert.match(initial.instructions,/语速稍快但清晰/);
  assert.equal(first.events.filter(e=>e.type==='rtc_command'&&e.event.type==='response.cancel').length,0);
  assert.equal(saved.sessions[0].voiceRuns[0].clientReported,true);
  const second=await connect(true);const config=second.events.find(e=>e.type==='rtc_command'&&e.event.type==='session.update');assert.match(config.event.session.instructions,/黄老师/);assert.match(config.event.session.instructions,/四年级/);
  second.emit({type:'response.created',response:{id:'resumed'}});second.emit({type:'response.output_audio_transcript.delta',response_id:'resumed',delta:'继续聊'});second.emit({type:'response.output_audio_transcript.done',transcript:'继续聊黄老师那节体育课吧。'});second.emit({type:'response.done',response:{id:'resumed',status:'completed'}});
  await until(async()=> (await api(`/api/books/${book.id}`)).data.sessions[0].turns.some(v=>v.role==='assistant'&&v.text==='继续聊黄老师那节体育课吧。'));
  const streamed=second.events.find(e=>e.type==='transcript'&&!e.final&&e.role==='assistant');assert.equal(streamed.text,'继续聊');assert.equal(streamed.responseId,'resumed');const savedAssistant=(await api(`/api/books/${book.id}`)).data.sessions[0].turns.find(v=>v.role==='assistant');assert.equal(savedAssistant.providerResponseId,'resumed');
  second.emit({type:'response.created',response:{id:'spoken-reply'}});
  second.emit({type:'response.output_audio_transcript.delta',response_id:'spoken-reply',delta:'刚才说到的那件事'});
  await until(()=>second.events.some(e=>e.type==='transcript'&&e.text==='刚才说到的那件事'));
  second.emit({type:'input_audio_buffer.speech_started',item_id:'spoken-user'});
  second.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'spoken-user',transcript:'我想换个话题。'});
  second.emit({type:'response.done',response:{id:'spoken-reply',status:'cancelled'}});
  await until(async()=> (await api(`/api/books/${book.id}`)).data.sessions[0].turns.some(v=>v.providerItemId==='spoken-user'));
  const spokenTurns=(await api(`/api/books/${book.id}`)).data.sessions[0].turns;
  assert.equal(spokenTurns.filter(v=>v.providerResponseId==='spoken-reply').length,1);
  assert.equal(spokenTurns.find(v=>v.providerResponseId==='spoken-reply').interrupted,true);
  assert.equal(spokenTurns.filter(v=>v.role==='user').length,2,'natural interruption saves only the spoken user turn');
  // The provider can notify cancellation before speech detection over WebRTC.
  second.emit({type:'response.created',response:{id:'cancel-first-reply'}});
  second.emit({type:'response.output_audio_transcript.delta',response_id:'cancel-first-reply',delta:'你妈妈当时教你做饭'});
  second.emit({type:'response.done',response:{id:'cancel-first-reply',status:'cancelled'}});
  second.emit({type:'input_audio_buffer.speech_started',item_id:'cancel-first-user'});
  second.emit({type:'input_audio_buffer.speech_stopped',item_id:'cancel-first-user'});
  second.emit({type:'response.created',response:{id:'corrected-reply'}});
  second.emit({type:'response.output_audio_transcript.delta',response_id:'corrected-reply',delta:'是外婆，我记下了。'});
  second.emit({type:'response.output_audio_transcript.delta',response_id:'cancel-first-reply',delta:'迟到的旧文字'});
  second.emit({type:'response.output_audio_transcript.done',response_id:'cancel-first-reply',transcript:'迟到的旧全文不应覆盖半句'});
  second.emit({type:'response.done',response:{id:'cancel-first-reply',status:'cancelled'}});
  second.emit({type:'response.done',response:{id:'corrected-reply',status:'completed'}});
  second.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'cancel-first-user',transcript:'不是妈妈，是我外婆。'});
  second.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'cancel-first-user',transcript:'不是妈妈，是我外婆。'});
  await until(async()=>{const turns=(await api(`/api/books/${book.id}`)).data.sessions[0].turns;return turns.some(t=>t.providerResponseId==='corrected-reply')&&turns.some(t=>t.providerItemId==='cancel-first-user');});
  for(let refresh=0;refresh<2;refresh++){
    const turns=(await api(`/api/books/${book.id}`)).data.sessions[0].turns;
    const corrected=turns.filter(t=>['cancel-first-reply','corrected-reply'].includes(t.providerResponseId)||t.providerItemId==='cancel-first-user');
    assert.deepEqual(corrected.map(t=>t.text),['你妈妈当时教你做饭','不是妈妈，是我外婆。','是外婆，我记下了。']);
    assert.equal(corrected[0].interrupted,true);
  }
  assert.equal(second.events.filter(e=>e.type==='transcript'&&e.final&&e.turn?.providerResponseId==='cancel-first-reply').length,1);
  // Pause before response.done: the final visible sentence must survive the
  // stop acknowledgement and subsequent reloads instead of vanishing.
  second.emit({type:'response.created',response:{id:'paused-reply'}});
  second.emit({type:'response.output_audio_transcript.delta',response_id:'paused-reply',delta:'当时你有什么感受？'});
  await until(()=>second.events.some(e=>e.type==='transcript'&&!e.final&&e.responseId==='paused-reply'));
  second.client.send(JSON.stringify({type:'stop'}));await until(()=>second.events.some(e=>e.type==='stopped'));
  const pausedFinal=second.events.findIndex(e=>e.type==='transcript'&&e.final&&e.turn?.providerResponseId==='paused-reply');
  assert.ok(pausedFinal>=0&&pausedFinal<second.events.findIndex(e=>e.type==='stopped'),'persist before acknowledging stop');
  for(let refresh=0;refresh<2;refresh++){
    const paused=(await api(`/api/books/${book.id}`)).data.sessions[0].turns.filter(t=>t.providerResponseId==='paused-reply');
    assert.equal(paused.length,1);assert.equal(paused[0].text,'当时你有什么感受？');assert.equal(paused[0].interrupted,true);
  }
  const earlySpeech=await connect(true,false);earlySpeech.emit({type:'input_audio_buffer.speech_started'});earlySpeech.confirm();
  await delay(100);assert.ok(!earlySpeech.events.some(e=>e.type==='rtc_command'&&e.event.type==='response.create'),'early user speech replaces the greeting');
  earlySpeech.client.terminate();
  const stopped=await connect(true,false);stopped.client.send(JSON.stringify({type:'stop'}));stopped.confirm();
  await delay(100);assert.ok(!stopped.events.some(e=>e.type==='rtc_command'&&e.event.type==='response.create'),'stop before readiness must not greet');
  assert.equal(offers.length,4);
  // A cancelled preparation has no attached conversation listener yet. Stop
  // must still close it immediately instead of waiting for the audio deadline.
  const canceled=new WebSocket(url.replace('http:','ws:')+'/api/voice',['lifebook',boot.token],{origin:url});peers.push(canceled);
  const cancelEvents=[];canceled.on('message',raw=>cancelEvents.push(JSON.parse(raw)));await new Promise(r=>canceled.once('open',r));
  canceled.send(JSON.stringify({type:'prepare',transport:'webrtc',offer:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'}));
  await until(()=>cancelEvents.some(e=>e.type==='rtc_answer'));
  canceled.send(JSON.stringify({type:'rtc_event',event:{type:'session.created'}}));
  await until(()=>cancelEvents.some(e=>e.type==='rtc_command'));canceled.send(JSON.stringify({type:'rtc_event',event:{type:'session.updated'}}));
  await until(()=>cancelEvents.some(e=>e.type==='prepared'));canceled.send(JSON.stringify({type:'stop'}));
  await until(()=>cancelEvents.some(e=>e.type==='stopped'),1000);
  assert.ok(!cancelEvents.some(e=>e.type==='rtc_command'&&e.event.type==='response.create'));assert.equal(offers.length,5);
});

test('native media waits for configuration; stopping mutes input but keeps final metadata',async t=>{
  const originals={Audio:globalThis.Audio,document:globalThis.document,RTCPeerConnection:globalThis.RTCPeerConnection,WebSocket:globalThis.WebSocket};
  const commands=[],events=[];let attached=0,stops=0;
  const track={enabled:true,muted:false,readyState:'live',stop(){stops++;}};const stream={getAudioTracks:()=>[track],getTracks:()=>[track]};
  class Audio {constructor(){this.srcObject={};}setAttribute(){}play(){return Promise.resolve();}remove(){} }
  class Peer {connectionState='connected';sent=0;getStats(){return Promise.resolve(new Map([['out',{type:'outbound-rtp',kind:'audio',bytesSent:++this.sent}]]));}addTransceiver(){return {sender:{replaceTrack:async()=>{attached++;}}};}createDataChannel(){return {readyState:'open',send:e=>commands.push(JSON.parse(e))};}close(){}}
  Object.assign(globalThis,{Audio,document:{body:{append(){}}},RTCPeerConnection:Peer,WebSocket});
  const rtc=new WebRtcVoice({stream,socket:{readyState:WebSocket.OPEN,send:e=>events.push(JSON.parse(e))},health:{data:{}},isCurrent:()=>true,onError:message=>assert.fail(message)});
  t.after(()=>{rtc.close();Object.assign(globalThis,originals);});
  const dc=rtc.pc.createDataChannel();rtc.attach(dc);rtc.play();
  dc.onmessage({data:JSON.stringify({type:'session.created'})});assert.equal(attached,0);
  rtc.command({type:'session.update'});assert.equal(commands.length,1);await rtc.ready();assert.equal(attached,1);
  dc.onmessage({data:JSON.stringify({type:'input_audio_buffer.speech_started'})});assert.equal(rtc.output.muted,false);
  dc.onmessage({data:JSON.stringify({type:'response.created'})});assert.equal(rtc.output.muted,false);
  rtc.muteInput();assert.equal(track.enabled,false);assert.equal(rtc.output.muted,true);
  dc.onmessage({data:JSON.stringify({type:'response.created'})});assert.equal(rtc.output.muted,true);
  dc.onmessage({data:JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:'最后一句。'})});assert.equal(events.at(-1).event.transcript,'最后一句。');
  await delay(1700);assert.equal(stops,1);await rtc.ready();assert.equal(attached,1);
});

test('WebRTC distinguishes missing mic measurement from silence, uplink loss and a closed control channel',async t=>{
  const originals={Audio:globalThis.Audio,document:globalThis.document,RTCPeerConnection:globalThis.RTCPeerConnection,WebSocket:globalThis.WebSocket};
  let rows=[],errors=[];const track={enabled:true,muted:false,readyState:'live',stop(){}};
  const channel={readyState:'open',send(){}};
  class Audio {constructor(){this.srcObject={};}setAttribute(){}play(){return Promise.resolve();}remove(){}}
  class Peer {connectionState='connected';addTransceiver(){return {sender:{replaceTrack:async()=>{}}};}createDataChannel(){return channel;}getStats(){return Promise.resolve(new Map(rows.map((r,i)=>[i,r])));}close(){}}
  Object.assign(globalThis,{Audio,document:{body:{append(){}}},RTCPeerConnection:Peer,WebSocket});
  const health={data:{micRms:0,maxMicRms:0}};
  const rtc=new WebRtcVoice({stream:{getAudioTracks:()=>[track],getTracks:()=>[track]},socket:{readyState:WebSocket.OPEN,send(){}},health,isCurrent:()=>true,onError:message=>errors.push(message)});
  t.after(()=>{rtc.close();Object.assign(globalThis,originals);});
  await rtc.stats();assert.equal(health.data.rtcMicMeasured,false);assert.equal(health.data.rtcUplinkPacketsLost,null);
  rows=[{type:'media-source',id:'mic',kind:'audio',audioLevel:0,totalAudioEnergy:0,totalSamplesDuration:2}];
  await rtc.stats();assert.equal(health.data.rtcMicMeasured,true);assert.equal(health.data.micRms,0);
  rows=[{type:'media-source',id:'mic',kind:'audio',totalAudioEnergy:0.02,totalSamplesDuration:4},{type:'inbound-rtp',kind:'audio',packetsLost:2,bytesReceived:500,audioLevel:0.2,jitterBufferDelay:1.2,jitterBufferEmittedCount:100},{type:'remote-inbound-rtp',kind:'audio',packetsLost:5}];
  channel.onmessage({data:JSON.stringify({type:'session.created',event_id:'created'})});
  await rtc.stats();assert.equal(health.data.micRms,0.1);assert.equal(health.data.rtcPacketsLost,2);assert.equal(health.data.rtcUplinkPacketsLost,5);assert.equal(health.data.rtcPlayoutBufferMs,12);assert.equal(health.data.rtcControlOpen,true);assert.equal(health.data.rtcEventsReceived,1);
  const metrics=diagnosticMetrics({...health.data,micLabel:'private device name',arbitrary:'do not store'});assert.equal(metrics.micRms,0.1);assert.equal(metrics.rtcControlOpen,true);assert.ok(!Object.hasOwn(metrics,'micLabel'));assert.ok(!Object.hasOwn(metrics,'arbitrary'));
  channel.readyState='closed';channel.onclose();assert.equal(errors.length,1);assert.match(errors[0],/控制连接/);
  rtc.muteInput();channel.onclose();assert.equal(errors.length,1,'normal stop must not become a control channel error');
});

test('greeting is full duplex with streaming metadata, deduplication and normal interruption',async t=>{
  const originals={Audio:globalThis.Audio,document:globalThis.document,RTCPeerConnection:globalThis.RTCPeerConnection,WebSocket:globalThis.WebSocket};
  let attached=0;const seen=[],forwarded=[];const track={enabled:true,muted:false,readyState:'live',stop(){}};const dc={readyState:'open',send(){}};
  class Audio {constructor(){this.srcObject={};}setAttribute(){}play(){return Promise.resolve();}remove(){}}
  class Peer {connectionState='connected';sent=0;getStats(){return Promise.resolve(new Map([['out',{type:'outbound-rtp',kind:'audio',bytesSent:++this.sent}]]));}addTransceiver(){return {sender:{replaceTrack:async()=>{attached++;}}};}createDataChannel(){return dc;}close(){}}
  Object.assign(globalThis,{Audio,document:{body:{append(){}}},RTCPeerConnection:Peer,WebSocket});
  const rtc=new WebRtcVoice({stream:{getAudioTracks:()=>[track],getTracks:()=>[track]},socket:{readyState:WebSocket.OPEN,send:e=>forwarded.push(JSON.parse(e))},health:{data:{}},isCurrent:()=>true,onError:assert.fail,onEvent:e=>seen.push(e)});
  t.after(()=>{rtc.close();Object.assign(globalThis,originals);});
  rtc.play();const emit=e=>dc.onmessage({data:JSON.stringify(e)});emit({type:'session.created',event_id:'session'});await rtc.ready();assert.equal(attached,1);
  emit({type:'response.created',response:{id:'greeting'}});
  emit({type:'response.output_audio_transcript.delta',event_id:'text-one',response_id:'greeting',delta:'你好'});
  emit({type:'response.output_audio_transcript.delta',event_id:'text-one',response_id:'greeting',delta:'你好'});
  assert.equal(seen.filter(e=>e.type.endsWith('.delta')).length,1);
  emit({type:'input_audio_buffer.speech_started',item_id:'u1'});
  emit({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'你好'});
  assert.equal(rtc.output.muted,false);assert.equal(track.enabled,true);assert.equal(attached,1);
  assert.ok(seen.some(e=>e.item_id==='u1'&&e.transcript==='你好'));
  assert.ok(forwarded.some(e=>e.event.type==='response.output_audio_transcript.delta'));
});
