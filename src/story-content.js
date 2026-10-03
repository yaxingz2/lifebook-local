import {createHash} from 'node:crypto';
import {usableEvidence} from './evidence.js';

const acknowledgement=text=>/^(?:嗯|呃|啊|哦|好(?:的|吧)?|可以|行|都行|随便|是(?:的)?|对(?:的)?|不知道|记不清(?:了)?|没想好|不告诉你|谢谢|你好|听到了|喂)+$/.test(text.replace(/[\s，。！？、,.!?…]/g,''));

// Titles are derived from current user testimony, never the interviewer's
// suggested theme or an old copy of corrected/deleted material.
export function storyEvidence(book,session) {
  const claims=new Map((book.claims||[]).map(c=>[c.sourceTurnId,c]));
  return (session.turns||[]).flatMap(t=>{
    const c=claims.get(t.id),text=String(c?.text??t.text??'').trim();
    if(!usableEvidence(book,t,c,{manuscript:true})||!text||acknowledgement(text))return [];
    return [{sourceTurnId:t.id,text}];
  });
}
export function storyFingerprint(evidence) {
  return createHash('sha256').update(JSON.stringify({version:1,evidence})).digest('hex');
}
export function validStoryTitle(value) {
  if(typeof value!=='string')return '';
  const title=value.trim().replace(/^[「《“"]|[」》”"]$/g,'');
  if(!title||title.length>40||/[\r\n<>]/.test(title)||/^(?:成长经历|成长的地方|求学时光|家人与朋友|工作与事业|人生转折|日常的珍贵片段|自由回忆|我的故事|聊天记录|回忆录)$/.test(title))return '';
  return title;
}
export function clearStaleStoryTitles(book) {
  for(const session of book.sessions||[]) {
    if(!session.storySummary)continue;
    const evidence=storyEvidence(book,session);
    if(!evidence.length||!validStoryTitle(session.storySummary.title)||session.storySummary.fingerprint!==storyFingerprint(evidence))delete session.storySummary;
  }
}
export function storyDescriptor(book,session) {
  const evidence=storyEvidence(book,session),fingerprint=storyFingerprint(evidence);
  const summary=session.storySummary;
  const title=summary?.fingerprint===fingerprint&&validStoryTitle(summary.title);
  const useful=evidence.find(x=>x.text.length>=12)||evidence[0];
  const text=useful?.text.replace(/\s+/g,' ')||'';
  return {
    id:session.id,storyFingerprint:fingerprint,
    storyTitle:title||(text?text.slice(0,28)+(text.length>28?'…':''):'还没聊到具体故事'),
    storyPreview:text.slice(0,90)+(text.length>90?'…':''),
    storyTitlePending:Boolean(evidence.length&&!title)
  };
}
