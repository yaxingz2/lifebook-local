import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recordAccountUsage,readAccountUsage,summarizeAccountUsage} from '../src/account-usage.js';
test('usage counters deduplicate concurrent events and keep the maximum voice snapshot',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lifebook-metrics-'));
 try{
  await Promise.all([recordAccountUsage('chats','s1',1,dir),recordAccountUsage('chats','s1',1,dir),recordAccountUsage('chats','s2',1,dir),recordAccountUsage('generations','j1',1,dir),recordAccountUsage('voice','v1',65.8,dir),recordAccountUsage('voice','v1',60,dir),recordAccountUsage('voice','v1',65.8,dir),recordAccountUsage('voice','v2',4.6,dir)]);
  const summary=summarizeAccountUsage(await readAccountUsage(dir));assert.equal(summary.chatCount,2);assert.equal(summary.generationCount,1);assert.equal(summary.voiceSeconds,70);
  assert.equal(summarizeAccountUsage(await readAccountUsage(join(dir,'another-user'))).chatCount,0);
  await assert.rejects(recordAccountUsage('voice','bad',Infinity,dir));assert.equal(summarizeAccountUsage(await readAccountUsage(dir)).voiceSeconds,70);
  const raw=await readFile(join(dir,'account-usage.json'),'utf8');assert.ok(!raw.includes('turns'));assert.ok(!raw.includes('text'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
