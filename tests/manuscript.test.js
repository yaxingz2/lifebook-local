import test from 'node:test';
import assert from 'node:assert/strict';
import {splitText,evidenceUnits,generateManuscript,createManuscriptCaller,INPUT_BUDGET,UNIT_BYTES} from '../src/manuscript.js';
import {newBook,digest} from '../src/storage.js';
import {turn,extractClaim} from '../src/engine.js';
const settings={mode:'qwen',model:'qwen3.8-flash',region:'cn-beijing',workspaceId:'test'};
function book(texts){const b=newBook('人生','');b.sessions=[{id:'test',turns:[]}];for(const text of texts)add(b,text);return b;}
function add(b,text){const t=turn('user',text);b.sessions[0].turns.push(t);b.claims.push(extractClaim(t));}
function fake(log=[],options={}){return async(stage,p)=>{
 log.push({stage,p:structuredClone(p)});
 if(stage==='plan')return {groups:p.evidence.map(u=>({existingSectionId:options.merge?p.directory.find(s=>s.chapterTitle===(u.text.includes('学校')?'求学':'生活'))?.id||'':'',chapterTitle:u.text.includes('学校')?'求学':'生活',sectionTitle:u.text.slice(0,12),unitIds:[u.id]}))};
 return {summary:p.evidence.map(u=>u.text).join('').slice(0,140),paragraphs:p.evidence.map(u=>({text:u.text,unitIds:[u.id]})),issues:[]};
};}
async function build(b,options={}){const out=await generateManuscript(b,settings,{call:fake(),...options});return {...b,chapters:out.chapters,manuscript:out.manuscript};}
test('splitting preserves all Unicode and punctuation including an enormous single paragraph',()=>{
 const text='\n小时候。😀'.repeat(2000)+'X'.repeat(8000);
 const chunks=splitText(text);assert.equal(chunks.join(''),text);assert.ok(chunks.length>10);assert.ok(chunks.every(c=>Buffer.byteLength(c)<=UNIT_BYTES));assert.ok(chunks.every(c=>!c.includes('\uFFFD')));
});
test('large books exceed old output/30 chapter caps while all source fragments remain covered',async()=>{
 const b=book(Array.from({length:40},(_,i)=>`学校故事${i}。`+'成长。'.repeat(220))),log=[];
 const out=await generateManuscript(b,settings,{call:fake(log)});
 assert.equal(out.manuscript.coverage.included,evidenceUnits(b).length);
 assert.equal(out.chapters.flatMap(c=>c.paragraphs).map(p=>p.text).join(''),b.claims.map(c=>c.text).join(''));
 assert.ok(out.manuscript.sections.length>=40);
 assert.ok(log.every(({p})=>Buffer.byteLength(JSON.stringify(p))<INPUT_BUDGET));
});
test('no changes means zero model calls; adding a story only updates its matching section',async()=>{
 let b=await build(book(['学校旁边有条小河。','第一次工作的故事。']));const old=structuredClone(b.chapters);
 const idle=await generateManuscript(b,settings,{call:()=>{throw Error('must not call');}});assert.equal(idle.noChange,true);
 add(b,'学校旁边的小河冬天结冰。');const log=[];
 const out=await generateManuscript(b,settings,{call:fake(log,{merge:true})});
 assert.equal(log.filter(x=>x.stage==='write').length,1);
 assert.deepEqual(out.chapters.find(c=>c.title==='生活'),old.find(c=>c.title==='生活'));
 assert.equal(out.manuscript.coverage.included,3);
});
test('edits and removal refresh affected text and summaries, including deletion of all evidence',async()=>{
 const b=await build(book(['学校在北京。','工作在上海。']));b.claims[0].text='学校在天津。';b.chapters.find(c=>c.title==='求学').invalidated=true;
 const log=[],out=await generateManuscript(b,settings,{call:fake(log)});
 assert.equal(log.filter(x=>x.stage==='write').length,1);assert.match(out.chapters.find(c=>c.title==='求学').paragraphs[0].text,/天津/);
 const changed={...b,chapters:out.chapters,manuscript:out.manuscript};changed.claims=[];
 const empty=await generateManuscript(changed,settings,{call:()=>{throw Error('must not call');}});assert.deepEqual(empty.chapters,[]);assert.equal(empty.manuscript.coverage.total,0);
});
test('failure checkpoint resumes completed work, while edited evidence invalidates saved work',async()=>{
 const b=book(['学校的故事。','工作的故事。']);let checkpoint;let writes=0;const base=fake();
 await assert.rejects(generateManuscript(b,settings,{save:async c=>{checkpoint=c;},call:async(stage,p)=>{if(stage==='write'&&++writes===2)throw Error('offline');return base(stage,p);}}),/offline/);
 const log=[];const out=await generateManuscript(b,settings,{checkpoint,call:fake(log)});assert.equal(log.filter(x=>x.stage==='plan').length,0);assert.equal(log.filter(x=>x.stage==='write').length,1);assert.equal(out.manuscript.coverage.included,2);
 b.claims[0].text='已修正的学校故事。';const changed=[];await generateManuscript(b,settings,{checkpoint,call:fake(changed)});assert.ok(changed.some(x=>x.stage==='plan'));assert.equal(changed.filter(x=>x.stage==='write').length,2);
});
test('truncated output splits batches without losing source units; unknown citations fail closed',async()=>{
 const b=book(['学校故事甲。','学校故事乙。']);const base=fake([],{merge:true});
 const call=async(stage,p)=>{if(stage==='plan')return {groups:[{chapterTitle:'求学',sectionTitle:'在校时光',unitIds:p.evidence.map(u=>u.id)}]};if(p.evidence.length>1)throw Object.assign(Error('truncated'),{split:true});return base(stage,p);};
 const out=await generateManuscript(b,settings,{call});assert.equal(out.manuscript.sections.length,2);assert.equal(out.manuscript.coverage.included,2);
 await assert.rejects(generateManuscript(book(['学校。']),settings,{call:async(stage,p)=>stage==='plan'?base(stage,p):{paragraphs:[{text:'编造内容',unitIds:['unknown']}]} }),/无效来源/);
});
test('missing coverage cannot silently publish a partial book',async()=>{
 const b=book(['学校甲。','学校乙。']);const base=fake();
 await assert.rejects(generateManuscript(b,settings,{call:async(stage,p)=>stage==='plan'?{groups:[{chapterTitle:'学校',sectionTitle:'学校',unitIds:p.evidence.map(u=>u.id)}]}:{paragraphs:[]} }),/没有返回正文/);
 assert.deepEqual(b.chapters,[]);
});
test('manually changed prose is preserved and blocks automatic overwrite',async()=>{
 const b=await build(book(['学校。']));b.chapters[0].paragraphs[0].text='本人修改过的文稿';
 await assert.rejects(generateManuscript(b,settings,{call:fake()}),/手动修改/);assert.equal(b.chapters[0].paragraphs[0].text,'本人修改过的文稿');
});
test('transport bounds full prompt and detects length finish reason instead of accepting partial JSON',async()=>{
 const original=globalThis.fetch;let requests=0;
 try{
 globalThis.fetch=async(url,opts)=>{requests++;const b=JSON.parse(opts.body);assert.equal(b.enable_thinking,false);assert.ok(Buffer.byteLength(JSON.stringify(b.messages))+512<=INPUT_BUDGET);return {ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'{}'}}]})};};
 const call=createManuscriptCaller(settings,'test');await assert.rejects(call('write',{evidence:'x'.repeat(INPUT_BUDGET)}),e=>e.split===true);assert.equal(requests,0);
 await assert.rejects(call('write',{evidence:'短文'}),e=>e.split===true);assert.equal(requests,1);
 }finally{globalThis.fetch=original;}
});

