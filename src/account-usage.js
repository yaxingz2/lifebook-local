import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
const root=process.env.LIFEBOOK_DATA_DIR||join(homedir(),'LifeBook');
const queues=new Map();
const empty=()=>({version:1,since:new Date().toISOString(),updatedAt:null,chats:{},generations:{},voice:{}});
export async function readAccountUsage(directory){
  try{return JSON.parse(await readFile(join(directory,'account-usage.json'),'utf8'));}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
}
// Only identifiers, counters and timestamps are stored here, never conversation content.
export function recordAccountUsage(kind,id,value=1,directory=root){
  const previous=queues.get(directory)||Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>{
    if(!['chats','generations','voice'].includes(kind)||typeof id!=='string'||!id)throw new Error('Invalid usage event');
    if(!Number.isFinite(value)||value<0)throw new Error('Invalid usage duration');
    const data=await readAccountUsage(directory)||empty();
    const nextValue=kind==='voice'?Math.max(data.voice[id]||0,value):1;
    if(data[kind][id]===nextValue)return;
    data[kind][id]=nextValue;data.updatedAt=new Date().toISOString();
    await mkdir(directory,{recursive:true,mode:0o700});const path=join(directory,'account-usage.json');const tmp=path+'.'+randomUUID();
    await writeFile(tmp,JSON.stringify(data),{mode:0o600});await rename(tmp,path);
  });
  queues.set(directory,next);next.finally(()=>{if(queues.get(directory)===next)queues.delete(directory);}).catch(()=>{});return next;
}
export async function trackAccountUsage(kind,id,value=1){
  // A metrics failure must not turn a successfully saved story into a failed request.
  try{await recordAccountUsage(kind,id,value);}catch{console.error('Account usage could not be saved.');}
}
export function summarizeAccountUsage(data){
  if(!data)return {since:null,updatedAt:null,voiceSeconds:0,chatCount:0,generationCount:0};
  if(data.version!==1||!data.chats||!data.generations||!data.voice)throw new Error('Invalid usage data');
  return {since:data.since,updatedAt:data.updatedAt,voiceSeconds:Math.floor(Object.values(data.voice).reduce((sum,n)=>sum+(Number.isFinite(n)&&n>=0?n:0),0)),chatCount:Object.keys(data.chats).length,generationCount:Object.keys(data.generations).length};
}
