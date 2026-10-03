import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {storyEvidence,storyDescriptor,storyFingerprint} from '../src/story-content.js';

const dir=await mkdtemp(join(tmpdir(),'lifebook-story-titles-'));
process.env.LIFEBOOK_DATA_DIR=dir;
const {saveBook,getBook,updateBook,newBook,saveSettings,saveSecret,bookPath}=await import('../src/storage.js');
const {ensureStoryTitle,generateStoryTitle}=await import('../src/story-titles.js');
after(()=>rm(dir,{recursive:true,force:true}));
const user=(id,text,extra={})=>({id,role:'user',text,...extra});
const session=()=>({id:'s',focus:{stage:'不限阶段',theme:'成长经历'},turns:[{id:'a',role:'assistant',text:'你小时候是不是住在山上？'},user('u1','我今年22岁，正在读大学。'),user('u2','我想聊第一次离家上大学，爸爸陪我坐了一夜火车。')]});
const fixture=()=>({sessions:[session()],claims:[],avoidedTopics:[],chapters:[]});
const reply=value=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(value)}}]})});

test('legacy sessions use actual testimony, not their default focus or assistant suggestions',()=>{
  const book=fixture(),s=book.sessions[0],d=storyDescriptor(book,s);
  assert.notEqual(d.storyTitle,'成长经历');assert.equal(d.storyTitlePending,true);
  assert.equal(storyEvidence(book,s).length,2);assert.doesNotMatch(JSON.stringify(storyEvidence(book,s)),/住在山上/);
});
test('title evidence follows corrected claims and omits refused, excluded and disputed sources',()=>{
  const book=fixture(),s=book.sessions[0];
  book.claims=[{sourceTurnId:'u2',text:'妈妈陪我坐了一夜火车。',status:'confirmed'}];
  s.turns.push(user('skip','爷爷的秘密',{avoided:true}),user('excluded','高中往事',{excludedFromBook:true}),user('dispute','我什么时候说过住在山上？'));
  const text=JSON.stringify(storyEvidence(book,s));assert.match(text,/妈妈/);assert.doesNotMatch(text,/爸爸|爷爷|高中|山上/);
  book.avoidedTopics=[{topic:'妈妈'}];assert.equal(storyEvidence(book,s).length,1);
});
test('empty sessions stay empty and do not invent a story title',()=>{
  const book=fixture(),s=book.sessions[0];s.turns=s.turns.filter(t=>t.role==='assistant');
  const d=storyDescriptor(book,s);assert.equal(d.storyTitle,'还没聊到具体故事');assert.equal(d.storyTitlePending,false);
});
test('an acknowledgement alone cannot become an invented introduction or life story',()=>{
  const book=fixture(),s=book.sessions[0];s.turns=[user('u','嗯，都行。')];
  s.storySummary={title:'初次认识与自我介绍',fingerprint:storyFingerprint([{sourceTurnId:'u',text:'嗯，都行。'}])};
  const d=storyDescriptor(book,s);assert.equal(d.storyTitle,'还没聊到具体故事');assert.equal(d.storyTitlePending,false);
  s.turns.push(user('story','后来我和爸爸坐火车去上大学。'));assert.equal(storyEvidence(book,s).length,1);
});
test('model receives the whole short conversation, including its last topic, with source checks',async()=>{
  const evidence=storyEvidence(fixture(),session());let observed;
  const out=await generateStoryTitle(evidence,{mode:'qwen',qwenConnection:'unified'},'fixture',async(url,options)=>{observed=JSON.parse(options.body);return reply({title:'第一次离家上大学',sourceTurnIds:['u2']});});
  assert.equal(out.title,'第一次离家上大学');assert.deepEqual(JSON.parse(observed.messages[1].content).evidence,evidence);
  assert.match(observed.messages[0].content,/不能套用/);
});
test('generic titles, unsupported references and malformed replies are rejected',async()=>{
  const evidence=storyEvidence(fixture(),session()),settings={mode:'qwen',qwenConnection:'unified'};
  for(const value of [{title:'成长经历',sourceTurnIds:['u2']},{title:'从上海到北京',sourceTurnIds:['invented']},{title:'第一次离家',sourceTurnIds:[]}])await assert.rejects(generateStoryTitle(evidence,settings,'fixture',async()=>reply(value)));
});
test('long conversations cover every chronological chunk before choosing the final title',async()=>{
  const evidence=[{sourceTurnId:'early',text:'童年在河边玩。'.repeat(2500)},{sourceTurnId:'late',text:'后来第一次工作，搬去了深圳。'}];let requests=[];
  await generateStoryTitle(evidence,{mode:'qwen',qwenConnection:'unified'},'fixture',async(url,options)=>{
    const rows=JSON.parse(JSON.parse(options.body).messages[1].content).evidence;requests.push(rows);
    const ids=rows.flatMap(x=>x.sourceTurnIds||[x.sourceTurnId]);return reply({title:ids.includes('late')?'童年河边与初到深圳':'童年河边玩耍',sourceTurnIds:ids});
  });
  assert.ok(requests.length>2);assert.match(JSON.stringify(requests),/第一次工作/);assert.ok(requests.at(-1).some(x=>x.sourceTurnIds.includes('late')));
});

