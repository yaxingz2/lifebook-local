import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';

async function launch(existingDir,extraEnv={}) {
  const dir=existingDir||await mkdtemp(join(tmpdir(),'lifebook-test-'));
  const child=spawn(process.execPath,['src/server.js'],{cwd:join(import.meta.dirname,'..'),env:{...process.env,LIFEBOOK_DATA_DIR:dir,PORT:'0',...extraEnv},stdio:['ignore','pipe','pipe']});
  const url=await new Promise((resolve,reject)=>{
    let output=''; const timeout=setTimeout(()=>{child.kill();reject(new Error('server startup timed out after 30 seconds'));},30000);
    child.stdout.on('data',chunk=>{ output+=chunk; const match=output.match(/http:\/\/127\.0\.0\.1:\d+/); if(match){clearTimeout(timeout);resolve(match[0]);} });
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error('server exited '+code));});
  });
  const boot=await (await fetch(url+'/api/bootstrap')).json();
  async function api(path,method='GET',data,token=boot.token) {
    const res=await fetch(url+path,{method,headers:{Origin:url,'X-LifeBook-Token':token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
    const raw=await res.text();let body;try{body=JSON.parse(raw);}catch{body=raw;}return {status:res.status,body};
  }
  return {url,boot,api,dir,close:async(keep=false)=>{child.kill();await new Promise(resolve=>child.once('exit',resolve));if(!keep)await rm(dir,{recursive:true,force:true});}};
}

test('browser entrypoint dependencies are served as executable JavaScript',async()=>{
  const app=await launch();try{
    const entry=await(await fetch(app.url+'/app.js')).text();
    const imports=[...entry.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)].map(m=>m[1]);
    assert.ok(imports.length>0);
    for(const path of imports){const res=await fetch(app.url+'/'+path);assert.equal(res.status,200,path);assert.match(res.headers.get('content-type'),/javascript/,path);}
  }finally{await app.close();}
});

test('old story lists use content titles and preserve conversations while backfilling',async()=>{
  const app=await launch();try {
    const id=(await app.api('/api/books','POST',{title:'旧聊天标题验收'})).body.id;
    const s=(await app.api(`/api/books/${id}/sessions`,'POST',{})).body;
    await app.api(`/api/books/${id}/sessions/${s.id}/turns`,'POST',{text:'我第一次离家上大学，爸爸陪我坐了一夜火车。'});
    const original=(await app.api(`/api/books/${id}`)).body;
    assert.equal(original.sessions[0].focus.theme,'成长经历');assert.match(original.sessions[0].storyTitle,/第一次离家/);assert.equal(original.sessions[0].storyTitlePending,true);
    assert.equal((await app.api(`/api/books/${id}/story-titles`,'POST',{sessionIds:[s.id]},'bad')).status,403);
    assert.equal((await app.api(`/api/books/${id}/story-titles`,'POST',{sessionIds:[s.id,s.id,s.id]})).status,400);
    const titles=await app.api(`/api/books/${id}/story-titles`,'POST',{sessionIds:[s.id]});assert.equal(titles.status,200);
    assert.deepEqual((await app.api(`/api/books/${id}`)).body.sessions[0].turns,original.sessions[0].turns);
  }finally{await app.close();}
});

test('legacy ended conversations and repeated exits can continue in the same session',async()=>{
  const app=await launch();try{
    const id=(await app.api('/api/books','POST',{title:'随时续聊'})).body.id;
    const s=(await app.api(`/api/books/${id}/sessions`,'POST',{})).body;
    await app.api(`/api/books/${id}/sessions/${s.id}/turns`,'POST',{text:'小时候我常和奶奶去赶集。'});
    const original=(await app.api(`/api/books/${id}`)).body.book;
    original.sessions[0].endedAt='2026-09-30T00:00:00Z';
    await writeFile(join(app.dir,'books',id+'.json'),JSON.stringify(original));
    const continued=await app.api(`/api/books/${id}/sessions/${s.id}/turns`,'POST',{text:'后来她教我挑新鲜的菜。'});
    assert.equal(continued.status,201);
    const saved=(await app.api(`/api/books/${id}`)).body.book;
    assert.equal(saved.sessions.length,1);assert.equal(saved.sessions[0].id,s.id);assert.equal(saved.sessions[0].endedAt,null);
    assert.deepEqual(saved.sessions[0].turns.slice(0,original.sessions[0].turns.length),original.sessions[0].turns);
    for(let i=0;i<2;i++){const exited=await app.api(`/api/books/${id}/sessions/${s.id}/end`,'POST',{});assert.equal(exited.status,200);assert.equal(exited.body.endedAt,null);}
    const afterExit=(await app.api(`/api/books/${id}`)).body.book;
    assert.equal(afterExit.revision,saved.revision);assert.deepEqual(afterExit.sessions[0].turns,saved.sessions[0].turns);
    assert.equal((await app.api(`/api/books/${id}/sessions/${s.id}/turns`,'POST',{text:'我还想起了另一件赶集时的事。'})).status,201);
    assert.equal((await app.api(`/api/books/${id}`)).body.sessions.length,1);
  }finally{await app.close();}
});

test('two sessions, correction, provenance, exclusion, deletion and restore',async()=>{
  const app=await launch(); try {
    const {api}=app;
    const created=await api('/api/books','POST',{title:'我的故事',name:'小明'});assert.equal(created.status,201);const id=created.body.id;
    const s1=await api(`/api/books/${id}/sessions`,'POST',{});assert.match(s1.body.turns[0].text,/小时候/);
    const sid=s1.body.id;
    const first=await api(`/api/books/${id}/sessions/${sid}/turns`,'POST',{text:'我在1998年和妈妈住在海边。'});
    assert.equal(first.status,201);assert.match(first.body.assistantTurn.text,/家人/);
    const tid=first.body.userTurn.id;
    await api(`/api/books/${id}/sessions/${sid}/end`,'POST',{});
    const claims=(await api(`/api/books/${id}`)).body.claims;
    await api(`/api/books/${id}/claims/${claims[0].id}`,'PATCH',{text:'我在1999年和妈妈住在海边。',status:'confirmed'});
    const s2=await api(`/api/books/${id}/sessions`,'POST',{});
    assert.match(s2.body.turns[0].text,/1999/);assert.doesNotMatch(s2.body.turns[0].text,/1998/);
    const chapter=await api(`/api/books/${id}/chapters`,'POST',{title:'海边'});
    assert.equal(chapter.body.paragraphs[0].sourceTurnIds[0],tid);
    assert.match((await api(`/api/books/${id}/export?format=md`)).body,/1999/);
    await api(`/api/books/${id}/sessions/${sid}/turns/${tid}`,'PATCH',{excludedFromBook:true});
    assert.doesNotMatch((await api(`/api/books/${id}/export?format=md`)).body,/1999/);
    const backup=(await api(`/api/books/${id}/backup`)).body;
    assert.doesNotMatch(JSON.stringify(backup),/apiKey/);
    const restored=await api('/api/restore','POST',{archive:Buffer.from(JSON.stringify(backup)).toString('base64')});
    assert.equal(restored.status,201);assert.notEqual(restored.body.id,id);
    await api(`/api/books/${id}/sessions/${sid}/turns/${tid}`,'DELETE');
    assert.equal((await api(`/api/books/${id}`)).body.claims.length,0);
  } finally {await app.close();}
});

test('reject unauthorized writes, forged origin, and forged host',async()=>{
  const app=await launch(); try {
    assert.equal((await app.api('/api/books','POST',{title:'x'},'bad')).status,403);
    const badOrigin=await fetch(app.url+'/api/books',{method:'POST',headers:{Origin:'https://evil.example','X-LifeBook-Token':app.boot.token,'Content-Type':'application/json'},body:JSON.stringify({title:'x'})});
    assert.equal(badOrigin.status,403);
    const badHost=await new Promise((resolve,reject)=>{http.get(app.url+'/api/bootstrap',{headers:{Host:'evil.example'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});assert.equal(badHost,403);
  } finally {await app.close();}
});

test('topic switch, settings, escaping and tampered backup',async()=>{
  const app=await launch(); try {
    const {api}=app;
    const settings=await api('/api/settings','PUT',{mode:'mock',region:'ap-southeast-1',workspaceId:'ws_example',model:'qwen3.8-max',apiKey:'test-secret-do-not-export'});
    assert.equal(settings.status,200);assert.equal(settings.body.hasKey,true);assert.equal(JSON.stringify(settings.body).includes('test-secret'),false);
    const book=(await api('/api/books','POST',{title:'<img src=x onerror=alert(1)>',name:'测试'})).body;
    const session=(await api(`/api/books/${book.id}/sessions`,'POST',{})).body;
    const switched=await api(`/api/books/${book.id}/topic`,'POST',{});
    assert.equal(switched.status,200);assert.match(switched.body.assistantTurn.text,/换个话题/);
    const t=(await api(`/api/books/${book.id}/sessions/${session.id}/turns`,'POST',{text:'<script>alert(1)</script>'})).body.userTurn;
    await api(`/api/books/${book.id}/chapters`,'POST',{title:'第一章'});
    const html=(await api(`/api/books/${book.id}/export?format=html`)).body;
    assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
    const backup=(await api(`/api/books/${book.id}/backup`)).body;
    assert.doesNotMatch(JSON.stringify(backup),/test-secret-do-not-export/);
    const corrupt={...backup,checksum:'invalid'};
    assert.equal((await api('/api/restore','POST',{archive:Buffer.from(JSON.stringify(corrupt)).toString('base64')})).status,400);
    await api(`/api/books/${book.id}/sessions/${session.id}/turns/${t.id}`,'DELETE');
    assert.doesNotMatch((await api(`/api/books/${book.id}/export?format=html`)).body,/&lt;script&gt;/);
    assert.equal((await api(`/api/books/${book.id}`)).body.sessions[0].turns.filter(x=>x.role==='user').length,0);
  } finally {await app.close();}
});

test('a completed session survives process restart',async()=>{
  let app=await launch();const dir=app.dir;try{
    const book=(await app.api('/api/books','POST',{title:'重启测试'})).body;
    const session=(await app.api(`/api/books/${book.id}/sessions`,'POST',{})).body;
    await app.api(`/api/books/${book.id}/sessions/${session.id}/turns`,'POST',{text:'小时候我住在海边。'});
    await app.close(true);app=null;
    const restarted=await launch(dir);app=restarted;
    const data=(await restarted.api(`/api/books/${book.id}`)).body;
    assert.equal(data.sessions.length,1);assert.match(data.sessions[0].turns.at(-2).text,/海边/);
  }finally{if(app)await app.close();else await rm(dir,{recursive:true,force:true});}
});

test('refused subject stays out of future opening and chapters',async()=>{
  const app=await launch();try{
    const {api}=app,id=(await api('/api/books','POST',{title:'故事'})).body.id;
    const s=(await api(`/api/books/${id}/sessions`,'POST',{})).body;
    await api(`/api/books/${id}/sessions/${s.id}/turns`,'POST',{text:'我的爷爷以前住在山上。'});
    await api(`/api/books/${id}/sessions/${s.id}/turns`,'POST',{text:'别再提爷爷。'});
    await api(`/api/books/${id}/sessions/${s.id}/end`,'POST',{});
    const next=(await api(`/api/books/${id}/sessions`,'POST',{})).body;
    assert.doesNotMatch(next.turns[0].text,/爷爷/);
    const chapter=(await api(`/api/books/${id}/chapters`,'POST',{title:'童年'})).body;
    assert.doesNotMatch(JSON.stringify(chapter),/爷爷/);
  }finally{await app.close();}
});

test('online failure does not persist empty session or duplicate user turn',async()=>{
  const app=await launch();try{
    const {api}=app,id=(await api('/api/books','POST',{title:'故事'})).body.id;
    await api('/api/settings','PUT',{mode:'qwen',region:'ap-southeast-1',workspaceId:'',model:'qwen3.8-max'});
    assert.equal((await api(`/api/books/${id}/sessions`,'POST',{})).status,400);
    assert.equal((await api(`/api/books/${id}`)).body.sessions.length,0);
    await api('/api/settings','PUT',{mode:'mock',region:'ap-southeast-1',workspaceId:'',model:'qwen3.8-max'});
    const session=(await api(`/api/books/${id}/sessions`,'POST',{})).body;
    await api('/api/settings','PUT',{mode:'qwen',region:'ap-southeast-1',workspaceId:'',model:'qwen3.8-max'});
    assert.equal((await api(`/api/books/${id}/sessions/${session.id}/turns`,'POST',{text:'一段回忆'})).status,400);
    assert.equal((await api(`/api/books/${id}`)).body.sessions[0].turns.filter(t=>t.role==='user').length,0);
  }finally{await app.close();}
});

test('explicit refusal excludes earlier matching subject but retains unrelated turn',async()=>{
  const app=await launch();try{
    const {api}=app,id=(await api('/api/books','POST',{title:'故事'})).body.id;
    const s=(await api(`/api/books/${id}/sessions`,'POST',{})).body;
    const grandfather=(await api(`/api/books/${id}/sessions/${s.id}/turns`,'POST',{text:'爷爷以前在山上种菜。'})).body.userTurn;
    const unrelated=(await api(`/api/books/${id}/sessions/${s.id}/turns`,'POST',{text:'我的朋友在河边唱歌。'})).body.userTurn;
    await api(`/api/books/${id}/sessions/${s.id}/turns`,'POST',{text:'别再提爷爷。'});
    const data=(await api(`/api/books/${id}`)).body;
    const turns=data.sessions[0].turns;
    assert.equal(turns.find(t=>t.id===grandfather.id).avoided,true);
    assert.equal(turns.find(t=>t.id===unrelated.id).avoided,undefined);
    const chapter=(await api(`/api/books/${id}/chapters`,'POST',{title:'故事'})).body;
    assert.match(JSON.stringify(chapter),/朋友/);assert.doesNotMatch(JSON.stringify(chapter),/爷爷/);
  }finally{await app.close();}
});

test('deleting or editing a source removes dependent echoed assistant reply',async()=>{
  const app=await launch();try{
    const {api}=app,id=(await api('/api/books','POST',{title:'故事'})).body.id;
    const s=(await api(`/api/books/${id}/sessions`,'POST',{})).body;
    const first=(await api(`/api/books/${id}/sessions/${s.id}/turns`,'POST',{text:'蓝色的小木箱放在阁楼。'})).body;
    assert.match(first.assistantTurn.text,/蓝色的小木箱/);
    await api(`/api/books/${id}/sessions/${s.id}/turns/${first.userTurn.id}`,'DELETE');
    assert.doesNotMatch(JSON.stringify((await api(`/api/books/${id}`)).body.sessions),/蓝色的小木箱/);
    const second=(await api(`/api/books/${id}/sessions/${s.id}/turns`,'POST',{text:'红色旧日记在窗边。'})).body;
    await api(`/api/books/${id}/sessions/${s.id}/turns/${second.userTurn.id}`,'PATCH',{text:'绿色旧日记在窗边。'});
    const transcript=JSON.stringify((await api(`/api/books/${id}`)).body.sessions);
    assert.match(transcript,/绿色旧日记/);assert.doesNotMatch(transcript,/红色旧日记/);
  }finally{await app.close();}
});

test('voice upgrade requires same origin and session token; mock mode rejects voice',async()=>{
  const app=await launch();try{
    const wsUrl=app.url.replace('http:','ws:')+'/api/voice';
    const forbidden=await new Promise(resolve=>{const ws=new WebSocket(wsUrl,['lifebook','bad'],{headers:{Origin:app.url}});ws.on('unexpected-response',(_,res)=>resolve(res.statusCode));ws.on('error',()=>resolve(403));});
    assert.equal(forbidden,403);
    const book=(await app.api('/api/books','POST',{title:'语音测试'})).body;
    const session=(await app.api(`/api/books/${book.id}/sessions`,'POST',{})).body;
    const result=await new Promise((resolve,reject)=>{
      const ws=new WebSocket(wsUrl,['lifebook',app.boot.token],{headers:{Origin:app.url}});
      const timer=setTimeout(()=>reject(new Error('voice timeout')),3000);
      ws.on('open',()=>ws.send(JSON.stringify({type:'start',bookId:book.id,sessionId:session.id,transport:'webrtc'})));
      ws.on('message',data=>{const event=JSON.parse(data.toString());if(event.type==='error'){clearTimeout(timer);resolve(event.message);ws.close();}});
      ws.on('error',reject);
    });
    assert.match(result,/配置千问/);
  }finally{await app.close();}
});

test('focus persists, switches, and archived books can be recovered after restart',async()=>{
 let app=await launch();const dir=app.dir;try{
  const id=(await app.api('/api/books','POST',{title:'主线测试'})).body.id;
  const focus={stage:'少年',theme:'求学时光'};
  const s=(await app.api(`/api/books/${id}/sessions`,'POST',{focus})).body;
  assert.deepEqual(s.focus,focus);assert.match(s.turns[0].text,/怎么称呼/);
  assert.equal((await app.api(`/api/books/${id}/sessions`,'POST',{focus:{stage:'错误'}})).status,400);
  const next={stage:'青年',theme:'工作与事业'};
  await app.api(`/api/books/${id}/topic`,'POST',{focus:next,nextTopic:'青年工作'});
  assert.deepEqual((await app.api(`/api/books/${id}`)).body.sessions[0].focus,next);
  await app.api(`/api/books/${id}/archive`,'POST',{archived:true});
  assert.equal((await app.api('/api/bootstrap')).body.books.length,0);
  assert.equal((await app.api('/api/bootstrap')).body.archivedBooks.length,1);
  await app.close(true);app=await launch(dir);
  assert.equal(app.boot.archivedBooks[0].id,id);
  await app.api(`/api/books/${id}/archive`,'POST',{archived:false});
  assert.equal((await app.api('/api/bootstrap')).body.books[0].id,id);
 }finally{await app.close();}
});

test('bookshelf archive is reversible; permanent deletion validates title and removes book only',async()=>{
 const app=await launch();try{
 const a=(await app.api('/api/books','POST',{title:'删除测试书'})).body;
 const b=(await app.api('/api/books','POST',{title:'保留测试书'})).body;
 const path=`/api/books/${a.id}`;
 await app.api(path+'/archive','POST',{archived:true});
 assert.ok((await app.api('/api/bootstrap')).body.archivedBooks.some(x=>x.id===a.id));
 await app.api(path+'/archive','POST',{archived:false});
 assert.ok((await app.api('/api/bootstrap')).body.books.some(x=>x.id===a.id));
 assert.equal((await app.api(path,'DELETE',{confirmTitle:'错误'})).status,400);
 assert.equal((await app.api(path)).status,200);
 assert.equal((await app.api(path,'DELETE',{confirmTitle:a.title},'invalid')).status,403);
 assert.equal((await app.api(path,'DELETE',{confirmTitle:a.title})).status,200);
 assert.equal((await app.api(path)).status,404);
 assert.equal((await app.api(`/api/books/${b.id}`)).status,200);
 const boot=(await app.api('/api/bootstrap')).body;
 assert.ok(![...boot.books,...boot.archivedBooks].some(x=>x.id===a.id));
 }finally{await app.close();}
});

test('chapter background API returns accepted and exposes saved completion',async()=>{
 const app=await launch();try{
  const b=(await app.api('/api/books','POST',{title:'后台生成验收'})).body;
  const started=await app.api(`/api/books/${b.id}/chapter-jobs`,'POST',{title:'第一章'});assert.equal(started.status,202);
  let job;
  for(let i=0;i<100;i++){job=(await app.api('/api/chapter-jobs')).body.find(j=>j.id===started.body.id);if(job.status==='completed')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(job.status,'completed');assert.equal((await app.api(`/api/books/${b.id}`)).body.chapters.length,1);
  assert.equal((await app.api('/api/chapter-jobs/dismiss','POST',{id:job.id})).status,200);
  assert.equal((await app.api('/api/chapter-jobs')).body.length,0);
 }finally{await app.close();}
});

test('unified Qwen settings need only one key and hide regional configuration',async()=>{
 const app=await launch();try{
 const saved=await app.api('/api/settings','PUT',{mode:'qwen',qwenConnection:'unified',apiKey:'test-unified-key',model:'qwen3.7-plus'});
 assert.equal(saved.status,200);assert.equal(saved.body.hasKey,true);assert.equal(saved.body.qwenConnection,'unified');assert.equal(saved.body.region,undefined);assert.equal(saved.body.workspaceId,undefined);assert.equal(saved.body.qwenProfiles,undefined);assert.ok(!JSON.stringify(saved.body).includes('test-unified-key'));
 const again=await app.api('/api/settings','PUT',{mode:'qwen',qwenConnection:'unified',model:'qwen3.8-flash'});assert.equal(again.body.hasKey,true);
 }finally{await app.close();}
});


test('Qwen conversation rhythm persists and rejects invalid mode before saving a secret',async()=>{
 const app=await launch();try{
  const changed=await app.api('/api/settings','PUT',{mode:'qwen',region:'cn-beijing',qwenTurnDetection:'server_vad'});
  assert.equal(changed.status,200);assert.equal(changed.body.qwenTurnDetection,'server_vad');
  const invalid=await app.api('/api/settings','PUT',{mode:'qwen',region:'cn-beijing',qwenTurnDetection:'client-rms',apiKey:'must-not-save'});
  assert.equal(invalid.status,400);
  const again=await app.api('/api/settings','GET');assert.equal(again.body.qwenTurnDetection,'server_vad');assert.equal(again.body.hasKey,false);
 }finally{await app.close();}
});