test('single-fragment output truncation recursively splits text without dropping content',async()=>{
 const text='在学校学习。'.repeat(70),b=book([text]),base=fake();
 const out=await generateManuscript(b,settings,{call:async(stage,p)=>{if(stage==='write'&&Buffer.byteLength(p.evidence[0].text)>500)throw Object.assign(Error('length'),{split:true});return base(stage,p);}});
 assert.equal(out.chapters.flatMap(c=>c.paragraphs).map(p=>p.text).join(''),text);
});
test('full organization is explicit and ordinary updates preserve more than thirty chapters',async()=>{
 const b=book(Array.from({length:35},(_,i)=>`经历${i}。`)),base=fake();
 const call=async(stage,p)=>stage==='plan'?{groups:p.evidence.map(u=>({chapterTitle:u.text,sectionTitle:u.text,unitIds:[u.id]}))}:base(stage,p);
 const first=await generateManuscript(b,settings,{call});assert.equal(first.chapters.length,35);
 const saved={...b,chapters:first.chapters,manuscript:first.manuscript};
 const idle=await generateManuscript(saved,settings,{call:()=>{throw Error('must not call');}});assert.equal(idle.noChange,true);
 let count=0;await generateManuscript(saved,{...settings,reorganize:true},{call:async(...args)=>{count++;return call(...args);}});assert.ok(count>35);
});
test('directory paging can find a matching story beyond the first page',async()=>{
 const b=book(Array.from({length:25},(_,i)=>`学校经历${i}。`+'细节'.repeat(60))),base=fake();
 let saved=await build(b);const target=saved.manuscript.sections.at(-1).id;add(saved,'补充最后一段经历。');let pageCalls=0;
 const out=await generateManuscript(saved,settings,{call:async(stage,p)=>{
  if(stage==='write')return base(stage,p);pageCalls++;
  return {groups:[{existingSectionId:p.directory.some(s=>s.id===target)?target:'',chapterTitle:'其他',sectionTitle:'补充',unitIds:p.evidence.map(u=>u.id)}]};
 }});
 assert.ok(pageCalls>1);assert.ok(out.manuscript.sections.find(s=>s.id===target).unitIds.includes(evidenceUnits(saved).at(-1).id));
});

