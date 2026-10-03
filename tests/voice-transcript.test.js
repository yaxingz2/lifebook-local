import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceTranscript} from '../public/voice-transcript.js';
const create=(v,id)=>v.event({type:'response.created',response:{id}});
const delta=(v,id,text)=>v.event({type:'response.output_audio_transcript.delta',response_id:id,delta:text});
const finish=(v,id,status='completed')=>v.event({type:'response.done',response:{id,status}});
test('assistant text previews stream before completion and reconcile only with saved turns',()=>{
  const v=new VoiceTranscript();create(v,'one');delta(v,'one','你好');delta(v,'one','，欢迎。');
  assert.equal(v.visible()[0].text,'你好，欢迎。');assert.equal(v.visible()[0].complete,false);
  v.event({type:'response.audio_transcript.done',response_id:'one',transcript:'你好，欢迎。'});finish(v,'one');
  create(v,'two');delta(v,'two','你的故事');assert.equal(v.visible().length,2);
  v.reconcile([{role:'assistant',providerResponseId:'one',text:'你好，欢迎。'}]);
  assert.deepEqual(v.visible().map(t=>t.text),['你的故事']);
});
test('interrupted drafts disappear; late deltas cannot resurrect a cancelled response',()=>{
  const v=new VoiceTranscript();create(v,'one');delta(v,'one','未讲完');v.event({type:'input_audio_buffer.speech_started'});
  delta(v,'one','旧消息');finish(v,'one','cancelled');assert.equal(v.visible().length,0);
  create(v,'two');delta(v,'two','新回答');finish(v,'one','cancelled');assert.equal(v.visible()[0].text,'新回答');
});
test('completed preview survives user speech and saved identical historical text does not remove a live draft',()=>{
  const v=new VoiceTranscript();create(v,'one');delta(v,'one','你好');
  v.reconcile([{role:'assistant',text:'你好'}]);assert.equal(v.visible().length,1);
  finish(v,'one');v.event({type:'input_audio_buffer.speech_started'});assert.equal(v.visible().length,1);
});

test('saved and live rows keep speech order when user ASR and assistant writes arrive late',()=>{
  const v=new VoiceTranscript();const history={id:'old',role:'assistant',text:'历史'};
  create(v,'opening');delta(v,'opening','开场');finish(v,'opening');
  v.event({type:'input_audio_buffer.speech_started',item_id:'u1'});
  create(v,'a1');delta(v,'a1','回答');finish(v,'a1');
  // The server saves the answer before ASR completes.
  const answer={id:'saved-answer',role:'assistant',providerResponseId:'a1',text:'回答'};
  assert.deepEqual(v.rows([history,answer]).map(t=>t.text),['历史','开场','回答']);
  v.event({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'问题'});
  assert.deepEqual(v.rows([history,answer]).map(t=>t.text),['历史','开场','问题','回答']);
  const user={id:'saved-user',role:'user',providerItemId:'u1',text:'问题'};
  const opening={id:'saved-opening',role:'assistant',providerResponseId:'opening',text:'开场'};
  assert.deepEqual(v.rows([history,opening,user,answer]).map(t=>t.text),['历史','开场','问题','回答']);
  assert.equal(v.rows([history,opening,user,answer]).filter(t=>t.preview).length,0);
});
test('Qwen interrupted text stays in its turn and late old events cannot alter the next answer',()=>{
  const v=new VoiceTranscript({preserveInterrupted:true});create(v,'a1');delta(v,'a1','已经显示的前半句');
  v.event({type:'input_audio_buffer.speech_started',item_id:'u1'});
  create(v,'a2');delta(v,'a2','新回答');delta(v,'a1','不应追加');finish(v,'a1','cancelled');
  assert.deepEqual(v.visible().map(t=>t.text),['已经显示的前半句','新回答']);assert.equal(v.visible()[0].interrupted,true);
  v.event({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'等等'});
  assert.deepEqual(v.rows([]).map(t=>t.text),['已经显示的前半句','等等','新回答']);
});
test('Qwen cancel-before-speech preview reconciles with saved partial text and correction',()=>{
  const v=new VoiceTranscript({preserveInterrupted:true});create(v,'partial');delta(v,'partial','你妈妈教你做饭');
  finish(v,'partial','cancelled');v.event({type:'input_audio_buffer.speech_started',item_id:'correction'});
  create(v,'corrected');delta(v,'corrected','是外婆，我记下了。');finish(v,'corrected');
  delta(v,'partial','不应追加');finish(v,'partial','cancelled');
  v.event({type:'conversation.item.input_audio_transcription.completed',item_id:'correction',transcript:'不是妈妈，是外婆。'});
  const saved=[
    {role:'assistant',providerResponseId:'partial',text:'你妈妈教你做饭',interrupted:true},
    {role:'user',providerItemId:'correction',text:'不是妈妈，是外婆。'},
    {role:'assistant',providerResponseId:'corrected',text:'是外婆，我记下了。'},
  ];
  assert.deepEqual(v.rows(saved).map(t=>t.text),saved.map(t=>t.text));
  assert.equal(v.rows(saved).length,3);assert.ok(!v.rows(saved).some(t=>t.preview));
  assert.deepEqual(new VoiceTranscript({preserveInterrupted:true}).rows(saved).map(t=>t.text),saved.map(t=>t.text));
});
test('identical historical greeting never removes a new completed greeting',()=>{
  const v=new VoiceTranscript();create(v,'new');delta(v,'new','你好');finish(v,'new');
  assert.equal(v.rows([{role:'assistant',text:'你好'}]).length,2);
});

test('live visual identity survives provider ID assignment and persistence',()=>{
  const v=new VoiceTranscript();create(v);delta(v,undefined,'你好');
  const key=v.rows([])[0].uiKey;
  delta(v,'provider-one','，欢迎');assert.equal(v.rows([])[0].uiKey,key);
  const saved={id:'saved-one',role:'assistant',providerResponseId:'provider-one',text:'你好，欢迎'};
  assert.equal(v.rows([saved])[0].uiKey,key);
  const next=new VoiceTranscript();create(next);delta(next,undefined,'下一次');
  assert.notEqual(next.rows([])[0].uiKey,key);
});
