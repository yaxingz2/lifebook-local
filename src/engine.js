import {manuscriptStyleInstructions} from './writing-style.js';
import { contextInstructions, buildContext } from './context.js';
import { interviewGuidance } from './interview.js';
import { randomUUID } from 'node:crypto';
import {cleanProse} from './prose.js';
import {usableEvidence} from './evidence.js';

const now = () => new Date().toISOString();
export const turn = (role, text, extra = {}) => ({ id: randomUUID(), role, text, createdAt: now(), ...extra });
const clean = text => String(text || '').trim().slice(0, 4000);
const recentUserTurns = book => book.sessions.flatMap(s => s.turns).filter(t => usableEvidence(book,t,book.claims.find(c=>c.sourceTurnId===t.id))).slice(-8);
export function sourceText(book, id) { return book.sessions.flatMap(s => s.turns).find(t => t.id === id && t.role === 'user' && !t.deleted); }
export function currentClaims(book) { return book.claims.filter(c => usableEvidence(book,sourceText(book,c.sourceTurnId),c)); }
function lastUseful(book) { return currentClaims(book).at(-1)?.text || recentUserTurns(book).at(-1)?.text || ''; }
function snippet(text, max = 65) { return clean(text).replace(/[\n\r]+/g, ' ').slice(0, max); }

export function mockOpening(book) {
  const previous = lastUseful(book);
  if (previous) return `上次你提到「${snippet(previous, 35)}」。如果愿意，我们可以接着聊：当时还有谁在场？`;
  return `你好${book.name ? '，' + book.name : ''}。我们轻松聊聊吧：你小时候最常待的一个地方是什么样的？`;
}
export function mockReply(text, book) {
  const t = clean(text);
  if (/不想聊|别提|不想说|跳过/.test(t)) return '好，我们换个话题。有没有一道食物，会让你想起以前的某个时刻？';
  if (/学校|老师|同学|上学|大学/.test(t)) return '听起来学校里有不少故事。那时候有哪个人让你印象特别深？';
  if (/妈妈|爸爸|父亲|母亲|奶奶|爷爷|家人/.test(t)) return '你提到了家人。能讲一个你们在一起的具体场景吗？';
  if (/搬家|城市|村|家乡|地方|街/.test(t)) return '那个地方在你记忆里是什么样的？有没有一个画面现在还记得？';
  if (/朋友|伙伴/.test(t)) return '你们是怎么认识的？有没有一件一起经历的事？';
  const first = t.split(/[。！？.!?，,]/).find(Boolean) || t;
  return `你说到「${snippet(first, 28)}」。那时发生了什么，让这件事一直留在你记忆里？`;
}

