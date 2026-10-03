import test from 'node:test';
import assert from 'node:assert/strict';
import {WebRtcVoice} from '../public/webrtc-voice.js';
function fixture(t){
  const originals={Audio:globalThis.Audio,document:globalThis.document,RTCPeerConnection:globalThis.RTCPeerConnection,WebSocket:globalThis.WebSocket};
  const track={readyState:'live',enabled:true,stop(){this.readyState='ended';}},dc={readyState:'open',send(){}},sent=[];
  class Audio{setAttribute(){}play(){return Promise.resolve();}remove(){}}
  class Peer{addTransceiver(){return {sender:{}};}createDataChannel(){return dc;}close(){}}
  Object.assign(globalThis,{Audio,document:{body:{append(){}}},RTCPeerConnection:Peer,WebSocket:{OPEN:1}});
  t.mock.timers.enable({apis:['setTimeout']});
  const rtc=new WebRtcVoice({stream:{getAudioTracks:()=>[track],getTracks:()=>[track]},socket:{readyState:1,send:e=>sent.push(JSON.parse(e))},health:{data:{}},isCurrent:()=>true,onError:assert.fail});
  t.after(()=>{rtc.close();t.mock.timers.reset();Object.assign(globalThis,originals);});
  return {rtc,track,sent,emit:e=>dc.onmessage({data:JSON.stringify(e)}),tick:ms=>t.mock.timers.tick(ms)};
}
test('capture remains enabled during long replies, pauses, completion and cancellation',t=>{
  const f=fixture(t);
  for(const status of ['completed','cancelled']){
    f.emit({type:'response.created',response:{id:status}});f.tick(30000);
    assert.equal(f.track.enabled,true,'assistant playback cannot gate human speech');
    f.emit({type:'response.done',response:{id:status,status}});f.tick(2000);
    assert.equal(f.track.enabled,true);
  }
});
test('provider interruption and subsequent reply keep the native playout reference continuous',t=>{
  const f=fixture(t);f.rtc.pc.ontrack({streams:[{}]});
  f.emit({type:'response.created',response:{id:'a'}});
  f.emit({type:'input_audio_buffer.speech_started',item_id:'user-a'});
  assert.equal(f.rtc.output.muted,false);assert.equal(f.track.enabled,true);
  assert.ok(f.sent.some(e=>e.type==='rtc_event'&&e.event.type==='input_audio_buffer.speech_started'));
  assert.equal(f.sent.filter(e=>e.type==='manual_interrupt').length,0);
  f.emit({type:'response.done',response:{id:'a',status:'cancelled'}});
  f.emit({type:'response.created',response:{id:'b'}});
  assert.equal(f.rtc.output.muted,false);assert.equal(f.track.enabled,true);
  assert.equal(f.rtc.health.data.rtcPlaybackStarts,1,'only start the renderer when its remote track arrives');
});
test('late response metadata cannot restart capture after the user stops',t=>{
  const f=fixture(t);f.emit({type:'response.created',response:{id:'a'}});f.rtc.muteInput();
  f.emit({type:'response.done',response:{id:'a',status:'cancelled'}});
  f.emit({type:'response.created',response:{id:'b'}});f.tick(3000);
  assert.equal(f.track.enabled,false);assert.equal(f.track.readyState,'ended');assert.equal(f.rtc.output.muted,true);
});
test('early metadata, immediate human speech and repeated turn gaps never restart the renderer',t=>{
  const f=fixture(t);
  f.emit({type:'response.created',response:{id:'before-track'}});
  assert.equal(f.rtc.health.data.rtcPlaybackStarts,0,'metadata may arrive before the remote track');
  const remote={};f.rtc.pc.ontrack({streams:[remote]});
  for(let i=0;i<10;i++){
    f.emit({type:'response.created',response:{id:'a'+i}});
    // Human speech must be accepted even at the very beginning of the reply.
    f.emit({type:'input_audio_buffer.speech_started',item_id:'u'+i});
    f.emit({type:'response.done',response:{id:'a'+i,status:'cancelled'}});
    f.tick(15000);
    assert.equal(f.rtc.output.srcObject,remote);
    assert.equal(f.rtc.output.muted,false);
    assert.equal(f.track.enabled,true);
  }
  assert.equal(f.rtc.health.data.rtcPlaybackStarts,1);
  assert.equal(f.sent.filter(e=>e.event?.type==='input_audio_buffer.speech_started').length,10);
});
