import {readVoiceDiagnostics} from './voice-diagnostics.js';
import {validateBackupBook} from './backup.js';
import {trackAccountUsage} from './account-usage.js';
import {startChapterJob,listChapterJobs,dismissChapterJob,restoreManuscript,retryChapterJob,manuscriptPreview,clearChapterJobSourceProgress} from './chapter-jobs.js';
import {voiceModels,selectedModel} from './models.js';
import { normalizeFocus, focusLabel, buildContext } from './context.js';
import { openingRequestFor } from './interview.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { getSettings, getServiceSettings, saveVoicePreferences, saveUserPreferences, saveSettings, publicSettings, getSecret, saveSecret, getBook, saveBook, updateBook, listBooks, newBook, digest, existsBook, removeBook, clearManuscriptProgress } from './storage.js';
import { turn, mockOpening, mockReply, qwenReply, extractClaim, createChapter, qwenChapter, refusedTopic, invalidate, safeChapter, sourceText, purgeSource, currentClaims } from './engine.js';
import { attachVoiceUpgrade } from './voice.js';
import {storyDescriptor} from './story-content.js';
import {refreshStoryTitles} from './story-titles.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const port = Number(process.env.PORT || 0);
const token = randomBytes(32).toString('hex');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml' };
const error = (message, status=400) => Object.assign(new Error(message), {status});
const requireString = (x, limit=4000) => { if (typeof x !== 'string' || !x.trim() || x.length > limit) throw error('请输入有效内容'); return x.trim(); };
const esc = x => String(x).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
const BACKUP_LIMIT=100*1024*1024;
async function body(req, limit=2_000_000) {
  const tooLarge=()=>error(limit===BACKUP_LIMIT?'备份文件超过 100 MB，请使用较小的备份。':'请求过大',413);
  if(Number(req.headers['content-length'])>limit)throw tooLarge();
  const chunks=[]; let total=0;
  for await (const chunk of req) { total+=chunk.length; if(total>limit) throw tooLarge(); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw error('无效 JSON'); }
}
function send(res, status, data, type='application/json; charset=utf-8', extra={}) {
  const payload=type.startsWith('application/json') ? JSON.stringify(data) : data;
  res.writeHead(status, {'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}); res.end(payload);
}
function findSession(book,id) { const s=book.sessions.find(x=>x.id===id); if(!s) throw error('找不到聊天记录',404); return s; }
function findTurn(session,id) { const t=session.turns.find(x=>x.id===id&&x.role==='user'); if(!t) throw error('找不到这段内容',404); return t; }
function download(res,name,content,type) { res.writeHead(200,{'Content-Type':type,'Content-Disposition':`attachment; filename="${name}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(content); }
function exported(book,format) {
  const chapters=book.chapters.map(c=>safeChapter(book,c));
  const md=`# ${book.title}\n\n${chapters.map(c=>`## ${c.title}\n\n${c.paragraphs.map(p=>(p.sectionTitle?'### '+p.sectionTitle+'\n\n':'')+p.text).join('\n\n')}`).join('\n\n')}`;
  if(format==='md') return md;
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${esc(book.title)}</title><style>body{font:18px/1.8 Georgia,serif;max-width:42em;margin:3em auto;padding:0 1em;color:#29251f}h1,h2{font-family:system-ui}p{break-inside:avoid}@media print{body{margin:0}}</style><h1>${esc(book.title)}</h1>${chapters.map(c=>`<h2>${esc(c.title)}</h2>${c.paragraphs.map(p=>` ${p.sectionTitle?`<h3>${esc(p.sectionTitle)}</h3>`:""}<p>${esc(p.text)}</p>`).join('')}`).join('')}</html>`;
}
async function route(req,res,url) {
  const path=url.pathname, method=req.method;
  if(path==='/api/bootstrap' && method==='GET') {
    const settings=await getSettings();
    return send(res,200,{token,books:await listBooks(),archivedBooks:await listBooks(true),settings:await publicSettings(),serviceSettings:await publicSettings({service:true}),voiceModels,webrtcAvailable:process.env.LIFEBOOK_WEBRTC_ALLOWED!=='0'});
  }
  if(req.headers['x-lifebook-token']!==token) throw error('未授权请求',403);
  if(path==='/api/voice-diagnostics'&&method==='GET')return download(res,'lifebook-voice-diagnostics.jsonl',await readVoiceDiagnostics(),'text/plain; charset=utf-8');
  if(path==='/api/chapter-jobs'&&method==='GET')return send(res,200,await listChapterJobs());
  if(path==='/api/chapter-jobs/dismiss'&&method==='POST'){const b=await body(req);await dismissChapterJob(b.id);return send(res,200,{ok:true});}
  if(path==='/api/chapter-jobs/retry'&&method==='POST'){const b=await body(req);return send(res,202,await retryChapterJob(b.id));}
  if(path==='/api/user-preferences'&&method==='PUT') {
    const b=await body(req),settings=await getSettings();
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(key=>!['model','voice','speechRate','manuscriptStyle'].includes(key)))throw error('这里只能修改自己的声音和书稿偏好');
    const hasVoice=['model','voice','speechRate'].some(key=>Object.hasOwn(b,key));
    if(hasVoice&&(settings.mode!=='qwen'||b.model!==settings.qwenVoiceModel))throw error('语音服务已更新，请刷新后重新选择',409);
    await saveUserPreferences(b);
    const updated=await getSettings();
    return send(res,200,{manuscriptStyle:updated.manuscriptStyle,qwenVoices:updated.qwenVoices,qwenSpeechRate:updated.qwenSpeechRate});
  }
  if(path==='/api/voice-preferences'&&method==='PUT') {
    const b=await body(req),settings=await getSettings();
    if(!b||Array.isArray(b)||typeof b!=='object'||Object.keys(b).some(key=>!['model','voice','speechRate'].includes(key)))throw error('这里只能修改自己的音色和语速');
    if(settings.mode!=='qwen'||!voiceModels[settings.qwenVoiceModel])throw error('当前语音服务暂不支持个人声音设置');
    if(b.model!==settings.qwenVoiceModel)throw error('语音服务已更新，请刷新后重新选择',409);
    if(!voiceModels[b.model].voices.includes(b.voice))throw error('此模型不支持所选音色');
    if(!['slow','normal','fast'].includes(b.speechRate))throw error('无效语速偏好');
    await saveVoicePreferences(b);
    const updated=await getSettings();
    return send(res,200,{qwenVoices:updated.qwenVoices,qwenSpeechRate:updated.qwenSpeechRate});
  }
  if(path==='/api/settings') {
    if(method==='GET') { return send(res,200,await publicSettings({service:true})); }
    if(method==='PUT') {
      const b=await body(req), current=await getServiceSettings();
      if(!['mock','qwen'].includes(b.mode)) throw error('无效模式');
      if(b.qwenConnection!==undefined&&b.qwenConnection!=='unified')throw error('仅支持千问统一入口');
      const settings={...current,mode:b.mode,model:String(b.model||current.model).trim()};
      if(!/^[a-zA-Z0-9._-]{1,100}$/.test(settings.model))throw error('无效文字模型');
      settings.qwenVoiceModel=b.qwenVoiceModel??current.qwenVoiceModel;
      if(voiceModels[settings.qwenVoiceModel]?.provider!=='qwen')throw error('请选择支持的千问实时模型');
      settings.qwenSpeechRate=b.qwenSpeechRate??current.qwenSpeechRate;
      if(!['slow','normal','fast'].includes(settings.qwenSpeechRate))throw error('无效千问语速偏好');
      settings.qwenTurnDetection=b.qwenTurnDetection??current.qwenTurnDetection;
      if(!['semantic_vad','server_vad'].includes(settings.qwenTurnDetection))throw error('无效千问聊天节奏');
      settings.qwenVoiceTransport=b.qwenVoiceTransport??current.qwenVoiceTransport;
      if(settings.qwenVoiceTransport!=='webrtc')throw error('无效语音连接方式');
      settings.qwenVoices={...current.qwenVoices};
      const chosen=b.qwenVoice??settings.qwenVoices[settings.qwenVoiceModel]??voiceModels[settings.qwenVoiceModel].voices[0];
      if(!voiceModels[settings.qwenVoiceModel].voices.includes(chosen))throw error('此模型不支持所选音色');
      settings.qwenVoices[settings.qwenVoiceModel]=chosen;
      if(b.apiKey!==undefined&&(typeof b.apiKey!=='string'||b.apiKey.length>500))throw error('无效 API Key');
      // Validate the whole form before changing any secrets.
      if(b.apiKey?.trim())await saveSecret(b.apiKey.trim());
      await saveSettings(settings);return send(res,200,await publicSettings({service:true}));
    }
  }
  if(path==='/api/books' && method==='POST') {
    const b=await body(req), book=newBook(requireString(b.title,100),String(b.name||'').trim().slice(0,80));
    await saveBook(book); return send(res,201,book);
  }
  if(path==='/api/restore' && method==='POST') {
    const b=await body(req,BACKUP_LIMIT);
    let backup=b;
    if(b&&Object.hasOwn(b,'archive')){
      if(typeof b.archive!=='string')throw error('备份格式错误');
      try {backup=JSON.parse(Buffer.from(b.archive,'base64').toString('utf8'));} catch {throw error('备份无法读取');}
    }
    if(!backup||backup.format!=='lifebook-backup-v1'||!backup.book||digest(backup.book)!==backup.checksum||backup.book.schemaVersion!==1) throw error('备份校验失败');
    const book=validateBackupBook(backup.book);
    book.id=randomUUID(); book.archived=false; book.title=String(book.title||'恢复的故事').slice(0,100); book.updatedAt=new Date().toISOString();
    // Import each book under a fresh generated ID; never accept file paths from archives.
    await saveBook(book); return send(res,201,book);
  }
  const bookMatch=path.match(/^\/api\/books\/([0-9a-f-]{36})(?:\/(.*))?$/i);
  if(bookMatch) {
    const id=bookMatch[1], suffix=bookMatch[2]||'';
    if(!suffix&&method==='DELETE'){const data=await body(req);await removeBook(id,data.confirmTitle);return send(res,200,{ok:true});}
    if(suffix==='archive'&&method==='POST') { const data=await body(req);if(typeof data.archived!=='boolean')throw error('无效归档状态');await updateBook(id,b=>{b.archived=data.archived;});return send(res,200,{ok:true}); }
    if(suffix==='context'&&method==='GET') {const book=await getBook(id);const session=book.sessions.find(s=>s.id===url.searchParams.get('sessionId'))||book.sessions.at(-1)||{turns:[]};return send(res,200,buildContext(book,session,url.searchParams.get('q')||''));}
    if(!suffix&&method==='GET') {const book=await getBook(id),sessions=book.sessions.map(s=>({...s,...storyDescriptor(book,s)}));return send(res,200,{book:{...book,sessions},sessions,claims:currentClaims(book),chapters:book.chapters.map(c=>safeChapter(book,c))});}
    if(suffix==='story-titles'&&method==='POST') {const b=await body(req);if(!Array.isArray(b.sessionIds)||b.sessionIds.length>2||b.sessionIds.some(x=>typeof x!=='string'))throw error('请选择最多两次聊天');return send(res,200,await refreshStoryTitles(id,b.sessionIds));}
    if(suffix==='backup'&&method==='GET') {
      const book=await getBook(id), archive={format:'lifebook-backup-v1',book,checksum:digest(book)};
      return download(res,`lifebook-${id}.json`,JSON.stringify(archive,null,2),'application/json; charset=utf-8');
    }
    if(suffix==='export'&&method==='GET') {
      const format=url.searchParams.get('format'); if(!['md','html'].includes(format)) throw error('不支持的格式');
      const book=await getBook(id); return download(res,`lifebook-${id}.${format}`,exported(book,format),format==='md'?'text/markdown; charset=utf-8':'text/html; charset=utf-8');
    }
    if(suffix==='sessions'&&method==='POST') {
      const options=await body(req);
      const session={id:randomUUID(),startedAt:new Date().toISOString(),endedAt:null,turns:[],intent:options.intent==='new_topic'?'new_topic':'continue',focus:normalizeFocus(options.focus)};
      const book=await getBook(id), settings=await getSettings();
      if(options.voice===true){
        if(settings.mode!=='qwen'||!await getSecret())throw error('请先填写千问统一入口的 API Key');
        if(process.env.LIFEBOOK_WEBRTC_ALLOWED==='0')throw error('此安装尚未启用 WebRTC');
        session.voiceOnly=true;session.provider=settings.mode;session.voiceModel=selectedModel(settings);
      }else{
        const opening=settings.mode!=='mock' ? await qwenReply(book,{...session,turns:[turn('user',openingRequestFor(buildContext(book,session).payload.interview))]},settings,await getSecret(settings.mode)) : options.focus ? `你好，我是 LifeBook 的访谈主持人。怎么称呼你比较方便？` : mockOpening(book);
        const first=turn('assistant',opening);session.turns.push(first);
      }
      await updateBook(id,b=>{if((b.revision||0)!==(book.revision||0))throw error('书籍内容已变化，请重试',409);b.sessions.push(session);b.updatedAt=new Date().toISOString();});
      await trackAccountUsage('chats',session.id);
      return send(res,201,session);
    }
    const sessionDelete=suffix.match(/^sessions\/([0-9a-f-]{36})$/i);
    if(sessionDelete&&method==='DELETE'){
      await updateBook(id,async book=>{
        const session=findSession(book,sessionDelete[1]);
        const sourceIds=new Set(session.turns.filter(t=>t.role==='user').map(t=>t.id));
        for(const tid of sourceIds)purgeSource(book,tid);
        await clearManuscriptProgress(id);
        await clearChapterJobSourceProgress(id);
        book.claims=book.claims.filter(c=>!sourceIds.has(c.sourceTurnId));
        book.sessions=book.sessions.filter(s=>s.id!==session.id);
        book.updatedAt=new Date().toISOString();
      });
      return send(res,200,{ok:true});
    }
    const turns=suffix.match(/^sessions\/([0-9a-f-]{36})\/turns(?:\/([0-9a-f-]{36}))?$/i);
    if(turns && method==='POST'&&!turns[2]) {
      const b=await body(req), text=requireString(b.text), sid=turns[1], userTurn=turn('user',text);
      const book=await getBook(id), s=findSession(book,sid), settings=await getSettings();
      const refusal=/(?:不要再提|别再提|别提|不想聊|不要聊)/.test(text);
      let avoided=refusedTopic(text);
      if(refusal&&!avoided)avoided=s.turns.filter(t=>t.role==='user'&&!t.avoided).at(-1)?.text.slice(0,50)||'';
      const answer=refusal?'好的，我们换个话题。你记忆里有没有一顿特别难忘的饭？':settings.mode!=='mock'?await qwenReply(book,{...s,turns:[...s.turns,userTurn]},settings,await getSecret(settings.mode)):mockReply(text,book);
      const assistantTurn=turn('assistant',answer,{replyToId:userTurn.id});
      await updateBook(id,currentBook=>{
        if((currentBook.revision||0)!==(book.revision||0))throw error('聊天内容已变化，请重试',409);
        const current=findSession(currentBook,sid);current.endedAt=null;
        if(refusal){userTurn.avoided=true;if(avoided&&!currentBook.avoidedTopics.some(x=>x.topic===avoided))currentBook.avoidedTopics.push({topic:avoided,createdAt:new Date().toISOString()});
          const matching=refusedTopic(text)?currentBook.sessions.flatMap(session=>session.turns).filter(t=>t.role==='user'&&!t.avoided&&t.text.includes(avoided)):[...current.turns].reverse().filter(t=>t.role==='user'&&!t.avoided).slice(0,1);
          for(const previous of matching){previous.avoided=true;previous.excludedFromBook=true;for(const session of currentBook.sessions){const index=session.turns.findIndex(t=>t.id===previous.id);if(index>=0&&session.turns[index+1]?.role==='assistant')session.turns[index+1].avoided=true;}invalidate(currentBook,previous.id);}
        }
        current.turns.push(userTurn,assistantTurn);if(!refusal)currentBook.claims.push(extractClaim(userTurn));currentBook.updatedAt=new Date().toISOString();
      });
      return send(res,201,{userTurn,assistantTurn,claims:(await getBook(id)).claims});
    }
    if(turns?.[2]&&['PATCH','DELETE'].includes(method)) {
      const sid=turns[1], tid=turns[2], data=method==='PATCH'?await body(req):{};
      const result=await updateBook(id,async book=>{
        const s=findSession(book,sid), t=findTurn(s,tid);
        if(method==='DELETE') {
          purgeSource(book,tid);
          // The book lock also guards checkpoint saves. An in-flight job will
          // recheck its source snapshot before it can write another checkpoint.
          await clearManuscriptProgress(id);
          await clearChapterJobSourceProgress(id);
          const position=s.turns.findIndex(x=>x.id===tid);
          const dependent=s.turns[position+1]?.role==='assistant' ? s.turns[position+1].id : null;
          s.turns=s.turns.filter(x=>x.id!==tid&&x.replyToId!==tid&&x.id!==dependent); book.claims=book.claims.filter(c=>c.sourceTurnId!==tid);
        } else {
          if(data.text!==undefined) {t.text=requireString(data.text,1_000_000);const position=s.turns.findIndex(x=>x.id===tid);const dependent=s.turns[position+1]?.role==='assistant'?s.turns[position+1].id:null;s.turns=s.turns.filter(x=>x.replyToId!==tid&&x.id!==dependent);for(const c of book.claims) if(c.sourceTurnId===tid) {c.text=t.text;c.status='proposed';}}
          if(data.excludedFromBook!==undefined) {if(typeof data.excludedFromBook!=='boolean') throw error('无效选项'); t.excludedFromBook=data.excludedFromBook;}
        }
        invalidate(book,tid);book.updatedAt=new Date().toISOString();return {turn:t,claims:book.claims};
      }); return send(res,200,result);
    }
    const end=suffix.match(/^sessions\/([0-9a-f-]{36})\/end$/i);
    // Older browser tabs still call /end. Save an exit without locking the story.
    if(end&&method==='POST') {const result=await updateBook(id,book=>{const s=findSession(book,end[1]);s.lastExitedAt=new Date().toISOString();s.endedAt=null;return s;},{metadataOnly:true});return send(res,200,result);}
    if(suffix==='topic'&&method==='POST') {
      const b=await body(req), topic=String(b.topic||'').trim().slice(0,100), nextTopic=String(b.nextTopic||'').trim().slice(0,100);
      const book=await getBook(id), s=b.sessionId?book.sessions.find(x=>x.id===b.sessionId):book.sessions.at(-1);
      if(!s) throw error('请先开始聊天');
      const settings=await getSettings();
      if(topic) await updateBook(id,x=>{if(!x.avoidedTopics.some(a=>a.topic===topic))x.avoidedTopics.push({topic,createdAt:new Date().toISOString()});});
      const prompt=nextTopic?`换个话题，问我一个关于「${nextTopic}」的轻松开放问题。`:'换一个轻松的话题，不要继续刚才的话题，只问一个开放问题。';
      if(b.focus)await updateBook(id,x=>{findSession(x,s.id).focus=normalizeFocus(b.focus);});
      const fresh=await getBook(id);
      const answer=settings.mode!=='mock'?await qwenReply(fresh,{...fresh.sessions.find(x=>x.id===s.id),turns:[...s.turns,turn('user',prompt)]},settings,await getSecret(settings.mode)):nextTopic?`我们聊聊${nextTopic}吧。你最先想到的是哪件事？`:'我们换个话题。你记忆里有没有一顿特别难忘的饭？';
      const assistantTurn=turn('assistant',answer);
      await updateBook(id,x=>{findSession(x,s.id).turns.push(assistantTurn);});
      return send(res,200,{topic,assistantTurn});
    }
    if(suffix==='topic'&&method==='DELETE') {const b=await body(req);await updateBook(id,book=>{book.avoidedTopics=book.avoidedTopics.filter(x=>x.topic!==b.topic);});return send(res,200,{ok:true});}
    const claim=suffix.match(/^claims\/([0-9a-f-]{36})$/i);
    if(claim&&method==='PATCH') {const b=await body(req);const result=await updateBook(id,book=>{const c=book.claims.find(x=>x.id===claim[1]);if(!c) throw error('找不到记忆',404);if(b.text!==undefined)c.text=requireString(b.text,1_000_000);if(b.status!==undefined){if(!['proposed','confirmed','rejected'].includes(b.status))throw error('无效状态');c.status=b.status;}c.updatedAt=new Date().toISOString();invalidate(book,c.sourceTurnId);return c;});return send(res,200,result);}
    if(suffix==='manuscript/restore'&&method==='POST'){const b=await body(req);return send(res,200,await restoreManuscript(id,requireString(b.versionId,80)));}
    if(suffix==='manuscript/progress'&&method==='GET')return send(res,200,await manuscriptPreview(id));
    if(suffix==='chapter-jobs'&&method==='POST'){const b=await body(req);return send(res,202,await startChapterJob(id,requireString(b.title,80),undefined,['update','reorganize'].includes(b.mode)?b.mode:'append'));}
    if(suffix==='chapters'&&method==='POST') {
      const b=await body(req), book=await getBook(id), settings=await getSettings();
      const chapter=settings.mode!=='mock'?await qwenChapter(book,String(b.title||''),settings,await getSecret(settings.mode)):createChapter(book,String(b.title||''));
      await updateBook(id,current=>{if((current.revision||0)!==(book.revision||0))throw error('素材已变化，请重试',409);current.chapters.push(chapter);});await trackAccountUsage('generations',chapter.id);return send(res,201,chapter);
    }
  }
  throw error('页面不存在',404);
}

export function createApp() {
  const server=http.createServer(async(req,res)=>{
    try {
      const host=req.headers.host, allowed=new Set([`127.0.0.1:${server.address().port}`,`localhost:${server.address().port}`]);
      if(!allowed.has(host)) throw error('无效 Host',403);
      const origin=req.headers.origin;
      if(origin&&!allowed.has(new URL(origin).host)) throw error('无效 Origin',403);
      res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://${host}; media-src 'self' blob:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
      res.setHeader('Referrer-Policy','no-referrer');
      const url=new URL(req.url,`http://${host}`);
      if(url.pathname.startsWith('/api/')) {
        if(!['GET','POST','PATCH','PUT','DELETE'].includes(req.method)) throw error('不支持的方法',405);
        if(req.method!=='GET'&&origin!==`http://${host}`) throw error('缺少有效 Origin',403);
        return await route(req,res,url);
      }
      if(req.method!=='GET') throw error('不支持的方法',405);
      const pathname=url.pathname==='/'?'/index.html':url.pathname;
      if(!['/index.html','/app.js','/style.css','/voice-health.js','/webrtc-voice.js','/voice-transcript.js','/chat-transcript.js'].includes(pathname)) throw error('页面不存在',404);
      const file=join(publicDir,normalize(pathname).replace(/^\/+/,''));
      const data=await readFile(file); return send(res,200,data,mime[extname(file)]||'application/octet-stream');
    } catch(e) { if(!res.headersSent) send(res,e.status||500,{error:e.status?e.message:'内部错误'}); }
  });
  attachVoiceUpgrade(server,token);
  return server;
}

if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const app=createApp(); app.listen(port,'127.0.0.1',()=>console.log(`LifeBook: http://127.0.0.1:${app.address().port}`));
}

