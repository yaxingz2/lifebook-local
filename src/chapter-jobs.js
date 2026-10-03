import {trackAccountUsage} from './account-usage.js';
import {randomUUID} from 'node:crypto';
import {readChapterJobs,writeChapterJobs,serial,getBook,updateBook,getSettings,getSecret,digest,existsBook,readManuscriptProgress,writeManuscriptProgress,clearManuscriptProgress} from './storage.js';
import {qwenChapter,createChapter,currentClaims,sourceText} from './engine.js';
import {generateManuscript,createManuscriptCaller,manuscriptSignature,evidenceUnits} from './manuscript.js';
const owner=randomUUID();
const active=j=>['queued','writing','saving'].includes(j.status);
async function mutate(fn){return serial('chapter-jobs',async()=>{const jobs=await readChapterJobs();const before=digest(jobs);const result=await fn(jobs);if(digest(jobs)!==before)await writeChapterJobs(jobs);return result;});}
export async function listChapterJobs(){return mutate(async jobs=>{
  // Also erase orphaned task content left by older versions of the app.
  for(let i=jobs.length-1;i>=0;i--)if(jobs[i].bookId&&!await existsBook(jobs[i].bookId))jobs.splice(i,1);
  for(const j of jobs){
    if(active(j)&&j.owner!==owner){const book=j.bookId?await getBook(j.bookId):null;const chapter=book?.chapters.find(c=>c.generationJobId===j.id);if(chapter||book?.lastManuscriptJobId===j.id){j.status='completed';j.chapterId=chapter?.id;}else{j.status='failed';j.error='本地服务重启，已完成小节已保留，可继续生成。';}}
  }
  return jobs.filter(j=>!j.dismissed).map(({owner,...j})=>j);
});}
export async function dismissChapterJob(id){return mutate(jobs=>{const j=jobs.find(j=>j.id===id);if(j&&!active(j))j.dismissed=true;});}
// Progress titles are generated from source material and must not outlive an
// erased source. Call under the book lock, like the progress writer below.
export async function clearChapterJobSourceProgress(bookId){return mutate(jobs=>{
  for(const job of jobs)if(job.bookId===bookId&&job.progress)delete job.progress.currentTitle;
});}
export async function retryChapterJob(id){
  const job=(await listChapterJobs()).find(j=>j.id===id);
  if(!job||job.status!=='failed')throw Object.assign(new Error('找不到可继续的任务'),{status:400});
  const next=await startChapterJob(job.bookId,job.title,undefined,job.mode);
  await dismissChapterJob(id);return next;
}
const evidence=book=>currentClaims(book).filter(c=>!sourceText(book,c.sourceTurnId).excludedFromBook);
export async function startChapterJob(bookId,title,generate,mode='append'){
  const prepared=await serial(bookId,async()=>{
    const book=await getBook(bookId),settings=await getSettings();
    settings.reorganize=mode==='reorganize';
    let created=false;
    const job=await mutate(jobs=>{
      const old=jobs.find(j=>j.bookId===bookId&&active(j)&&j.owner===owner);if(old)return old;
      const j={id:randomUUID(),bookId,bookTitle:book.title,title:title||'我的故事',mode,status:'queued',startedAt:new Date().toISOString(),owner,model:settings.model};
      jobs.push(j);created=true;return j;
    });
    return {job,book,settings,created};
  });
  if(prepared.created)void run(prepared.job,prepared.book,prepared.settings,generate);
  return prepared.job;
}
async function run(job,book,settings,generate){
  // A deleted book removes its job. Late progress and provider replies must
  // neither recreate that record nor reject an unobserved background promise.
  const change=async patch=>{const result=await mutate(jobs=>{const current=jobs.find(j=>j.id===job.id);return current?Object.assign(current,patch):null;});if(result&&patch.status==='completed'&&!patch.noChange)await trackAccountUsage('generations',job.id);return result;};
  try{
    if(!await change({status:'writing'}))return;
    if(['update','reorganize'].includes(job.mode)&&!generate&&settings.mode!=='mock'){
      const unchanged=async()=>{
        const current=await getBook(book.id);
        // New stories may wait for the next update; edits/deletions invalidate this snapshot.
        const fresh=new Map(evidenceUnits(current).map(u=>[u.id,u.hash]));
        if(evidenceUnits(book).some(u=>fresh.get(u.id)!==u.hash)||digest(current.avoidedTopics)!==digest(book.avoidedTopics)||digest(current.chapters)!==digest(book.chapters))throw new Error('生成期间素材或书稿有修改，已停止保存旧结果，请用最新素材继续。');
        return current;
      };
      const usage={requests:0,inputTokens:0,outputTokens:0};
      const call=createManuscriptCaller(settings,await getSecret(settings.mode,settings.region),async value=>{
        usage.requests++;usage.inputTokens+=Number(value.prompt_tokens||0);usage.outputTokens+=Number(value.completion_tokens||0);await change({usage:{...usage}});
      });
      const result=await generateManuscript(book,settings,{
        checkpoint:await readManuscriptProgress(book.id),
        call:async(...args)=>{await unchanged();return call(...args);},
        order:async payload=>{await unchanged();return call('order',payload);},
        save:async value=>{await serial(book.id,async()=>{await unchanged();await writeManuscriptProgress(book.id,value);});},
        progress:async progress=>serial(book.id,async()=>{await unchanged();await change({progress});})
      });
      if(!await change({status:'saving'}))return;
      await updateBook(book.id,current=>{
        const fresh=new Map(evidenceUnits(current).map(u=>[u.id,u.hash]));
        if(evidenceUnits(book).some(u=>fresh.get(u.id)!==u.hash)||digest(current.avoidedTopics)!==digest(book.avoidedTopics)||digest(current.chapters)!==digest(book.chapters))throw new Error('生成期间素材或书稿有修改，已保留原稿，请继续更新。');
        if(!result.noChange){saveVersion(current);current.chapters=result.chapters;}
        current.manuscript=result.manuscript;current.lastManuscriptJobId=job.id;
      });
      await clearManuscriptProgress(book.id);
      await change({status:'completed',chapterId:result.chapters[0]?.id,noChange:result.noChange,written:result.written,reused:result.reused,finishedAt:new Date().toISOString()});
      return;
    }
    const chapter=generate?await generate(book,job.title):settings.mode==='mock'?createChapter(book,job.title):await qwenChapter(book,job.title,settings,await getSecret(settings.mode),job.mode==='update');
    const chapters=Array.isArray(chapter)?chapter:[chapter];
    if(!await change({status:'saving'}))return;
    await updateBook(book.id,current=>{
      // New stories may arrive while writing; corrections/removals to supplied evidence must not be overwritten.
      const fresh=new Map(evidence(current).map(c=>[c.id,c]));
      if(evidence(book).some(c=>digest(c)!==digest(fresh.get(c.id)||null))||digest(book.avoidedTopics)!==digest(current.avoidedTopics))throw new Error('生成期间素材有修改或删除，请用最新素材重新生成。');
      if(['update','reorganize'].includes(job.mode)){
        if(digest(current.chapters)!==digest(book.chapters))throw new Error('生成期间书稿已变化，请重新更新。');
        if(!chapters.length||chapters.some(c=>!c.paragraphs?.length))throw new Error('生成期间未获得可用书稿，已保留原稿。');
        saveVersion(current);
        current.chapters=chapters.map(c=>({...c,generationJobId:job.id}));
      }else current.chapters.push({...chapter,generationJobId:job.id});
    });
    await change({status:'completed',chapterId:chapters[0]?.id,finishedAt:new Date().toISOString()});
  }catch(e){
    await change({status:'failed',error:e.name==='TimeoutError'?'本批生成等待超时，已完成小节已保留，可继续生成。':e.split?'本批内容未完整返回，已完成小节已保留，可继续生成。':e.status||e.message?.startsWith('生成期间')?e.message:'生成未完成，已完成小节已保留，请检查连接后继续。',finishedAt:new Date().toISOString()});
  }
}