test('internal citation markers are removed while ordinary brackets remain',async()=>{
 const b=book(['我小时候在学校骑车。']);
 const out=await generateManuscript(b,settings,{call:async(stage,p)=>stage==='plan'?{groups:[{chapterTitle:'童年',sectionTitle:'骑车',unitIds:p.evidence.map(u=>u.id)}]}:{summary:'骑车',paragraphs:p.evidence.map(u=>({text:`我在学校骑车[${u.id}]，那是[1998年]。`,unitIds:[u.id]}))}});
 assert.equal(out.chapters[0].paragraphs[0].text,'我在学校骑车，那是[1998年]。');
});
test('unclear fragments remain reviewable but never become manuscript chapters',async()=>{
 const b=book(['Oh, Yeruk.']);
 const out=await generateManuscript(b,settings,{call:async(stage,p)=>{assert.equal(stage,'plan');return {groups:[{chapterTitle:'待归类',sectionTitle:'不明片段',pending:true,reason:'请确认原话',unitIds:p.evidence.map(u=>u.id)}]};}});
 assert.deepEqual(out.chapters,[]);assert.equal(out.manuscript.coverage.pending,1);assert.equal(out.manuscript.pending[0].text,'Oh, Yeruk.');
});
test('reporting voice is retried as first person',async()=>{
 const b=book(['我在学校骑车。']);let writes=0;
 const out=await generateManuscript(b,settings,{call:async(stage,p)=>stage==='plan'?{groups:[{chapterTitle:'童年',sectionTitle:'骑车',unitIds:p.evidence.map(u=>u.id)}]}:{summary:'骑车',paragraphs:p.evidence.map(u=>({text:++writes===1?'叙述者骑车。':'我在学校骑车。',unitIds:[u.id]}))}});
 assert.equal(writes,2);assert.equal(out.chapters[0].paragraphs[0].text,'我在学校骑车。');
});

