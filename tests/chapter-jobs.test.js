import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'lifebook-jobs-'));
process.env.LIFEBOOK_DATA_DIR=dir;
const store=await import('../src/storage.js');
const jobs=await import('../src/chapter-jobs.js');
const engine=await import('../src/engine.js');
async function done(id){for(let i=0;i<100;i++){const job=(await jobs.listChapterJobs()).find(j=>j.id===id);if(['completed','failed'].includes(job.status))return job;await new Promise(r=>setTimeout(r,10));}throw Error('job timeout');}
async function book(){const b=store.newBook('测试书','');const t=engine.turn('user','小时候住在学校旁边。');b.sessions.push({id:'session',turns:[t]});b.claims.push(engine.extractClaim(t));await store.saveBook(b);return b;}
test('background jobs survive page reload, deduplicate, and preserve new stories',async()=>{
 const b=await book();let release;const gate=new Promise(r=>release=r);
 const j=await jobs.startChapterJob(b.id,'童年',async snapshot=>{await gate;return engine.createChapter(snapshot,'童年');});
 const duplicate=await jobs.startChapterJob(b.id,'童年');assert.equal(duplicate.id,j.id);
 assert.equal((await jobs.listChapterJobs()).find(x=>x.id===j.id).title,'童年');
 await store.updateBook(b.id,current=>{const t=engine.turn('user','后来搬到了城市。');current.sessions[0].turns.push(t);current.claims.push(engine.extractClaim(t));});release();
 assert.equal((await done(j.id)).status,'completed');const saved=await store.getBook(b.id);assert.equal(saved.chapters.length,1);assert.equal(saved.claims.length,2);
 await jobs.dismissChapterJob(j.id);assert.equal((await jobs.listChapterJobs()).some(x=>x.id===j.id),false);
});
test('edits during writing reject stale draft; failures are visible and retryable',async()=>{
 const b=await book();let release;const gate=new Promise(r=>release=r);
 const j=await jobs.startChapterJob(b.id,'童年',async snapshot=>{await gate;return engine.createChapter(snapshot,'童年');});
 await store.updateBook(b.id,current=>{current.claims[0].text='修正后的事实';});release();
 assert.equal((await done(j.id)).status,'failed');assert.equal((await store.getBook(b.id)).chapters.length,0);
 const retry=await jobs.startChapterJob(b.id,'童年');assert.notEqual(retry.id,j.id);assert.equal((await done(retry.id)).status,'completed');
});
test('service restart exposes interrupted job instead of an endless spinner',async()=>{
 const all=await store.readChapterJobs();all.push({id:'interrupted',owner:'old-server',status:'writing'});await store.writeChapterJobs(all);
 assert.equal((await jobs.listChapterJobs()).find(j=>j.id==='interrupted').status,'failed');
});
test.after(async()=>{await rm(dir,{recursive:true,force:true});});

test('update replaces duplicate drafts and restoration preserves both versions',async()=>{
 const b=await book();await store.updateBook(b.id,current=>{current.chapters=[engine.createChapter(current,'2'),engine.createChapter(current,'3')];});
 const job=await jobs.startChapterJob(b.id,'整本书',undefined,'update');assert.equal((await done(job.id)).status,'completed');
 let saved=await store.getBook(b.id);assert.equal(saved.chapters.length,1);assert.equal(saved.manuscriptVersions[0].chapters.length,2);
 await jobs.restoreManuscript(b.id,saved.manuscriptVersions[0].id);saved=await store.getBook(b.id);assert.equal(saved.chapters.length,2);assert.equal(saved.manuscriptVersions.length,2);
 await store.updateBook(b.id,current=>{current.claims[0].text='已纠正';});
 await assert.rejects(jobs.restoreManuscript(b.id,saved.manuscriptVersions[1].id),/修改或删除/);
});
test('empty update preserves original manuscript',async()=>{
 const b=await book();await store.updateBook(b.id,current=>{current.chapters=[engine.createChapter(current,'原稿')];});
 const job=await jobs.startChapterJob(b.id,'更新',async()=>({paragraphs:[]}), 'update');assert.equal((await done(job.id)).status,'failed');
 const saved=await store.getBook(b.id);assert.equal(saved.chapters[0].title,'原稿');assert.equal(saved.manuscriptVersions,undefined);
});

