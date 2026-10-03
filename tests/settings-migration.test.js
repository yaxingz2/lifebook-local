import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const directory=await mkdtemp(join(tmpdir(),'lifebook-settings-migration-'));
process.env.LIFEBOOK_DATA_DIR=directory;process.env.LIFEBOOK_SHARED_CONFIG_DIR=directory;
const store=await import('../src/storage.js');
test('new settings default to Flash while explicit model choices remain intact',async()=>{
 assert.equal((await store.getServiceSettings()).model,'qwen3.8-flash');
 await store.saveSettings({mode:'qwen'});
 assert.equal((await store.getServiceSettings()).model,'qwen3.8-flash');
 await store.saveSettings({mode:'qwen',model:'qwen3.8-max'});
 assert.equal((await store.getServiceSettings()).model,'qwen3.8-max');
});
test('removed settings normalize without reusing credentials or touching saved books',async t=>{
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const raw={mode:'openai',openaiVoice:'marin',openaiTextModel:'old',qwenVoiceModel:'qwen-audio-3.1-realtime-plus',qwenVoiceTransport:'websocket',region:'cn-beijing',workspaceId:'legacy',qwenProfiles:{},model:'qwen3.8-flash'};
 await writeFile(join(directory,'settings.json'),JSON.stringify(raw));
 await writeFile(join(directory,'secrets.json'),JSON.stringify({openaiApiKey:'old-openai',apiKey:'old-regional',qwenKeys:{'cn-beijing':'old-regional'}}));
 const book=store.newBook('保留的故事','');await store.saveBook(book);
 const settings=await store.publicSettings();assert.equal(settings.mode,'qwen');assert.equal(settings.qwenVoiceTransport,'webrtc');assert.equal(settings.qwenVoiceModel,'qwen-audio-3.0-realtime-flash');assert.equal(settings.model,'qwen3.8-flash');assert.equal(settings.hasKey,false);
 for(const key of ['workspaceId','region','qwenProfiles','openaiVoice','openaiTextModel','hasOpenaiKey'])assert.equal(settings[key],undefined);
 assert.equal(await store.getSecret(),'');await store.saveSecret('new-unified');assert.equal(await store.getSecret(),'new-unified');
 assert.ok(!JSON.stringify(await store.publicSettings()).includes('new-unified'));assert.equal((await store.getBook(book.id)).title,book.title);
 assert.equal(JSON.parse(await readFile(join(directory,'secrets.json'),'utf8')).openaiApiKey,'old-openai');
 assert.deepEqual(JSON.parse(await readFile(join(directory,'settings.json'),'utf8')),raw,'read-time migration preserves the original config');
});