test('long stories have one heading, continuous context, and reusable hidden batches',async()=>{
 const b=book(Array.from({length:10},(_,i)=>`学校经历${i}。`+'一起打球。'.repeat(100))),log=[];
 const call=async(stage,p)=>{
  log.push({stage,p});
  if(stage==='plan')return {groups:[{existingSectionId:p.directory[0]?.id||'',chapterTitle:'求学时光',sectionTitle:'高中那些年',unitIds:p.evidence.map(u=>u.id)}]};
  return {summary:'同学一起打球的经历',paragraphs:p.evidence.map(u=>({text:u.text,unitIds:[u.id]}))};
 };
 const first=await generateManuscript(b,settings,{call});
 assert.ok(first.manuscript.sections.length>1);
 assert.ok(first.manuscript.sections.every(s=>s.title==='高中那些年'));
 assert.equal(first.chapters[0].paragraphs.filter(p=>p.sectionTitle).length,1);
 assert.equal(first.chapters[0].paragraphs.map(p=>p.text).join(''),b.claims.map(c=>c.text).join(''));
 const writes=log.filter(x=>x.stage==='write');assert.equal(writes[0].p.storyContext.continuing,false);
 assert.ok(writes.slice(1).every(x=>x.p.storyContext.continuing&&x.p.storyContext.previousSummary));
 assert.equal(writes.at(-1).p.storyContext.finalBatch,true);
 const saved={...b,chapters:first.chapters,manuscript:first.manuscript};
 const idle=await generateManuscript(saved,settings,{call:()=>{throw Error('unchanged stories must be reused');}});assert.equal(idle.noChange,true);
 add(saved,'多年以后还和高中同学联系。');const updateLog=[];
 await generateManuscript(saved,settings,{call:async(stage,p)=>{updateLog.push({stage,p});return call(stage,p);}});
 assert.equal(updateLog.find(x=>x.stage==='plan').p.directory.length,1);
});

test('provider-driven splitting does not create continuation headings or repeat work next update',async()=>{
 const b=book(['学校故事甲。','学校故事乙。']);
 const call=async(stage,p)=>{
  if(stage==='plan')return {groups:[{chapterTitle:'求学',sectionTitle:'高中',unitIds:p.evidence.map(u=>u.id)}]};
  if(p.evidence.length>1)throw Object.assign(Error('truncated'),{split:true});
  return {summary:'高中往事',paragraphs:p.evidence.map(u=>({text:u.text,unitIds:[u.id]}))};
 };
 const result=await generateManuscript(b,settings,{call});
 assert.equal(result.manuscript.sections.length,2);assert.equal(result.chapters[0].paragraphs.filter(p=>p.sectionTitle).length,1);
 assert.ok(result.manuscript.sections.every(s=>s.title==='高中'));
 const saved={...b,chapters:result.chapters,manuscript:result.manuscript};
 assert.equal((await generateManuscript(saved,settings,{call:()=>{throw Error('must reuse successful small batches');}})).noChange,true);
});

test('editorial upgrade regroups old fragments and preserves unrelated stories and source coverage',async()=>{
 const b=await build(book(['学校压力很大。','学校同学一起打球。','第一次工作的经历。']));
 b.manuscript.editorialVersion=3;b.manuscript.sections[1].title+='（续1）';
 const original=structuredClone(b.chapters);let plans=0;
 const result=await generateManuscript(b,settings,{call:async(stage,p)=>{
  if(stage==='plan'){plans++;return {groups:[{chapterTitle:'求学',sectionTitle:'高中那些年',unitIds:p.evidence.filter(u=>u.text.includes('学校')).map(u=>u.id)},{chapterTitle:'工作',sectionTitle:'初入职场',unitIds:p.evidence.filter(u=>!u.text.includes('学校')).map(u=>u.id)}]};}
  return {paragraphs:[{text:p.evidence.map(u=>u.text).join(''),unitIds:p.evidence.map(u=>u.id)}]};
 }});
 assert.ok(plans>0);assert.equal(result.manuscript.sections.length,2);assert.equal(result.manuscript.coverage.included,3);
 assert.deepEqual(b.chapters,original);
 assert.equal(result.chapters[0].paragraphs[0].sourceTurnIds.length,2);
 assert.ok(result.chapters.every(c=>c.paragraphs.every(p=>!p.sectionTitle?.includes('续1'))));
});