function evidenceHashes(book){return evidence(book).map(c=>({id:c.id,hash:digest(c)}));}
function saveVersion(book){
  if(!book.chapters.length)return;
  book.manuscriptVersions ||= [];
  book.manuscriptVersions.push({id:randomUUID(),savedAt:new Date().toISOString(),chapters:structuredClone(book.chapters),manuscript:book.manuscript?structuredClone(book.manuscript):null,evidence:evidenceHashes(book),avoidedHash:digest(book.avoidedTopics)});
}
export async function restoreManuscript(bookId,versionId){
  return updateBook(bookId,book=>{
    const version=book.manuscriptVersions?.find(v=>v.id===versionId);
    if(!version)throw Object.assign(new Error('找不到这个版本'),{status:404});
    const fresh=new Map(evidenceHashes(book).map(c=>[c.id,c.hash]));
    if(version.evidence.some(c=>fresh.get(c.id)!==c.hash)||version.avoidedHash!==digest(book.avoidedTopics))throw Object.assign(new Error('此版本的素材已修改或删除，请更新书稿以使用最新内容。'),{status:409});
    saveVersion(book);book.chapters=structuredClone(version.chapters);book.manuscript=version.manuscript?structuredClone(version.manuscript):null;return {ok:true};
  });
}

export async function manuscriptPreview(bookId){
  const book=await getBook(bookId),checkpoint=await readManuscriptProgress(bookId),settings=await getSettings();
  const latest=(await readChapterJobs()).filter(j=>j.bookId===bookId).at(-1);settings.reorganize=latest?.mode==='reorganize';
  if(!checkpoint||checkpoint.signature!==manuscriptSignature(book,settings))throw Object.assign(new Error('暂无可查看的进度，或素材已变化。请继续更新书稿。'),{status:409});
  const units=new Map(evidenceUnits(book).map(u=>[u.id,u.hash]));
  const sections=checkpoint.state.sections.filter(s=>s.fingerprint===digest(s.unitIds.map(id=>[id,units.get(id)]))&&s.paragraphs?.length);
  return {chapters:checkpoint.state.chapters.map(c=>({...c,kind:'composed',status:'needs_review',paragraphs:sections.filter(s=>s.chapterId===c.id).flatMap(s=>s.paragraphs)})).filter(c=>c.paragraphs.length)};
}

