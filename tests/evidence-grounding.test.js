import test from 'node:test';
import assert from 'node:assert/strict';
import {buildContext,contextInstructions} from '../src/context.js';
import {resumeRequestFor} from '../src/interview.js';
import {turn,extractClaim,currentClaims,createChapter,safeChapter} from '../src/engine.js';
import {evidenceUnits} from '../src/manuscript.js';
import {isRecollectionDispute} from '../src/evidence.js';
import {storyEvidence} from '../src/story-content.js';
function fixture(){const session={id:'s',turns:[turn('assistant','你好，想聊哪段经历？')]};return {sessions:[session],claims:[],chapters:[],avoidedTopics:[]};}
test('assistant-only history resumes without asking the model to invent a user detail',()=>{
  const b=fixture(),context=buildContext(b,b.sessions[0]);
  assert.equal(context.sourceCount,0);assert.equal(context.payload.userEvidenceCount,0);
  assert.match(resumeRequestFor(context),/没有任何已保存/);
  assert.doesNotMatch(resumeRequestFor(context),/先简短回顾/);
  assert.match(contextInstructions(b,b.sessions[0]),/采访者的问题、陈述和示例都不是用户事实/);
});
test('a disputed invented memory remains dialogue but is excluded from facts and manuscript inputs',()=>{
  const b=fixture(),s=b.sessions[0];
  s.turns.push(turn('assistant','刚才你说在旧教室里复习。'));
  const denial=turn('user','不是我，我、我、我什么时候跟你说我在旧教室里复习了呀？');
  s.turns.push(denial);b.claims.push(extractClaim(denial));
  const context=buildContext(b,s);
  assert.equal(context.sourceCount,0);assert.deepEqual(context.payload.relatedMemories,[]);
  assert.deepEqual(context.payload.outline,[]);assert.ok(context.payload.recentConversation.some(t=>t.text===denial.text));
  assert.equal(currentClaims(b).length,0);assert.equal(evidenceUnits(b).length,0);assert.equal(createChapter(b,'草稿').paragraphs.length,0);
  const oldDraft={kind:'composed',paragraphs:[{text:'我在旧教室复习。',sourceTurnIds:[denial.id]}]};
  assert.equal(safeChapter(b,oldDraft).paragraphs.length,0);
  assert.match(resumeRequestFor(context),/没有任何已保存/);
});
test('genuine negative memories and explicit corrected facts are retained',()=>{
  for(const text of ['我小时候没有在学校吃午饭。','我没有说话，一直在教室看书。','老师问我什么时候跟你说过这件事。'])assert.equal(isRecollectionDispute(text),false);
  const b=fixture(),s=b.sessions[0],t=turn('user','我什么时候跟你说过我在旧教室复习？');s.turns.push(t);
  b.claims.push({...extractClaim(t),text:'我是在图书馆复习。',status:'confirmed'});
  assert.equal(buildContext(b,s).sourceCount,1);assert.equal(currentClaims(b)[0].text,'我是在图书馆复习。');
  assert.equal(evidenceUnits(b)[0].text,'我是在图书馆复习。');
  assert.match(resumeRequestFor(buildContext(b,s)),/他本人确实讲过/);
});

test('avoided topics in corrected testimony are filtered consistently from chat, titles, manuscripts and exports',()=>{
 for(const corrected of [true,false]){
  const b=fixture(),s=b.sessions[0],blocked=turn('user',corrected?'Original ASR error':'PRIVATE_TOPIC original story'),keep=turn('user','Unrelated surviving story');
  s.turns.push(blocked,keep);b.claims.push({...extractClaim(blocked),text:corrected?'PRIVATE_TOPIC corrected story':'Corrected wording',status:'confirmed'},extractClaim(keep));
  b.avoidedTopics=[{topic:'PRIVATE_TOPIC'}];
  assert.doesNotMatch(buildContext(b,s).text,/PRIVATE_TOPIC (?:original|corrected) story|Original ASR error|Corrected wording/);
  for(const records of [currentClaims(b),evidenceUnits(b),storyEvidence(b,s)])assert.equal(records.length,1);
  const chapter=createChapter(b,'Synthetic chapter');assert.equal(chapter.paragraphs.length,1);assert.equal(chapter.paragraphs[0].text,keep.text);
  const stale={kind:'composed',paragraphs:[{text:'PRIVATE_TOPIC generated copy',sourceTurnIds:[blocked.id]},{text:'Unrelated prose',sourceTurnIds:[keep.id]}]};
  assert.deepEqual(safeChapter(b,stale).paragraphs.map(p=>p.text),['Unrelated prose']);
 }
});