before(async()=>{await saveSettings({mode:'qwen',qwenConnection:'unified'});await saveSecret('fixture-key','qwen-unified');});
async function savedFixture() {const book={...newBook('测试故事',''),...fixture()};await saveBook(book);return book;}
test('generated titles persist without changing the content revision; repeat requests are cached',async()=>{
  const book=await savedFixture();let calls=0;
  const generate=async()=>{calls++;return {title:'第一次离家上大学',sourceTurnIds:['u2']};};
  await ensureStoryTitle(book.id,'s',{generate});await ensureStoryTitle(book.id,'s',{generate});
  const fresh=await getBook(book.id);assert.equal(fresh.sessions[0].storySummary.title,'第一次离家上大学');assert.equal(fresh.revision,book.revision);assert.equal(calls,1);
});
test('correction, rejection, exclusion and deletion erase stale derived titles from disk',async()=>{
  for(const mutate of [b=>{b.claims.push({sourceTurnId:'u2',text:'妈妈陪我回老家。',status:'confirmed'});},b=>{b.claims.push({sourceTurnId:'u2',text:b.sessions[0].turns.at(-1).text,status:'rejected'});},b=>{b.sessions[0].turns.at(-1).excludedFromBook=true;},b=>{b.sessions[0].turns.pop();}]) {
    const book=await savedFixture();await ensureStoryTitle(book.id,'s',{generate:async()=>({title:'爸爸送我去上大学',sourceTurnIds:['u2']})});
    await updateBook(book.id,mutate);assert.equal((await getBook(book.id)).sessions[0].storySummary,undefined);assert.doesNotMatch(await readFile(bookPath(book.id),'utf8'),/爸爸送我去上大学/);
  }
});
test('a source correction during generation wins over the late model result',async()=>{
  const book=await savedFixture();let finish,started;
  const ready=new Promise(resolve=>{started=resolve;});
  const generating=ensureStoryTitle(book.id,'s',{generate:()=>{started();return new Promise(resolve=>{finish=resolve;});}});
  await ready;await updateBook(book.id,b=>{b.sessions[0].turns.at(-1).text='妈妈陪我回老家。';});
  finish({title:'爸爸送我去上大学',sourceTurnIds:['u2']});await generating;
  assert.equal((await getBook(book.id)).sessions[0].storySummary,undefined);
});
test('overlapping requests for the same source snapshot share one generation',async()=>{
  const book=await savedFixture();let calls=0,finish,started;
  const ready=new Promise(resolve=>{started=resolve;});
  const generate=()=>{calls++;started();return new Promise(resolve=>{finish=resolve;});};
  const first=ensureStoryTitle(book.id,'s',{generate});await ready;const second=ensureStoryTitle(book.id,'s',{generate});
  await new Promise(resolve=>setTimeout(resolve,10));finish({title:'第一次离家上大学',sourceTurnIds:['u2']});await Promise.all([first,second]);assert.equal(calls,1);
});
