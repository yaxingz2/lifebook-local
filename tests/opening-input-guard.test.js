import test from 'node:test';
import assert from 'node:assert/strict';
import {WebRtcVoice} from '../public/webrtc-voice.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
  const previous={Audio:globalThis.Audio,document:globalThis.document,RTCPeerConnection:globalThis.RTCPeerConnection,WebSocket:globalThis.WebSocket};
  t.mock.timers.enable({apis:['Date','setTimeout']});
  const phases=[],errors=[],attached=[],health={data:{browserPlatform:'ios'}};
  const silent={enabled:true,readyState:'live',stop(){this.readyState='ended';}};
  const microphone={enabled:true,muted:false,readyState:'live',clone(){return silent;},stop(){this.readyState='ended';}};
  const dc={readyState:'open',send(){}};let level=0,energy,bytes=0,playResolve,current=true,statsFailure=false;
  class Audio {paused=false;setAttribute(){}play(){return new Promise(resolve=>{playResolve=resolve;});}remove(){}}
  class Peer {
    connectionState='connected';
    addTransceiver(){return {sender:{track:null,async replaceTrack(track){this.track=track;attached.push(track);}}};}
    createDataChannel(){return dc;}
    async getStats(){if(statsFailure)throw Error('stats failed');return new Map([['out',{type:'outbound-rtp',kind:'audio',bytesSent:++bytes}],['in',{type:'inbound-rtp',kind:'audio',audioLevel:level,totalAudioEnergy:energy}]]);}
    close(){}
  }
  Object.assign(globalThis,{Audio,document:{body:{append(){}}},RTCPeerConnection:Peer,WebSocket:{OPEN:1}});
  const rtc=new WebRtcVoice({stream:{getTracks:()=>[microphone],getAudioTracks:()=>[microphone]},socket:{readyState:0},health,isCurrent:()=>current,onError:message=>errors.push(message),onStartupProtection:phase=>phases.push(phase)});
  rtc.channel=dc;rtc.output.srcObject={};rtc.play();
  t.after(()=>{rtc.close();t.mock.timers.reset();Object.assign(globalThis,previous);});
  return {rtc,microphone,silent,attached,health,phases,errors,setLevel:value=>level=value,setEnergy:value=>energy=value,play:async()=>{playResolve();await tick();},stale:()=>current=false,failStats:()=>statsFailure=true,
    advance:async ms=>{for(let n=0;n<ms;n+=100){t.mock.timers.tick(Math.min(100,ms-n));await tick();}},ready:async()=>{const pending=rtc.ready();await tick();for(let i=0;i<8;i++){t.mock.timers.tick(100);await tick();}assert.equal(await pending,true);}};
}

test('opening sends zeroes while native default capture stays live, then opens once two seconds after audible playback',async t=>{
  const f=fixture(t);await f.ready();await f.play();
  assert.deepEqual(f.phases,['waiting']);assert.equal(f.rtc.sender.track,f.silent);assert.equal(f.silent.enabled,false);
  assert.equal(f.microphone.enabled,true);assert.equal(f.microphone.readyState,'live');
  await f.advance(6000);assert.deepEqual(f.phases,['waiting'],'connection age is not the playback start');
  f.setLevel(.00003);await f.advance(1000);assert.deepEqual(f.phases,['waiting'],'comfort noise must not start the two-second clock');
  f.setLevel(.12);await f.advance(100);assert.deepEqual(f.phases,['waiting','settling']);
  await f.advance(1900);assert.equal(f.rtc.sender.track,f.silent);assert.equal(f.microphone.enabled,true);
  await f.advance(100);assert.equal(f.rtc.sender.track,f.microphone);assert.equal(f.silent.readyState,'ended');
  assert.deepEqual(f.phases,['waiting','settling','open']);assert.equal(f.health.data.rtcStartupProtectionMs,2000);assert.equal(f.health.data.rtcStartupInputReleased,true);
  assert.deepEqual(f.attached,[f.silent,f.microphone]);
  for(let i=0;i<3;i++){f.setLevel(0);await f.advance(1000);f.setLevel(.2);await f.advance(3000);}
  assert.deepEqual(f.attached,[f.silent,f.microphone],'later replies never gate human speech');assert.equal(f.microphone.enabled,true);
});

test('incoming energy cannot open input until native playback has started',async t=>{
  const f=fixture(t);await f.ready();f.setLevel(.2);await f.advance(3000);assert.deepEqual(f.phases,['waiting']);
  await f.play();await f.advance(100);assert.deepEqual(f.phases,['waiting','settling']);await f.advance(2000);assert.equal(f.rtc.sender.track,f.microphone);
});

test('a browser without audioLevel uses advancing decoded audio energy',async t=>{
  const f=fixture(t);f.setLevel(undefined);f.setEnergy(0);await f.ready();await f.play();await f.advance(1000);assert.deepEqual(f.phases,['waiting']);
  f.setEnergy(.01);await f.advance(100);assert.deepEqual(f.phases,['waiting','settling']);await f.advance(2000);assert.equal(f.rtc.sender.track,f.microphone);
});

for(const phase of ['waiting','settling'])for(const cancel of ['mute','close','stale'])test(`cancellation during ${phase} (${cancel}) cannot re-enable an old sender`,async t=>{
  const f=fixture(t);await f.ready();await f.play();if(phase==='settling'){f.setLevel(.2);await f.advance(100);}
  if(cancel==='mute')f.rtc.muteInput();else if(cancel==='close')f.rtc.close();else f.stale();
  await f.advance(25000);assert.deepEqual(f.attached,[f.silent]);assert.equal(f.silent.readyState,'ended');assert.equal(f.errors.length,0);assert.ok(!f.phases.includes('open'));
});

test('missing opening audio fails with bounded cleanup instead of silently leaving the microphone ignored',async t=>{
  const f=fixture(t);await f.ready();await f.play();await f.advance(20000);
  assert.equal(f.errors.length,1);assert.match(f.errors[0],/开场语音尚未播放/);assert.equal(f.silent.readyState,'ended');assert.ok(!f.phases.includes('open'));
});

test('failed playback measurements release startup resources and report a recoverable error',async t=>{
  const f=fixture(t);await f.ready();await f.play();f.failStats();await f.advance(100);
  assert.equal(f.errors.length,1);assert.equal(f.silent.readyState,'ended');await f.advance(25000);assert.equal(f.errors.length,1);
});