test('AI update creates multiple titled chapters and replaces previous manuscript atomically',async()=>{
 const b=await book();await store.updateBook(b.id,current=>{current.chapters=[engine.createChapter(current,'旧稿')];});
 const originalFetch=globalThis.fetch;
 try{
  globalThis.fetch=async(url,options)=>{const request=JSON.parse(options.body);assert.match(request.messages[0].content,/不要按聊天次数机械分章/);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({chapters:[{title:'学校旁的童年',paragraphs:[{text:'小时候住在学校旁边。',sourceTurnIds:[b.claims[0].sourceTurnId]}]},{title:'另一段往事',paragraphs:[{text:'测试段落。',sourceTurnIds:[b.claims[0].sourceTurnId]}]}]})}}]})};};
  const j=await jobs.startChapterJob(b.id,'书名',snapshot=>engine.qwenChapter(snapshot,'书名',{mode:'qwen',region:'ap-southeast-1',workspaceId:'test',model:'test'},'test',true),'update');
  assert.equal((await done(j.id)).status,'completed');const saved=await store.getBook(b.id);assert.deepEqual(saved.chapters.map(c=>c.title),['学校旁的童年','另一段往事']);assert.equal(saved.manuscriptVersions[0].chapters[0].title,'旧稿');
 }finally{globalThis.fetch=originalFetch;}
});

test('incremental job saves checkpoints, retries without rewriting completed sections, and restores metadata',async()=>{
 const b=await book();await store.updateBook(b.id,x=>{const t=engine.turn('user','我后来在工厂工作。');x.sessions[0].turns.push(t);x.claims.push(engine.extractClaim(t));});
 const oldSettings=await store.getSettings(),oldFetch=globalThis.fetch;let writes=0,breakSecond=true;
 try{
  await store.saveSettings({...oldSettings,mode:'qwen',region:'cn-beijing',workspaceId:'test',model:'qwen3.8-flash'});await store.saveSecret('test','qwen','cn-beijing');
  globalThis.fetch=async(url,opts)=>{const p=JSON.parse(JSON.parse(opts.body).messages[1].content);let content;
   if('outline' in p)content={orderIds:p.outline.map(x=>x.id)};
    else if('directory' in p)content={groups:p.evidence.map((u,i)=>({chapterTitle:'测试章'+i,sectionTitle:'故事'+i,unitIds:[u.id]}))};
   else {writes++;if(breakSecond&&writes===2)throw Error('network failure');content={summary:'测试概况',paragraphs:p.evidence.map(u=>({text:u.text,unitIds:[u.id]}))};}
   return {ok:true,json:async()=>({usage:{prompt_tokens:100,completion_tokens:50},choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}]})};
  };
  const first=await jobs.startChapterJob(b.id,'测试',undefined,'update');assert.equal((await done(first.id)).status,'failed');assert.equal((await store.getBook(b.id)).chapters.length,0);
  assert.ok(await store.readManuscriptProgress(b.id));assert.equal((await jobs.manuscriptPreview(b.id)).chapters.length,1);
  breakSecond=false;const retry=await jobs.retryChapterJob(first.id);assert.equal((await done(retry.id)).status,'completed');assert.equal(writes,3);
  let saved=await store.getBook(b.id);assert.equal(saved.chapters.length,2);assert.equal(saved.manuscript.coverage.included,2);assert.equal(await store.readManuscriptProgress(b.id),null);
  const idle=await jobs.startChapterJob(b.id,'测试',undefined,'update');assert.equal((await done(idle.id)).noChange,true);assert.equal(writes,3);
  await store.updateBook(b.id,x=>{x.claims[0].text='修正后的学校故事。';engine.invalidate(x,x.claims[0].sourceTurnId);});
  const changed=await jobs.startChapterJob(b.id,'测试',undefined,'update');assert.equal((await done(changed.id)).status,'completed');assert.equal(writes,4);
  saved=await store.getBook(b.id);assert.ok(saved.manuscriptVersions.at(-1).manuscript);
 }finally{globalThis.fetch=oldFetch;await store.saveSettings(oldSettings);}
});

