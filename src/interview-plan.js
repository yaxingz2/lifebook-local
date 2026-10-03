// Rebuilt from surviving source records: edits, refusals and deletions take effect immediately.
const areas=[['成长经历',/小时候|童年|长大|老家|出生|放学/],['求学经历',/小学|初中|高中|大学|读研|老师|同学|上学/],['家人与朋友',/父亲|母亲|爸爸|妈妈|爷爷|奶奶|朋友|家人/],['工作经历',/工作|入职|同事|职业|创业/],['兴趣与变化',/喜欢|爱好|兴趣|学会|改变/]];
export function interviewPlan(rows,recent,bookName='',intent='continue') {
  const evidence=r=>({sourceTurnId:r.id,text:r.text.slice(0,400),date:r.date});
  const profile={};
  for(const r of rows){
    if(/(?:我叫|叫我|称呼我|我的名字是)/.test(r.text))profile.name=evidence(r);
    if(/(?:我|今年|现在).{0,12}(?:\d{1,3}|[一二三四五六七八九十两]{1,4})岁|\d{4}年出生/.test(r.text))profile.age=evidence(r);
    if(/读研|研一|研二|学生|上大学|读高中|退休|工作|上班/.test(r.text))profile.lifeStage=evidence(r);
  }
  // Short answers to an explicit introduction question remain available across sessions.
  for(let i=1;i<recent.length;i++){const prev=recent[i-1],r=recent[i];if(r.role!=='user'||prev.role!=='assistant')continue;
    // Keep the narrator's introductory words as a sourced quote, without
    // classifying gender or inferring a job from a story about someone else.
    if(/简单介绍.{0,6}自己|介绍一下自己|简单认识.{0,6}你|大概年龄.{0,30}(?:主要做|职业|工作)/.test(prev.text)){
      const source=rows.find(row=>row.id===r.id);if(source)profile.background=evidence(source);
    }
    if(/怎么称呼|叫什么|名字/.test(prev.text)&&r.text.length<80)profile.name ||= {text:r.text};
    if(/多大|几岁|年龄|哪年出生/.test(prev.text)&&r.text.length<80)profile.age ||= {text:r.text};
  }
  if(!profile.name&&bookName)profile.name={text:bookName,source:'book narrator'};
  const coverage=areas.map(([topic,pattern])=>{const matches=rows.filter(r=>pattern.test(r.text));return {topic,mentions:matches.length,detailCount:matches.filter(r=>r.text.length>=50).length,examples:matches.slice(-2).map(evidence)};});
  const next=coverage.find(x=>!x.mentions)||[...coverage].sort((a,b)=>a.detailCount-b.detailCount||a.mentions-b.mentions)[0];
  const questions=recent.filter(r=>r.role==='assistant'&&/[？?]/.test(r.text)).slice(-8).map(r=>r.text.slice(0,300));
  const lastText=rows.at(-1)?.text||'';
  const backgroundOnly=/(?:我叫|叫我|岁|读研|研一|研二|学生)/.test(lastText)&&!/(?:有一次|那次|记得|小时候|当时|后来|那年)/.test(lastText);
  const hasStory=rows.some(r=>r.text.length>=50);
  const stage=!rows.length&&!profile.name?'get_acquainted':!profile.age&&!profile.lifeStage&&rows.length<3?'light_background':!backgroundOnly&&hasStory&&(rows.at(-1)?.text.length||0)>=50?'follow_story':'invite_memory';
  return {entryIntent:intent==='new_topic'?'new_topic':'continue',openingMode:rows.length?'returning':'first_meeting',stage,knownProfile:profile,coverage,suggestedTopic:next?.topic,previousQuestions:questions,
    policy:'这是关键词线索，不是事实完整性判定。提过不等于聊透；不得宣称某一生经历不存在。已知姓名年龄不重问；年龄是当时自述。先接住当前故事，停顿或新话题时才邀请补充较少讲到的一段经历。没有线索时不编造。'};
}
