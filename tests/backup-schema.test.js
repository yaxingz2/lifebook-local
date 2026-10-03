import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateBackupBook} from '../src/backup.js';
import {newBook} from '../src/storage.js';
import {turn,extractClaim,createChapter} from '../src/engine.js';
function fixture(){const b=newBook('Synthetic backup','');const t=turn('user','Synthetic story');b.sessions=[{id:randomUUID(),turns:[t]}];b.claims=[extractClaim(t)];b.chapters=[createChapter(b,'Synthetic chapter')];return b;}
test('valid backup data keeps source references and historical evidence hashes',()=>{
 const b=fixture();b.manuscriptVersions=[{id:randomUUID(),chapters:structuredClone(b.chapters),evidence:[{id:randomUUID(),hash:'historical hash'}],avoidedHash:'historical topic hash',manuscript:null}];
 assert.equal(validateBackupBook(b),b);
});
test('malformed nested backup structures fail with a visible 400 before persistence',()=>{
 const cases=[
  b=>b.sessions[0].turns='invalid',b=>b.sessions.push(null),b=>b.claims[0].text={},
  b=>b.claims[0].sourceTurnId=randomUUID(),b=>b.chapters[0].paragraphs=null,
  b=>b.chapters[0].paragraphs[0].sourceTurnIds=['unknown'],b=>b.avoidedTopics=[null],
  b=>b.sessions[0].id='"><button data-action="delete-book">',
  b=>b.sessions[0].turns.push({...b.sessions[0].turns[0]}),
  b=>b.manuscript={sections:[{id:randomUUID(),chapterId:randomUUID(),title:'test',unitIds:null}]},
  b=>b.manuscriptVersions=[{id:randomUUID(),chapters:[],evidence:null,avoidedHash:'test'}],
  b=>b.sessions[0].voiceRuns='invalid',b=>b.sessions[0].storySummary={title:{}}
 ];
 for(const mutate of cases){const b=fixture();mutate(b);assert.throws(()=>validateBackupBook(b),e=>e.status===400);}
});