export function qwenEndpoint() { return 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions'; }

function prompt(book, session) {
  const context=buildContext(book,session);
  return [{role:'system',content:contextInstructions(book,session)+'\n'+interviewGuidance},
    ...context.payload.recentConversation.map(t=>({role:t.role,content:t.text}))];
}

export async function qwenReply(book, session, settings, apiKey) {
  if (!apiKey) throw Object.assign(new Error('请先填写千问 API Key'), { status: 400 });
  const url = qwenEndpoint(settings);
  const response = await fetch(url, { method:'POST', headers:{ Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json' }, body: JSON.stringify({ model: settings.model || 'qwen3.8-flash', messages: prompt(book, session), ...textOptions(settings,240,0.7) }), signal:AbortSignal.timeout(30000) });
  if (!response.ok) throw Object.assign(new Error(`服务商请求失败（HTTP ${response.status}）。请检查 API Key、模型权限和余额。`), { status:502 });
  const result = await response.json();
  const answer = clean(result.choices?.[0]?.message?.content);
  if (!answer) throw Object.assign(new Error('服务商返回了空回复'), { status:502 });
  return answer;
}

export function extractClaim(userTurn) { return { id:randomUUID(), text:userTurn.text, sourceTurnId:userTurn.id, status:'proposed', createdAt:now() }; }
export function createChapter(book, title) {
  const claims = currentClaims(book).filter(c => !sourceText(book, c.sourceTurnId).excludedFromBook);
  const paragraphs = claims.map(c => ({ id:randomUUID(), text:c.text, sourceTurnIds:[c.sourceTurnId], status:'needs_review' }));
  return { id:randomUUID(), title:clean(title) || '我的故事', kind:'source_collection', paragraphs, status:'draft', createdAt:now(), updatedAt:now(), note:'演示模式：按原话汇集素材，尚未写成连贯章节；请本人审阅。' };
}
export function refusedTopic(text) {
  const match=String(text).trim().match(/(?:不要再提|别再提|别提|不想聊|不要聊)(.{0,30}?)(?:[。！？.!?]|$)/);
  if(!match)return null;
  return match[1].replace(/^(这个|这件事|了|关于)/,'').trim() || null;
}
export async function qwenChapter(book,title,settings,apiKey,update=false) {
  if(!apiKey)throw Object.assign(new Error('请先填写千问 API Key'),{status:400});
  const claims=currentClaims(book).filter(c=>!sourceText(book,c.sourceTurnId).excludedFromBook);
  if(!claims.length)return createChapter(book,title);
  const allowed=new Map(claims.map(c=>[c.sourceTurnId,c]));
  const evidence=claims.map(c=>({sourceTurnId:c.sourceTurnId,text:c.text}));
  const system=(update?'这是整本书稿更新：依据全部当前证据自动划分有意义的章节，给每章起简短具体的中文标题；相同经历合并去重，新增细节补入对应章节，不同主题或人生阶段按需另起章节。不要按聊天次数机械分章，素材少时只写一章。保留不同经历的独有事实。用户提供的标题是整本书名，不要用它筛选掉其他主题。输出 JSON 对象 {"chapters":[{"title":"章节标题","paragraphs":[{"text":"正文","sourceTurnIds":["真实来源ID"]}]}]}。':'')+'你是谨慎的回忆录编辑。只使用证据中的事实，写成连贯的中文段落。不得编造日期、直接引语、人物关系、心理活动或感官细节。每段至少有一条真实来源；没有材料返回空数组。'+(update?'':'只返回 JSON 对象 {"paragraphs":[{"text":"正文","sourceTurnIds":["真实来源ID"]}]}。');
  const response=await fetch(qwenEndpoint(settings),{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:settings.model||'qwen3.8-flash',messages:[{role:'system',content:system+'\n'+manuscriptStyleInstructions(settings.manuscriptStyle)},{role:'user',content:JSON.stringify({title,evidence})}],...textOptions(settings,update?8000:2000,0.2)}),signal:AbortSignal.timeout(180000)});
  if(!response.ok)throw Object.assign(new Error(`章节生成失败（HTTP ${response.status}）`),{status:502});
  const result=await response.json();let parsed;
  try{parsed=JSON.parse(String(result.choices?.[0]?.message?.content||'').replace(/^```(?:json)?\s*|\s*```$/g,''));}catch{throw Object.assign(new Error('模型未返回可核查的章节格式'),{status:502});}
  const drafts=update?parsed.chapters:[{title,paragraphs:parsed.paragraphs}];
  if(!Array.isArray(drafts)||drafts.some(c=>!c||!Array.isArray(c.paragraphs)))throw Object.assign(new Error('书稿缺少有效章节或出处'),{status:502});
  const chapters=drafts.slice(0,30).map(draft=>{
    const paragraphs=draft.paragraphs.slice(0,120).map(p=>({id:randomUUID(),text:clean(p.text),sourceTurnIds:Array.isArray(p.sourceTurnIds)?[...new Set(p.sourceTurnIds.filter(id=>allowed.has(id)))]:[],status:'needs_review'})).filter(p=>p.text&&p.sourceTurnIds.length);
    return {id:randomUUID(),title:clean(draft.title)||'我的故事',kind:'composed',paragraphs,status:'needs_review',createdAt:now(),updatedAt:now(),note:'AI 整理的草稿；来源 ID 已检查，事实与出处是否一致仍需本人核对。'};
  }).filter(c=>c.paragraphs.length);
  if(update)return chapters;
  return chapters[0]||{id:randomUUID(),title:clean(title)||'我的故事',kind:'composed',paragraphs:[],status:'needs_review',createdAt:now(),updatedAt:now()};
}
export function invalidate(book, sourceId) {
  for(const section of book.manuscript?.sections||[]){
    if(section.paragraphs?.some(p=>p.sourceTurnIds.includes(sourceId))){section.summary='';section.issues=[];}
  }
  for (const chapter of book.chapters) if (chapter.paragraphs.some(p => p.sourceTurnIds.includes(sourceId))) {
    chapter.status = 'needs_review'; chapter.invalidated = true; chapter.updatedAt = now();
  }
}
// Erase generated copies as well as the original record. Historical snapshots
// retain their evidence hashes so restoring a redacted version still fails safely.
export function purgeSource(book, sourceId) {
  const claimIds=new Set(book.claims.filter(c=>c.sourceTurnId===sourceId).map(c=>c.id));
  const unitMatches=id=>claimIds.has(String(id).split(':')[0]);
  const paragraphMatches=p=>p.sourceTurnIds?.includes(sourceId);
  const affectedSections=new Set([book,...book.manuscriptVersions||[]].flatMap(snapshot=>(snapshot.manuscript?.sections||[]).filter(s=>s.paragraphs?.some(paragraphMatches)||(s.unitIds||[]).some(unitMatches)).map(s=>s.id)));
  const affectedChapters=new Set([book,...book.manuscriptVersions||[]].flatMap(snapshot=>[
    ...snapshot.chapters.filter(c=>c.paragraphs.some(paragraphMatches)).map(c=>c.id),
    ...(snapshot.manuscript?.sections||[]).filter(s=>affectedSections.has(s.id)).map(s=>s.chapterId)
  ]));
  const scrubHeading=p=>{
    if(p.sectionTitle&&(!p.sectionId||affectedSections.has(p.sectionId)))p.sectionTitle='待更新小节';
    return p;
  };
  function chapters(items=[]) {
    return items.flatMap(chapter=>{
      const touched=chapter.paragraphs.some(paragraphMatches);
      if(!touched)return [chapter];
      chapter.paragraphs=chapter.paragraphs.filter(p=>!paragraphMatches(p)).map(scrubHeading);
      if(!chapter.paragraphs.length)return [];
      chapter.title='待更新章节';chapter.invalidated=true;chapter.status='needs_review';
      return [chapter];
    });
  }
  function manuscript(state) {
    if(!state)return;
    state.sections=(state.sections||[]).flatMap(section=>{
      const touched=section.paragraphs?.some(paragraphMatches)||(section.unitIds||[]).some(unitMatches);
      if(!touched)return [section];
      section.paragraphs=(section.paragraphs||[]).filter(p=>!paragraphMatches(p)).map(scrubHeading);
      section.unitIds=(section.unitIds||[]).filter(id=>!unitMatches(id));
      if(!section.unitIds.length&&!section.paragraphs.length)return [];
      section.summary='';section.issues=[];section.title='待更新小节';section.reason='';section.fingerprint=null;
      section.deferred=(section.deferred||[]).filter(d=>!unitMatches(d.unitId));
      return [section];
    });
    state.pending=(state.pending||[]).filter(p=>p.sourceTurnId!==sourceId&&!unitMatches(p.unitId));
    if(state.chapters)state.chapters=state.chapters.filter(c=>state.sections.some(s=>s.chapterId===c.id)).map(c=>affectedChapters.has(c.id)?{...c,title:'待更新章节'}:c);
    delete state.coverage;
  }
  book.chapters=chapters(book.chapters);manuscript(book.manuscript);
  for(const version of book.manuscriptVersions||[]){version.chapters=chapters(version.chapters);manuscript(version.manuscript);}
}
export function safeChapter(book, chapter) {
  const markerIds=book.claims.flatMap(c=>[c.id,c.sourceTurnId]);
  return { ...chapter, paragraphs:chapter.paragraphs.filter(p => p.sourceTurnIds.every(id => { const s=sourceText(book,id); return book.claims.some(c=>c.sourceTurnId===id&&usableEvidence(book,s,c,{manuscript:true})); })).filter(p=>!(chapter.kind==='composed'&&chapter.invalidated)).map(p => {
    const claim=book.claims.find(c=>c.sourceTurnId===p.sourceTurnIds[0]&&c.status!=='rejected');
    return {...p,text:chapter.kind==='composed'?cleanProse(p.text,markerIds):(claim?.text||p.text),status:chapter.status === 'needs_review' ? 'needs_review' : p.status};
  }) };
}

export function textOptions(settings,limit,temperature) { return {temperature,max_tokens:limit}; }


