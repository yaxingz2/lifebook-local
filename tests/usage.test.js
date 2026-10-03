import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceUsage,normalizeUsage,estimateCost} from '../src/usage.js';
import {priceFor,initialVoiceConfig} from '../src/models.js';
const qwenUsage={input_tokens:336,output_tokens:41,input_tokens_details:{text_tokens:228,audio_tokens:108},output_tokens_details:{text_tokens:9,audio_tokens:32}};
test('Qwen plural details, free accompanying text, regional rates',()=>{
  const u=normalizeUsage(qwenUsage);
  assert.equal(estimateCost(u,priceFor('qwen-audio-3.0-realtime-flash','cn-beijing')),(228*1.5+108*6+32*12)/1e6);
  assert.ok(estimateCost(u,priceFor('qwen-audio-3.0-realtime-flash','ap-southeast-1'))>0);
  assert.equal(estimateCost(normalizeUsage({input_tokens:10,output_tokens:2}),priceFor('qwen-audio-3.0-realtime-flash','cn-beijing')),null);
});
test('billed cumulative tokens do not become occupancy; duplicate and absent usage handled',()=>{
  const m=new VoiceUsage('qwen-audio-3.0-realtime-flash','cn-beijing','test');
  const event={response:{id:'r1',usage:qwenUsage}};
  assert.equal(m.response(event),true);assert.equal(m.response(event),false);
  m.response({response:{id:'r2',usage:qwenUsage}});m.response({response:{id:'r3',status:'cancelled'}});
  const s=m.snapshot();assert.equal(s.inputTokens,672);assert.equal(s.latestInput,336);assert.equal(s.remainingInputEstimate,16384-336);assert.equal(s.missingResponses,1);
  m.state.userAudioSeconds=245;assert.equal(m.snapshot().warning,true);assert.equal(m.snapshot().historyMayRoll,false);
  assert.equal(m.snapshot(60).historyMayRoll,true);
  const resumed=new VoiceUsage('qwen-audio-3.0-realtime-flash','cn-beijing','same memories');assert.equal(resumed.snapshot().userAudioSeconds,0);assert.notEqual(resumed.state.id,m.state.id);
});
test('WebRTC Audio uses model-specific voice and smart turn',()=>{
  const s={mode:'qwen',qwenVoiceModel:'qwen-audio-3.0-realtime-flash',qwenVoices:{'qwen-audio-3.0-realtime-flash':'longanlingxi'}};
  const c=initialVoiceConfig(s,'instructions');assert.equal(c.voice,'longanlingxi');assert.equal(c.turn_detection.type,'smart_turn');assert.equal(c.max_history_turns,50);assert.equal(c.audio,undefined);
});
test('Qwen acoustic turn detection uses a higher noise threshold and preserves pause timing',()=>{
  const settings={mode:'qwen',qwenVoiceModel:'qwen-audio-3.0-realtime-flash',qwenTurnDetection:'server_vad'};
  const audio=initialVoiceConfig(settings,'instructions');
  assert.deepEqual(audio.turn_detection,{type:'server_vad',threshold:0.75,silence_duration_ms:1200});
});

test('unified endpoint never borrows a legacy regional price',()=>{assert.equal(priceFor('qwen-audio-3.0-realtime-flash','unified'),null);});