test('narrative orders chapters and stories without pinning overview and caches unchanged work',async()=>{
 const b=book(['研究生项目。','大学生活。','高中打球。','我叫小张。']);const names=['研究生阶段','求学时光','求学时光','个人概况'];let requests=0;
 const call=async(stage,p)=>stage==='plan'?{groups:p.evidence.map((u,i)=>({chapterTitle:names[i],sectionTitle:u.text,unitIds:[u.id]}))}:{summary:p.evidence[0].text,paragraphs:p.evidence.map(u=>({text:u.text,unitIds:[u.id]}))};
 const order=async p=>{requests++;const ranks=p.scope==='全书章节'?['求学时光','研究生阶段','个人概况']:['高中打球。','大学生活。'];return {orderIds:[...p.outline].sort((a,b)=>ranks.indexOf(a.title)-ranks.indexOf(b.title)).map(x=>x.id)};};
 const result=await generateManuscript(b,settings,{call,order});
 assert.deepEqual(result.chapters.map(c=>c.title),['求学时光','研究生阶段','个人概况']);assert.deepEqual(result.chapters[0].paragraphs.map(p=>p.text),['高中打球。','大学生活。']);assert.equal(requests,2);assert.equal(result.manuscript.coverage.included,4);
 const saved={...b,chapters:result.chapters,manuscript:result.manuscript};
 assert.equal((await generateManuscript(saved,settings,{call:()=>{throw Error('reuse prose');},order:()=>{throw Error('reuse order');}})).noChange,true);
 delete saved.manuscript.narrativeOrderFingerprint;
 const again=await generateManuscript(saved,settings,{call:()=>{throw Error('reuse prose');},order});assert.equal(again.written,0);assert.deepEqual(again.chapters,result.chapters);
});
test('invalid order preserves original and resumes completed prose',async()=>{
 const b=book(['学校打球。','工作出差。']),original=structuredClone(b);let checkpoint;
 await assert.rejects(generateManuscript(b,settings,{call:fake(),save:async x=>{checkpoint=x;},order:async p=>({orderIds:[p.outline[0].id,p.outline[0].id]})}),/目录排序/);assert.deepEqual(b,original);
 const resumed=await generateManuscript(b,settings,{checkpoint,call:()=>{throw Error('reuse');},order:async p=>({orderIds:p.outline.map(x=>x.id).reverse()})});assert.equal(resumed.written,0);assert.equal(resumed.manuscript.coverage.included,2);
});
test('large outlines retain every chapter within bounded requests',async()=>{
 const b=book(Array.from({length:35},(_,i)=>`阶段${String(34-i).padStart(2,'0')}。`+'经历。'.repeat(100)));let calls=0;
 const result=await generateManuscript(b,settings,{call:async(stage,p)=>stage==='plan'?{groups:p.evidence.map(u=>({chapterTitle:u.text.slice(0,4),sectionTitle:u.text.slice(0,4),unitIds:[u.id]}))}:{summary:p.evidence[0].text.slice(0,100),paragraphs:p.evidence.map(u=>({text:u.text,unitIds:[u.id]}))},order:async p=>{calls++;assert.ok(Buffer.byteLength(JSON.stringify(p))<INPUT_BUDGET-3000);return {orderIds:[...p.outline].sort((a,b)=>a.title.localeCompare(b.title)).map(x=>x.id)};}});
 assert.ok(calls>1);assert.equal(result.chapters.length,35);assert.equal(result.chapters[0].title,'阶段00');assert.equal(result.chapters.at(-1).title,'阶段34');assert.equal(result.manuscript.coverage.included,35);
});
