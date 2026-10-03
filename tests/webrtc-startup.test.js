import test from 'node:test';
import assert from 'node:assert/strict';
import {WebRtcVoice} from '../public/webrtc-voice.js';
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(t){
  const originals={Audio:globalThis.Audio,document:globalThis.document,RTCPeerConnection:globalThis.RTCPeerConnection};
  const track={enabled:true,muted:false,readyState:'live',stop(){this.readyState='ended';}};
  const dc={readyState:'open',send(){}};
  let bytes=0,attachments=0,attachFinish;
  class Audio {setAttribute(){}play(){return Promise.resolve();}remove(){}}
  class Peer {
    connectionState='connected';
    iceGatheringState='complete';
    addTrack(input){assert.equal(input,track);attachments++;return {track:input};}
    addTransceiver(kind){assert.equal(kind,'audio');return {sender:{replaceTrack:input=>{assert.equal(input,track);attachments++;return new Promise(resolve=>attachFinish=resolve);}}};}
    createOffer(){return Promise.resolve({type:'offer',sdp:'fixture SDP'});}
    setLocalDescription(description){this.localDescription=description;return Promise.resolve();}
    setRemoteDescription(description){this.remoteDescription=description;return Promise.resolve();}
    createDataChannel(){return dc;}
    getStats(){return Promise.resolve(new Map([['out',{type:'outbound-rtp',kind:'audio',bytesSent:bytes}]]));}
    close(){}
  }
  Object.assign(globalThis,{Audio,document:{body:{append(){}}},RTCPeerConnection:Peer});
  let current=true;const health={data:{}};
  const rtc=new WebRtcVoice({stream:{getAudioTracks:()=>[track],getTracks:()=>[track]},socket:{readyState:0},health,isCurrent:()=>current,onError:assert.fail});
  // The selected channel and remote track exist before model configuration.
  rtc.channel=dc;rtc.output.srcObject={};rtc.play();
  t.mock.timers.enable({apis:['setTimeout','Date']});
  t.after(()=>{rtc.close();t.mock.timers.reset();Object.assign(globalThis,originals);});
  return {rtc,track,dc,health,attach:()=>attachFinish(),attachments:()=>attachments,setBytes:n=>bytes=n,stale:()=>current=false,
    advance:async ms=>{t.mock.timers.tick(ms);await tick();}};
}

test('startup waits for attachment and advancing RTP, accepting a silent microphone',async t=>{
  const f=fixture(t);assert.equal(f.attachments(),0);assert.equal(await f.rtc.offer(),'fixture SDP');
  let done=false;const ready=f.rtc.ready().then(v=>{done=v;return v;});
  assert.equal(f.rtc.ready(),f.rtc.ready());assert.equal(f.attachments(),1);
  f.setBytes(10);await f.advance(200);assert.equal(done,false,'slow attachment must block opening');
  f.attach();await tick();await f.advance(100);assert.equal(done,false,'one old RTP counter is not progress');
  f.setBytes(11);await f.advance(100);assert.equal(await ready,true);assert.equal(f.health.data.rtcMicReady,true);
  assert.equal(f.attachments(),1);assert.equal(f.track.enabled,true,'never mute capture for opening');assert.ok(f.health.data.rtcStartupMs>=300);
});

test('startup requires live unmuted capture, playback track and control connection',async t=>{
  const f=fixture(t);let done=false;const ready=f.rtc.ready().then(v=>{done=v;return v;});
  f.track.muted=true;f.attach();await tick();f.setBytes(10);await f.advance(100);assert.equal(done,false);
  f.track.muted=false;f.rtc.output.srcObject=null;f.setBytes(20);await f.advance(100);assert.equal(done,false);
  f.rtc.output.srcObject={};f.dc.readyState='connecting';f.setBytes(30);await f.advance(100);assert.equal(done,false);
  f.dc.readyState='open';f.rtc.pc.connectionState='connecting';f.setBytes(40);await f.advance(100);assert.equal(done,false);
  f.rtc.pc.connectionState='connected';f.setBytes(50);await f.advance(100);assert.equal(done,false);
  f.setBytes(60);await f.advance(100);assert.equal(await ready,true);
});

for(const action of ['muteInput','close','stale'])test(`startup cancels on ${action} and cannot become ready later`,async t=>{
  const f=fixture(t),ready=f.rtc.ready();
  if(action==='stale'){f.stale();f.attach();await tick();}else f.rtc[action]();
  assert.equal(await ready,false);
  if(action!=='stale')f.attach();f.setBytes(100);await f.advance(200);
  assert.notEqual(f.health.data.rtcMicReady,true);
});

test('a stalled microphone times out without falsely reporting readiness',async t=>{
  const f=fixture(t),ready=f.rtc.ready(),failed=assert.rejects(ready,/尚未准备好/);
  f.attach();await tick();await f.advance(8000);await failed;assert.notEqual(f.health.data.rtcMicReady,true);
});

test('iOS opening waits for stable live capture and native playout without muting the microphone',async t=>{
  const f=fixture(t);f.health.data.browserPlatform='ios';
  let done=false;const ready=f.rtc.ready().then(value=>{done=value;return value;});
  f.attach();await tick();f.setBytes(10);await f.advance(100);assert.equal(done,false);
  f.rtc.output.paused=true;f.setBytes(20);await f.advance(500);assert.equal(done,false,'paused output resets stability');
  f.rtc.output.paused=false;f.setBytes(30);await f.advance(100);
  f.setBytes(40);await f.advance(600);assert.equal(done,false,'new route must finish settling');
  f.setBytes(50);await f.advance(100);assert.equal(await ready,true);
  assert.equal(f.track.enabled,true);assert.notEqual(f.rtc.output.muted,true);assert.ok(f.health.data.rtcStartupMs>=1300);
});

test('silent remote audio cannot deadlock the greeting on an unresolved play promise',async t=>{
  const f=fixture(t);let allowPlayback;f.rtc.output.play=()=>new Promise(resolve=>allowPlayback=resolve);f.rtc.output.paused=false;f.rtc.play();
  let done=false;const ready=f.rtc.ready().then(value=>{done=value;return value;});f.attach();await tick();
  f.setBytes(10);await f.advance(100);assert.equal(await ready,true);
  allowPlayback();await tick();assert.equal(f.track.enabled,true);assert.equal(done,true);
});

test('slow initial voice configuration cannot race ahead of native microphone audio',async t=>{
  const f=fixture(t),configurations=[];
  // Match the provider rule from the reported error: even silent audio locks
  // voice configuration. A live/disabled track is not an adequate input gate.
  f.dc.send=raw=>{
    const event=JSON.parse(raw);
    if(event.type==='session.update'&&event.session.voice){
      assert.equal(f.attachments(),0,"Cannot update 'voice' after session has started processing audio.");
      configurations.push(event.session);
    }
  };
  await f.rtc.offer();await f.rtc.answer('v=0\nm=audio 9 UDP/TLS/RTP/SAVPF 111');
  await f.advance(5000);
  f.rtc.command({type:'session.update',session:{voice:'longanlufeng',turn_detection:{type:'server_vad',threshold:0.75}}});
  await f.advance(2000);assert.equal(f.attachments(),0,'wait until configuration acknowledgement');
  assert.equal(configurations.length,1);assert.equal(f.track.enabled,true,'native capture remains running locally');
  // app.js invokes ready only after the server acknowledges session.updated.
  const ready=f.rtc.ready();f.attach();await tick();f.setBytes(12);await f.advance(100);
  assert.equal(await ready,true);assert.equal(f.attachments(),1);
});
