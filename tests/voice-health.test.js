import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceHealth} from '../public/voice-health.js';
test('missing acknowledgements are visible and diagnostic history is bounded',()=>{
  let now=0;const h=new VoiceHealth(16000,()=>now);h.probe();
  now=5000;assert.equal(h.snapshot().pendingProbes,1);assert.equal(h.snapshot().browserRttMs,null);
  for(let i=0;i<200;i++){now+=1000;const p=h.probe();now+=20;h.acknowledge({id:p.id,stats:{}});}
  assert.equal(h.snapshot().samples.length,120);assert.equal(h.snapshot().pendingProbes,0);
});

test('control RTT and speech diagnostics omit arbitrary content',()=>{let now=0;const h=new VoiceHealth(16000,()=>now);const p=h.probe();now=650;h.acknowledge({id:p.id,stats:{speechEvents:2,transcript:'private',apiKey:'secret'}});const s=h.snapshot();assert.equal(s.browserRttMs,650);assert.equal(s.server.speechEvents,2);assert.doesNotMatch(JSON.stringify(s),/private|secret|transcript|apiKey/);});
