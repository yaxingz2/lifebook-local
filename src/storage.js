import {normalizeManuscriptStyle,manuscriptStyles} from './writing-style.js';
import { mkdir, readFile, writeFile, rename, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {voiceModels} from './models.js';
import {clearStaleStoryTitles} from './story-content.js';

export const dataRoot = process.env.LIFEBOOK_DATA_DIR || join(homedir(), 'LifeBook');
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertId(id) { if (!idPattern.test(id || '')) throw Object.assign(new Error('无效的 ID'), { status: 400 }); return id; }
export function bookPath(id) { return join(dataRoot, 'books', assertId(id) + '.json'); }
const configRoot = process.env.LIFEBOOK_SHARED_CONFIG_DIR || dataRoot;
const settingsPath = join(configRoot, 'settings.json');
const secretsPath = join(configRoot, 'secrets.json');
const voicePreferencesPath = join(dataRoot, 'voice-preferences.json');
const queue = new Map();
export function serial(key, fn) {
  const prev = queue.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queue.set(key, next);
  next.finally(() => { if (queue.get(key) === next) queue.delete(key); }).catch(() => {});
  return next;
}
async function atomicJson(path, value, mode = 0o600) {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomUUID() + '.tmp';
  const file = await open(temp, 'wx', mode);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temp, path);
  const dir = await open(join(path, '..'), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}
async function json(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
export async function getServiceSettings() {
  const raw=await json(settingsPath, {});
  // Do not carry removed provider/transport settings into the public config.
  const model='qwen-audio-3.0-realtime-flash';
  return {mode:raw.mode==='mock'||!raw.mode?'mock':'qwen',model:raw.model||'qwen3.8-flash',
    qwenConnection:'unified',qwenVoiceTransport:'webrtc',qwenVoiceModel:model,
    qwenSpeechRate:['slow','normal','fast'].includes(raw.qwenSpeechRate)?raw.qwenSpeechRate:'slow',
    qwenTurnDetection:raw.qwenTurnDetection==='server_vad'?'server_vad':'semantic_vad',
    qwenVoices:{[model]:voiceModels[model].voices.includes(raw.qwenVoices?.[model])?raw.qwenVoices[model]:voiceModels[model].voices[0]}};
}
export async function getSettings() {
  const settings=await getServiceSettings(),preferences=await json(voicePreferencesPath,{});
  const voice=preferences.qwenVoices?.[settings.qwenVoiceModel];
  if(voiceModels[settings.qwenVoiceModel]?.voices.includes(voice))settings.qwenVoices={...settings.qwenVoices,[settings.qwenVoiceModel]:voice};
  if(['slow','normal','fast'].includes(preferences.qwenSpeechRate))settings.qwenSpeechRate=preferences.qwenSpeechRate;
  settings.manuscriptStyle=normalizeManuscriptStyle(preferences.manuscriptStyle);
  return settings;
}
export async function saveVoicePreferences({model,voice,speechRate}) {
  return serial('voice-preferences',async()=>{
    const current=await json(voicePreferencesPath,{});
    const value={...current,qwenVoices:{...current.qwenVoices,[model]:voice},qwenSpeechRate:speechRate};
    await atomicJson(voicePreferencesPath,value);
  });
}
export async function saveUserPreferences({manuscriptStyle,model,voice,speechRate}) {
  if(!manuscriptStyles.includes(manuscriptStyle))throw Object.assign(new Error('请选择有效的书稿风格'),{status:400});
  const hasVoice=[model,voice,speechRate].some(value=>value!==undefined);
  if(hasVoice&&(!voiceModels[model]?.voices.includes(voice)||!['slow','normal','fast'].includes(speechRate)))throw Object.assign(new Error('请选择有效的音色和语速'),{status:400});
  return serial('voice-preferences',async()=>{
    const current=await json(voicePreferencesPath,{});
    const value={...current,manuscriptStyle};
    if(hasVoice){value.qwenVoices={...current.qwenVoices,[model]:voice};value.qwenSpeechRate=speechRate;}
    await atomicJson(voicePreferencesPath,value);
  });
}
export async function saveSettings(value) { return serial('settings', async () => { await atomicJson(settingsPath, value); return value; }); }
export async function getSecret() {
  // Regional/removed-provider credentials must never be reused at a new endpoint.
  return (await json(secretsPath, {})).qwenApiKey||'';
}
export async function saveSecret(apiKey) { return serial('secret', async () => {
  const secrets=await json(secretsPath, {});
  // Preserve legacy secrets on disk for manual recovery, but never expose or use them.
  await atomicJson(secretsPath,{...secrets,qwenApiKey:apiKey});
}); }
export async function publicSettings({service=false}={}){
  return {...await (service?getServiceSettings():getSettings()),hasKey:Boolean(await getSecret())};
}
export async function getBook(id) { const book = await json(bookPath(id), null); if (!book) throw Object.assign(new Error('找不到这本书'), { status: 404 }); clearStaleStoryTitles(book);return book; }
export async function saveBook(book) { return serial(book.id, async () => { clearStaleStoryTitles(book);await atomicJson(bookPath(book.id), book); return book; }); }
export async function updateBook(id, fn, {metadataOnly=false}={}) { return serial(assertId(id), async () => { const book = await getBook(id); const result = await fn(book); clearStaleStoryTitles(book);if(!metadataOnly)book.revision=(book.revision||0)+1; await atomicJson(bookPath(id), book); return result; }); }
export async function listBooks(archived=false) {
  await mkdir(join(dataRoot, 'books'), { recursive: true, mode: 0o700 });
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(join(dataRoot, 'books'));
  const books = [];
  for (const file of files) if (idPattern.test(file.replace(/\.json$/, '')) && file.endsWith('.json')) {
    try { const b = await getBook(file.slice(0, -5)); if(Boolean(b.archived)===archived)books.push({ id:b.id,title:b.title,name:b.name,createdAt:b.createdAt,updatedAt:b.updatedAt }); } catch { /* corrupt files stay untouched */ }
  }
  return books.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function newBook(title, name) { const now = new Date().toISOString(); return { schemaVersion:1,revision:0,id:randomUUID(),title,name,createdAt:now,updatedAt:now,sessions:[],claims:[],chapters:[],avoidedTopics:[] }; }
export function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export async function removeBook(id,title) {
  return serial(assertId(id),async()=>{
    const book=await getBook(id);
    if(title!==book.title)throw Object.assign(Error('请输入完整书名确认删除'),{status:400});
    await rm(bookPath(id));await clearManuscriptProgress(id);
    await serial('chapter-jobs',async()=>{
      const jobs=await readChapterJobs();await writeChapterJobs(jobs.filter(j=>j.bookId!==id));
    });
  });
}
export async function existsBook(id) { try { await stat(bookPath(id)); return true; } catch(e) { if(e.code==='ENOENT')return false;throw e; } }

export async function readChapterJobs() { return json(join(dataRoot,'chapter-jobs.json'),[]); }
export async function writeChapterJobs(jobs) { return atomicJson(join(dataRoot,'chapter-jobs.json'),jobs); }
export async function readManuscriptProgress(id) { return json(join(dataRoot,'manuscript-progress',assertId(id)+'.json'),null); }
export async function writeManuscriptProgress(id,value) { return atomicJson(join(dataRoot,'manuscript-progress',assertId(id)+'.json'),value); }
export async function clearManuscriptProgress(id) { return rm(join(dataRoot,'manuscript-progress',assertId(id)+'.json'),{force:true}); }


