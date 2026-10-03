import test from 'node:test';
import assert from 'node:assert/strict';
import {buildContext} from '../src/context.js';
test('profile from early book history survives sessions; corrected and removed sources update plan',()=>{
 const old={id:'old',turns:[{id:'q',role:'assistant',text:'怎么称呼你？'},{id:'n',role:'user',text:'小林'},{id:'a',role:'user',text:'我现在22岁，正在读研一。'}]};
 const current={id:'new',turns:[]};const book={sessions:[old,current],claims:[],avoidedTopics:[]};
 let plan=buildContext(book,current).payload.interview;
 assert.equal(plan.knownProfile.name.text,'小林');assert.match(plan.knownProfile.age.text,/22/);assert.equal(plan.stage,'invite_memory');assert.equal(plan.suggestedTopic,'成长经历');
 book.claims=[{sourceTurnId:'a',text:'我现在23岁，正在读研二。',status:'confirmed'}];
 assert.match(buildContext(book,current).payload.interview.knownProfile.age.text,/23/);
 old.turns=old.turns.filter(t=>t.id!=='a');assert.equal(buildContext(book,current).payload.interview.knownProfile.age,undefined);
});
test('declined sources do not become profile or coverage',()=>{
 const session={id:'s',turns:[{id:'a',role:'user',text:'我今年22岁，小时候在老家长大。',avoided:true}]};
 const p=buildContext({sessions:[session],claims:[],avoidedTopics:[]},session).payload.interview;
 assert.equal(p.knownProfile.age,undefined);assert.equal(p.coverage[0].mentions,0);
});
test('long introduction leads to a topic invitation rather than being treated as a story',()=>{
 const s={id:'s',turns:[{id:'a',role:'user',text:'我叫小林，我现在22岁，目前正在读研一。我现在主要还是学生，还没有毕业，也还没有开始正式工作，这些就是我的大概情况。'}]};
 const p=buildContext({sessions:[s],claims:[]},s).payload.interview;
 assert.equal(p.stage,'invite_memory');assert.equal(p.nextMove,undefined);
});

test('opening distinguishes first meeting, returning continuation and a new chapter',async()=>{
 const {openingRequestFor}=await import('../src/interview.js');
 const fresh={id:'fresh',turns:[]};
 const book={name:'亚星',sessions:[fresh],claims:[]};
 let p=buildContext(book,fresh).payload.interview;
 assert.equal(p.openingMode,'first_meeting');
 const first=openingRequestFor(p);
 book.sessions.unshift({id:'old',turns:[{id:'name',role:'user',text:'叫我亚星，我正在读研一。'}]});
 p=buildContext(book,fresh).payload.interview;
 assert.equal(p.openingMode,'returning');assert.equal(p.entryIntent,'continue');
 const continuation=openingRequestFor(p);assert.notEqual(first,continuation);
 assert.match(continuation,/这次想接着上次聊，还是换一个方向/);
 assert.match(continuation,/禁止自我介绍/);
 assert.match(first,/LifeBook 的 AI 访谈主持人/);
 assert.match(first,/自我介绍邀请/);
 assert.match(first,/大概年龄/);
 assert.match(first,/不是两个必答问题/);
 assert.match(first,/记录下来/);
 fresh.intent='new_topic';p=buildContext(book,fresh).payload.interview;
 assert.equal(p.entryIntent,'new_topic');assert.notEqual(openingRequestFor(p),continuation);
 book.sessions[0].turns=[];
 assert.equal(buildContext(book,fresh).payload.interview.openingMode,'first_meeting');
});

test('introductory background remains sourced across long history and respects edits and refusals',()=>{
 const old={id:'old',turns:[{id:'intro-q',role:'assistant',text:'可以简单介绍一下自己吗？'},{id:'intro-a',role:'user',text:'我以前是护士，现在退休了。'}]};
 const current={id:'new',turns:Array.from({length:30},(_,i)=>({id:'later-'+i,role:'user',text:'后来我们一起去散步。'}))};
 const book={sessions:[old,current],claims:[],avoidedTopics:[]};
 let background=buildContext(book,current).payload.interview.knownProfile.background;
 assert.equal(background.sourceTurnId,'intro-a');assert.equal(background.text,'我以前是护士，现在退休了。');
 book.claims=[{sourceTurnId:'intro-a',text:'我以前是药剂师，现在退休了。',status:'confirmed'}];
 assert.equal(buildContext(book,current).payload.interview.knownProfile.background.text,'我以前是药剂师，现在退休了。');
 book.avoidedTopics=[{topic:'药剂师'}];assert.equal(buildContext(book,current).payload.interview.knownProfile.background,undefined);
 book.avoidedTopics=[];book.claims[0].status='rejected';assert.equal(buildContext(book,current).payload.interview.knownProfile.background,undefined);
 book.claims=[];old.turns.pop();assert.equal(buildContext(book,current).payload.interview.knownProfile.background,undefined);
});
