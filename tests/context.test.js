import test from 'node:test';
import assert from 'node:assert/strict';
import {buildContext,normalizeFocus} from '../src/context.js';
import {qwenReply,turn} from '../src/engine.js';
function fixture(){const b={name:'讲述者',sessions:[],claims:[],avoidedTopics:[]};for(let s=0;s<25;s++){const session={id:'s'+s,startedAt:'2020-01-01',focus:{stage:'少年',theme:'求学时光'},turns:[]};for(let i=0;i<20;i++){const t={id:`t${s}-${i}`,role:'user',text:`第${s}次聊天的第${i}条普通经历，放学去操场散步。`};session.turns.push(t);b.claims.push({sourceTurnId:t.id,text:t.text,status:'proposed'});}b.sessions.push(session);}b.sessions[0].turns[0].text='我小时候住在槐树巷，小卖部老板娘姓赵，大家叫她赵阿姨。';b.claims[0].text=b.sessions[0].turns[0].text;return b;}
test('retrieve early source after 500 turns; context remains bounded across sessions',()=>{const b=fixture();const result=buildContext(b,b.sessions.at(-1),'还记得槐树巷那家小卖部吗？');assert.equal(result.sourceCount,500);assert.match(result.text,/赵阿姨/);assert.ok(result.payload.relatedMemories.some(x=>x.sourceTurnId==='t0-0'));assert.ok(result.text.length<24000);assert.equal(result.payload.outline.length,12);});
test('current correction wins; rejection, deletion and avoided topics disappear',()=>{const b=fixture(),s=b.sessions.at(-1);b.claims[0].text='槐树巷老板娘姓周，叫周阿姨。';b.claims[0].status='confirmed';let x=buildContext(b,s,'槐树巷老板娘').text;assert.match(x,/周阿姨/);assert.doesNotMatch(x,/赵阿姨/);b.claims[0].status='rejected';assert.doesNotMatch(buildContext(b,s,'槐树巷').text,/周阿姨|赵阿姨/);b.claims[0].status='confirmed';b.sessions[0].turns.splice(0,1);assert.doesNotMatch(buildContext(b,s,'槐树巷').text,/周阿姨/);b.avoidedTopics.push({topic:'操场'});assert.equal(buildContext(b,s,'操场').sourceCount,0);});
test('corrected recent turns and dependent questions cannot reintroduce old facts',()=>{const b={sessions:[{id:'s',turns:[{id:'a',role:'user',text:'1998年去了上海'},{id:'b',role:'assistant',text:'1998年上海的天气如何？'}]}],claims:[{sourceTurnId:'a',text:'1999年去了上海',status:'confirmed'}],avoidedTopics:[]};const x=buildContext(b,b.sessions[0]).text;assert.match(x,/1999/);assert.doesNotMatch(x,/1998/);});
test('valid focus choices are explicit and invalid values are rejected',()=>{assert.deepEqual(normalizeFocus({stage:'晚年',theme:'家人与朋友'}),{stage:'晚年',theme:'家人与朋友'});assert.throws(()=>normalizeFocus({stage:'任意注入'}));});

test('text model receives the entire newest message while saved long history stays bounded',async()=>{
 const previous=globalThis.fetch,old=turn('user','Saved history. '.repeat(1000));
 const session={id:'s',turns:[old]},book={sessions:[session],claims:[],avoidedTopics:[]};
 const message='New story. '.repeat(200)+'END_REQUEST_ONLY_AT_THE_END';
 let request;
 try{
  globalThis.fetch=async(url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:'Synthetic answer'}}]})};};
  await qwenReply(book,{...session,turns:[...session.turns,turn('user',message)]},{mode:'qwen',qwenConnection:'unified',model:'synthetic'},'synthetic-key');
  assert.equal(request.messages.at(-1).content,message);
  assert.ok(request.messages.find(m=>m.role==='user'&&m.content.startsWith('Saved')).content.length<=702);
  assert.ok(buildContext(book,session).payload.recentConversation.at(-1).text.length<=702);
 }finally{globalThis.fetch=previous;}
});
