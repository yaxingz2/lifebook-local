import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeManuscriptStyle,manuscriptStyleInstructions} from '../src/writing-style.js';
import {generateManuscript,createManuscriptCaller,manuscriptSignature} from '../src/manuscript.js';
import {newBook} from '../src/storage.js';
import {turn,extractClaim,qwenChapter} from '../src/engine.js';

test('style changes rewrite existing sections and invalidate interrupted checkpoints',async()=>{
  const b=newBook('人生','');const t=turn('user','嗯，那时候我经常跟同学一起打球。');
  b.sessions=[{turns:[t]}];b.claims=[extractClaim(t)];
  const settings={mode:'qwen',model:'test',manuscriptStyle:'plain'};
  let writes=0,checkpoint;
  const call=async(stage,p)=>stage==='plan'?{groups:[{chapterTitle:'求学',sectionTitle:'同学',unitIds:p.evidence.map(u=>u.id)}]}:(writes++,{paragraphs:[{text:'那时候，我经常和同学一起打球。',unitIds:p.evidence.map(u=>u.id)}]});
  const first=await generateManuscript(b,settings,{call,save:async c=>{checkpoint=c;}});
  const saved={...b,chapters:first.chapters,manuscript:first.manuscript};
  assert.equal((await generateManuscript(saved,settings,{call})).noChange,true);assert.equal(writes,1);
  const changed={...settings,manuscriptStyle:'reflective'};
  assert.notEqual(manuscriptSignature(b,settings),manuscriptSignature(b,changed));
  const next=await generateManuscript(saved,changed,{checkpoint,call});
  assert.equal(writes,2);assert.equal(next.manuscript.manuscriptStyle,'reflective');
  assert.deepEqual(saved.chapters,first.chapters);
  const legacy=structuredClone(saved);legacy.manuscript.editorialVersion=2;delete legacy.manuscript.manuscriptStyle;
  await generateManuscript(legacy,settings,{call});assert.equal(writes,3);
});

test('both generation paths receive the selected style and mandatory oral cleanup',async()=>{
  const original=globalThis.fetch;const messages=[];
  globalThis.fetch=async(url,options)=>{const request=JSON.parse(options.body);messages.push(request.messages[0].content);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'{"paragraphs":[]}'}}]})};};
  try{
    for(const manuscriptStyle of ['plain','conversational','reflective']){
      const settings={mode:'qwen',model:'test',manuscriptStyle};
      await createManuscriptCaller(settings,'test')('write',{evidence:[]});
      const b=newBook('人生',''),t=turn('user','小时候喜欢打球。');b.sessions=[{turns:[t]}];b.claims=[extractClaim(t)];
      await qwenChapter(b,'故事',settings,'test');
      for(const prompt of messages.slice(-2)){assert.ok(prompt.includes(manuscriptStyleInstructions(manuscriptStyle)));assert.match(prompt,/删除无意义/);assert.match(prompt,/不得添加事实/);}
    }
    assert.equal(normalizeManuscriptStyle('unknown'),'plain');
  }finally{globalThis.fetch=original;}
});

test('personal preferences preserve legacy voices and never modify shared service settings',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lifebook-preferences-'));
  const oldRoot=process.env.LIFEBOOK_DATA_DIR,oldShared=process.env.LIFEBOOK_SHARED_CONFIG_DIR;
  process.env.LIFEBOOK_DATA_DIR=join(root,'alice');process.env.LIFEBOOK_SHARED_CONFIG_DIR=join(root,'shared');
  try{
    const storage=await import('../src/storage.js?preferences-isolation');
    await storage.saveSettings({mode:'qwen',model:'test'});
    const shared=await storage.getServiceSettings(),model=shared.qwenVoiceModel;
    const {voiceModels}=await import('../src/models.js');const voice=voiceModels[model].voices.at(-1);
    await storage.saveVoicePreferences({model,voice,speechRate:'fast'});
    assert.equal((await storage.getSettings()).manuscriptStyle,'plain');
    await storage.saveUserPreferences({manuscriptStyle:'reflective'});
    assert.equal((await storage.getSettings()).qwenVoices[model],voice);
    await storage.saveVoicePreferences({model,voice,speechRate:'slow'});
    assert.equal((await storage.getSettings()).manuscriptStyle,'reflective');
    await assert.rejects(storage.saveUserPreferences({manuscriptStyle:'invalid'}),/风格/);
    await assert.rejects(storage.saveUserPreferences({manuscriptStyle:'plain',model,voice:'invalid',speechRate:'slow'}),/音色/);
    assert.equal((await storage.getSettings()).manuscriptStyle,'reflective');
    assert.deepEqual(await storage.getServiceSettings(),shared);
    process.env.LIFEBOOK_DATA_DIR=join(root,'bob');
    const bob=await import('../src/storage.js?preferences-bob');
    assert.equal((await bob.getSettings()).manuscriptStyle,'plain');
  }finally{
    if(oldRoot===undefined)delete process.env.LIFEBOOK_DATA_DIR;else process.env.LIFEBOOK_DATA_DIR=oldRoot;
    if(oldShared===undefined)delete process.env.LIFEBOOK_SHARED_CONFIG_DIR;else process.env.LIFEBOOK_SHARED_CONFIG_DIR=oldShared;
    await rm(root,{recursive:true,force:true});
  }
});
