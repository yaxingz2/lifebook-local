import test from 'node:test';
import assert from 'node:assert/strict';
import {configureMicrophoneEcho} from '../public/webrtc-voice.js';

const chrome={userAgent:'Mozilla/5.0 Chrome/154.0.8037.58 Safari/537.36'};
function microphone({modes=[false,true,'remote-only','all'],echo=true,reject=false}={}){
  let settings={echoCancellation:echo,noiseSuppression:true,autoGainControl:true,channelCount:1,sampleRate:48000};
  const constraints={channelCount:1,echoCancellation:{exact:true},noiseSuppression:true,autoGainControl:true,deviceId:{exact:'same-microphone'}};
  const calls=[];
  const track={readyState:'live',getCapabilities:()=>({echoCancellation:modes}),getSettings:()=>({...settings}),getConstraints:()=>constraints,
    async applyConstraints(value){calls.push(value);if(reject)throw Object.assign(Error('cannot reconfigure'),{name:'OverconstrainedError'});settings.echoCancellation=value.echoCancellation.exact;}};
  return {track,calls,constraints};
}

test('supported microphone requests all playout cancellation on the same device and preserves other processing',async()=>{
  const mic=microphone(),metrics=await configureMicrophoneEcho(mic.track,chrome);
  assert.deepEqual(mic.calls,[{...mic.constraints,echoCancellation:{exact:'all'}}]);
  assert.equal(mic.constraints.echoCancellation.exact,true,'do not mutate the original constraints');
  assert.equal(metrics.echoCancellationMode,'all');assert.equal(metrics.echoCancellationEnabled,true);
  assert.equal(metrics.echoCancellationAllRequested,true);assert.equal(metrics.echoCancellationAllRejected,false);
  assert.equal(metrics.noiseSuppressionEnabled,true);assert.equal(metrics.autoGainControlEnabled,true);
  assert.equal(metrics.browserFamily,'chrome');assert.equal(metrics.browserMajor,154);
  assert.equal(metrics.micSampleRate,48000);assert.equal(metrics.micChannelCount,1);
  assert.ok(!JSON.stringify(metrics).includes('same-microphone'));
});

test('older microphone capabilities retain enabled browser cancellation without requesting unsupported strings',async()=>{
  const mic=microphone({modes:[false,true]}),metrics=await configureMicrophoneEcho(mic.track,chrome);
  assert.equal(mic.calls.length,0);assert.equal(metrics.echoCancellationMode,'browser-default');
  assert.equal(metrics.echoCancellationAllSupported,false);assert.equal(metrics.echoCancellationAllRequested,false);
});

test('failed all-mode reconfiguration keeps existing capture and reports fallback honestly',async()=>{
  const mic=microphone({reject:true}),metrics=await configureMicrophoneEcho(mic.track,chrome);
  assert.equal(mic.calls.length,1);assert.equal(metrics.echoCancellationAllRejected,true);
  assert.equal(metrics.echoCancellationMode,'browser-default');assert.equal(metrics.echoCancellationEnabled,true);
  assert.equal(mic.track.readyState,'live');
});

test('unavailable capabilities do not prevent capture and remote-only remains distinct from all',async()=>{
  const mic=microphone({echo:'remote-only'});mic.track.getCapabilities=()=>{throw Error('unsupported');};
  const metrics=await configureMicrophoneEcho(mic.track,{userAgent:chrome.userAgent+' Edg/154.0.4258.37'});
  assert.equal(mic.calls.length,0);assert.equal(metrics.echoCancellationMode,'remote-only');
  assert.equal(metrics.browserFamily,'edge');assert.equal(metrics.browserMajor,154);
});

test('disabled or unreported echo processing is never labelled enabled',async()=>{
  for(const echo of [false,undefined,'unknown-mode']){
    const mic=microphone({modes:[]});mic.track.getSettings=()=>({echoCancellation:echo});
    const metrics=await configureMicrophoneEcho(mic.track,{});
    assert.equal(metrics.echoCancellationEnabled,false);
    assert.equal(metrics.echoCancellationReported,echo===false);
    assert.equal(metrics.echoCancellationMode,echo===false?'disabled':'unreported');
    assert.equal(metrics.noiseSuppressionReported,false);assert.equal(metrics.autoGainControlReported,false);
  }
});

test('a stopped microphone is never reconfigured',async()=>{
  const mic=microphone();mic.track.readyState='ended';
  const metrics=await configureMicrophoneEcho(mic.track,chrome);
  assert.equal(mic.calls.length,0);assert.equal(metrics.echoCancellationAllRequested,false);
});

test('already active all-mode cancellation does not restart microphone processing',async()=>{
  const mic=microphone({echo:'all'}),metrics=await configureMicrophoneEcho(mic.track,chrome);
  assert.equal(mic.calls.length,0);assert.equal(metrics.echoCancellationMode,'all');
  assert.equal(metrics.echoCancellationAllRequested,false);
});

test('initial all-mode request is recorded even when the browser falls back to boolean cancellation',async()=>{
  const mic=microphone({modes:[false,true]}),metrics=await configureMicrophoneEcho(mic.track,chrome,{allRequested:true});
  assert.equal(metrics.echoCancellationAllRequested,true);assert.equal(metrics.echoCancellationAllSupported,false);
  assert.equal(metrics.echoCancellationMode,'browser-default');assert.equal(mic.calls.length,0);
});
