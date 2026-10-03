import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
const dir=await mkdtemp(join(tmpdir(),'lifebook-backup-delete-'));
process.env.LIFEBOOK_DATA_DIR=dir;
const store=await import('../src/storage.js');
const engine=await import('../src/engine.js');
const jobs=await import('../src/chapter-jobs.js');
const {generateManuscript}=await import('../src/manuscript.js');
const {createApp}=await import('../src/server.js');
let server,url,token;
test.before(async()=>{server=createApp();await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}`;token=(await(await fetch(url+'/api/bootstrap')).json()).token;});
test.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
async function api(path,method='GET',data){const res=await fetch(url+path,{method,headers:{Origin:url,'X-LifeBook-Token':token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const text=await res.text();let body;try{body=JSON.parse(text);}catch{body=text;}return {status:res.status,body,text};}
function fixture(texts){const b=store.newBook('测试书',''),s={id:randomUUID(),turns:[]};b.sessions.push(s);for(const text of texts){const t=engine.turn('user',text);s.turns.push(t);b.claims.push(engine.extractClaim(t));}return b;}
async function done(id){for(let i=0;i<200;i++){const j=(await jobs.listChapterJobs()).find(x=>x.id===id);if(['failed','completed'].includes(j.status))return j;await new Promise(r=>setTimeout(r,10));}throw Error('job timeout');}
const marker='SYNTHETIC_DELETED_PRIVATE_DETAIL';
const caller=async(stage,p)=>stage==='plan'?{groups:[{chapterTitle:marker,sectionTitle:marker,unitIds:p.evidence.slice(0,2).map(u=>u.id)},{chapterTitle:marker,sectionTitle:'独立故事',unitIds:p.evidence.slice(2).map(u=>u.id)}].filter(g=>g.unitIds.length)}:{summary:p.evidence.map(u=>u.text).join(''),paragraphs:p.evidence.map(u=>({text:u.text,unitIds:[u.id]})),issues:[]};

test('deleting a source erases derived copies and backups, preserves unrelated prose, and permits the next update',async()=>{
 const b=fixture([marker,'保留在同一小节的故事。','独立小节的故事。']);
 const result=await generateManuscript(b,{mode:'mock'},{call:caller});b.chapters=result.chapters;b.manuscript=result.manuscript;
 b.manuscript.pending=[{unitId:b.claims[0].id+':0',sourceTurnId:b.claims[0].sourceTurnId,text:marker,reason:marker}];
 b.manuscriptVersions=[{id:randomUUID(),chapters:structuredClone(b.chapters),manuscript:structuredClone(b.manuscript),evidence:b.claims.map(c=>({id:c.id,hash:store.digest(c)})),avoidedHash:store.digest(b.avoidedTopics)}];
 await store.saveBook(b);await store.writeManuscriptProgress(b.id,{state:structuredClone(b.manuscript)});
 const response=await api(`/api/books/${b.id}/sessions/${b.sessions[0].id}/turns/${b.claims[0].sourceTurnId}`,'DELETE');assert.equal(response.status,200);
 const saved=await store.getBook(b.id);assert.ok(!JSON.stringify(saved).includes(marker));assert.equal(await store.readManuscriptProgress(b.id),null);
 assert.deepEqual(saved.chapters.flatMap(c=>c.paragraphs.map(p=>p.text)),['保留在同一小节的故事。','独立小节的故事。']);
 assert.equal(saved.manuscript.sections.length,2);assert.equal(saved.manuscriptVersions[0].chapters[0].paragraphs.length,2);
 const backup=await api(`/api/books/${b.id}/backup`);assert.ok(!backup.text.includes(marker));
 const imported=await api('/api/restore','POST',backup.body);assert.equal(imported.status,201);
 const restored=await store.getBook(imported.body.id);
 const next=await generateManuscript(restored,{mode:'mock'},{call:caller});assert.deepEqual(next.chapters.flatMap(c=>c.paragraphs.map(p=>p.text)),['保留在同一小节的故事。','独立小节的故事。']);
 await store.updateBook(restored.id,x=>{x.chapters=next.chapters;x.manuscript=next.manuscript;});
 assert.equal((await api(`/api/books/${restored.id}/export?format=md`)).status,200);
 const disk=await readFile(store.bookPath(b.id),'utf8');assert.ok(!disk.includes(marker));
});

test('an in-flight chapter job cannot resurrect a deleted source or create a stale version',async()=>{
 const b=fixture([marker,'保留故事']);b.chapters=[engine.createChapter(b,'旧稿')];await store.saveBook(b);
 let release;const gate=new Promise(r=>release=r);
 const j=await jobs.startChapterJob(b.id,'更新',async snapshot=>{await gate;return engine.createChapter(snapshot,'新稿');},'update');
 assert.equal((await api(`/api/books/${b.id}/sessions/${b.sessions[0].id}/turns/${b.claims[0].sourceTurnId}`,'DELETE')).status,200);release();
 assert.equal((await done(j.id)).status,'failed');assert.ok(!JSON.stringify(await store.getBook(b.id)).includes(marker));
});

test('large backup raw JSON and legacy base64 both restore and remain usable',async()=>{
 const b=fixture(Array.from({length:200},()=> '中文故事'.repeat(900)));await store.saveBook(b);
 const backup=await api(`/api/books/${b.id}/backup`);assert.equal(backup.status,200);assert.ok(Buffer.byteLength(backup.text)>2_000_000);
 for(const payload of [backup.body,{archive:Buffer.from(backup.text).toString('base64')}]){
  const restored=await api('/api/restore','POST',payload);assert.equal(restored.status,201);assert.notEqual(restored.body.id,b.id);
  assert.equal(restored.body.sessions[0].turns.length,200);
  const session=await api(`/api/books/${restored.body.id}/sessions`,'POST',{});assert.equal(session.status,201);
  assert.equal((await api(`/api/books/${restored.body.id}/sessions/${session.body.id}/turns`,'POST',{text:'恢复后补充。'})).status,201);
 }
});

test('oversized restore returns the visible 100 MB limit',async()=>{
 const result=await new Promise((resolve,reject)=>{const req=http.request(url+'/api/restore',{method:'POST',headers:{Origin:url,'X-LifeBook-Token':token,'Content-Type':'application/json','Content-Length':100*1024*1024+1}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,text}));});req.on('error',reject);req.end();});
 assert.equal(result.status,413);assert.match(result.text,/100 MB/);
});

test('checksum-valid malformed backups are rejected without adding a broken book',async()=>{
 const before=(await store.listBooks()).map(b=>b.id);
 for(const mutate of [b=>b.sessions[0].turns='invalid',b=>b.chapters=[null],b=>b.claims[0].text={}]){
  const b=fixture(['Synthetic import']);mutate(b);
  const result=await api('/api/restore','POST',{format:'lifebook-backup-v1',book:b,checksum:store.digest(b)});
  assert.equal(result.status,400);assert.match(result.body.error,/备份结构错误/);
 }
 assert.deepEqual((await store.listBooks()).map(b=>b.id),before);
});

test('long voice transcripts and claims can be corrected without raising the text message limit',async()=>{
 const b=fixture(['原始语音'.repeat(1500)]);await store.saveBook(b);const corrected='修正后的原话'.repeat(1200);
 const patch=await api(`/api/books/${b.id}/sessions/${b.sessions[0].id}/turns/${b.claims[0].sourceTurnId}`,'PATCH',{text:corrected});assert.equal(patch.status,200);assert.equal(patch.body.turn.text,corrected);
 const claim=await api(`/api/books/${b.id}/claims/${b.claims[0].id}`,'PATCH',{text:corrected+'结尾'});assert.equal(claim.status,200);assert.equal(claim.body.text,corrected+'结尾');
 assert.equal((await api(`/api/books/${b.id}/sessions/${b.sessions[0].id}/turns`,'POST',{text:corrected})).status,400);
});

test('source deletion clears failed and in-flight generated job titles without altering other books',async()=>{
 const previousSettings=await store.getSettings(),originalFetch=globalThis.fetch;
 const other=fixture(['另外一本书']);await store.saveBook(other);
 const existingJobs=await store.readChapterJobs();existingJobs.push({id:randomUUID(),bookId:other.id,status:'failed',progress:{phase:'writing',currentTitle:'无关书的进度标题'}});await store.writeChapterJobs(existingJobs);
 let releaseWrite,enteredWrite;
 try{
  await store.saveSettings({...previousSettings,mode:'qwen',region:'cn-beijing',workspaceId:'test'});await store.saveSecret('synthetic-key','qwen','cn-beijing');
  for(const inFlight of [false,true]){
   const b=fixture([marker,'保留故事']);await store.saveBook(b);
   const entered=new Promise(r=>enteredWrite=r);const gate=new Promise(r=>releaseWrite=r);
   globalThis.fetch=async(target,options)=>{
    if(String(target).startsWith(url))return originalFetch(target,options);
    const payload=JSON.parse(JSON.parse(options.body).messages[1].content);
    let content;
    if('directory' in payload)content={groups:[{chapterTitle:marker,sectionTitle:marker,unitIds:payload.evidence.map(u=>u.id)}]};
    else {
     enteredWrite();
     if(!inFlight)throw Error('synthetic provider failure');
     await gate;content={summary:marker,paragraphs:payload.evidence.map(u=>({text:u.text,unitIds:[u.id]}))};
    }
    return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}]})};
   };
   const j=await jobs.startChapterJob(b.id,'更新书稿',undefined,'update');await entered;
   if(!inFlight)assert.equal((await done(j.id)).status,'failed');
   assert.ok((await readFile(join(dir,'chapter-jobs.json'),'utf8')).includes(marker));
   const deleted=await api(`/api/books/${b.id}/sessions/${b.sessions[0].id}/turns/${b.claims[0].sourceTurnId}`,'DELETE');assert.equal(deleted.status,200);
   if(inFlight){releaseWrite();assert.equal((await done(j.id)).status,'failed');}
   const records=await store.readChapterJobs();assert.ok(!JSON.stringify(records.filter(x=>x.bookId===b.id)).includes(marker));
   assert.equal(records.find(x=>x.bookId===other.id).progress.currentTitle,'无关书的进度标题');
   assert.equal(await store.readManuscriptProgress(b.id),null);
  }
 }finally{releaseWrite?.();globalThis.fetch=originalFetch;await store.saveSettings(previousSettings);}
});

test('delete a whole session removes its sources and versions while keeping other sessions',async()=>{
 const b=fixture([marker,marker+'第二句']),removed=b.sessions[0];
 const keep=fixture(['应保留的另一次聊天']);b.sessions.push(keep.sessions[0]);b.claims.push(...keep.claims);
 b.chapters=[engine.createChapter(b,'原稿')];b.manuscriptVersions=[{chapters:structuredClone(b.chapters)}];
 await store.saveBook(b);await store.writeManuscriptProgress(b.id,{text:marker});
 assert.equal((await api(`/api/books/${b.id}/sessions/${removed.id}`,'DELETE')).status,200);
 const saved=await store.getBook(b.id);assert.equal(saved.sessions.length,1);assert.equal(saved.sessions[0].id,keep.sessions[0].id);
 assert.equal(saved.claims.length,1);assert.equal(saved.claims[0].text,'应保留的另一次聊天');
 assert.ok(!JSON.stringify(saved).includes(marker));assert.equal(await store.readManuscriptProgress(b.id),null);
 assert.ok(!(await api(`/api/books/${b.id}/backup`)).text.includes(marker));
 assert.equal((await api(`/api/books/${b.id}/sessions/${removed.id}/turns`,'POST',{text:'迟到消息'})).status,404);
 assert.equal((await api(`/api/books/${b.id}/sessions/${removed.id}`,'DELETE')).status,404);
 assert.equal((await api(`/api/books/${b.id}/sessions/${keep.sessions[0].id}/turns`,'POST',{text:'继续保留的聊天'})).status,201);
});
test('assistant-only session can be deleted and a new conversation started',async()=>{
 const b=fixture([]);b.sessions[0].turns=[engine.turn('assistant','虚构开场')];await store.saveBook(b);
 assert.equal((await api(`/api/books/${b.id}/sessions/${b.sessions[0].id}`,'DELETE')).status,200);
 assert.equal((await store.getBook(b.id)).sessions.length,0);
 assert.equal((await api(`/api/books/${b.id}/sessions`,'POST',{})).status,201);
});