test('source correction during an incremental provider call cannot publish stale prose',async()=>{
 const b=await book(),oldSettings=await store.getSettings(),oldFetch=globalThis.fetch;
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 try{
  await store.saveSettings({...oldSettings,mode:'qwen',region:'cn-beijing',workspaceId:'test',model:'qwen3.8-flash'});await store.saveSecret('test','qwen','cn-beijing');
  globalThis.fetch=async(url,opts)=>{const p=JSON.parse(JSON.parse(opts.body).messages[1].content);entered();await gate;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({groups:[{chapterTitle:'童年',sectionTitle:'故事',unitIds:p.evidence.map(u=>u.id)}]})}}]})};};
  const j=await jobs.startChapterJob(b.id,'测试',undefined,'update');await started;
  await store.updateBook(b.id,x=>{x.claims[0].text='已经修正';});release();
  const result=await done(j.id);assert.equal(result.status,'failed');assert.match(result.error,/修改/);assert.equal((await store.getBook(b.id)).chapters.length,0);
 }finally{release?.();globalThis.fetch=oldFetch;await store.saveSettings(oldSettings);}
});

test('usage counts one successful background job, excludes failure and survives dismissal',async()=>{
 const {readAccountUsage,summarizeAccountUsage}=await import('../src/account-usage.js');
 const before=summarizeAccountUsage(await readAccountUsage(dir)).generationCount;
 const b=await book();const good=await jobs.startChapterJob(b.id,'计数',snapshot=>engine.createChapter(snapshot,'计数'));
 assert.equal((await done(good.id)).status,'completed');
 for(let i=0;i<100;i++){if((await readAccountUsage(dir))?.generations[good.id])break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(summarizeAccountUsage(await readAccountUsage(dir)).generationCount,before+1);
 await jobs.dismissChapterJob(good.id);
 const bad=await jobs.startChapterJob(b.id,'失败',()=>{throw new Error('test failure');});assert.equal((await done(bad.id)).status,'failed');
 assert.equal(summarizeAccountUsage(await readAccountUsage(dir)).generationCount,before+1);
});

test('permanent book deletion erases completed and in-flight task content without resurrecting it',async()=>{
 const keep=await book(),deleted=await book();
 await store.updateBook(deleted.id,b=>{b.title='SYNTHETIC_PRIVATE_BOOK_TITLE';});
 const complete=await jobs.startChapterJob(deleted.id,'SYNTHETIC_PRIVATE_JOB_TITLE');assert.equal((await done(complete.id)).status,'completed');
 const unrelated=await jobs.startChapterJob(keep.id,'Surviving job');await done(unrelated.id);
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const pending=await jobs.startChapterJob(deleted.id,'SYNTHETIC_PRIVATE_PENDING',async snapshot=>{entered();await gate;return engine.createChapter(snapshot,'SYNTHETIC_PRIVATE_RESULT');});
 await started;await store.removeBook(deleted.id,'SYNTHETIC_PRIVATE_BOOK_TITLE');
 assert.equal(await store.existsBook(deleted.id),false);
 assert.ok(!(await store.readChapterJobs()).some(j=>j.bookId===deleted.id));
 release();await new Promise(r=>setTimeout(r,50));
 const remaining=await store.readChapterJobs();assert.ok(!JSON.stringify(remaining).includes('SYNTHETIC_PRIVATE'));
 assert.ok(remaining.some(j=>j.id===unrelated.id));assert.ok(!remaining.some(j=>j.id===pending.id));
 await assert.rejects(jobs.startChapterJob(deleted.id,'Late request'),e=>e.status===404);
});

test('listing jobs erases orphaned titles retained by earlier app versions',async()=>{
 const records=await store.readChapterJobs();const missing=store.newBook('Missing','');
 records.push({id:'legacy-orphan',bookId:missing.id,status:'failed',title:'SYNTHETIC_ORPHAN_PRIVATE_TITLE',progress:{currentTitle:'SYNTHETIC_ORPHAN_PRIVATE_TITLE'}});
 await store.writeChapterJobs(records);await jobs.listChapterJobs();
 assert.ok(!JSON.stringify(await store.readChapterJobs()).includes('SYNTHETIC_ORPHAN_PRIVATE_TITLE'));
});

