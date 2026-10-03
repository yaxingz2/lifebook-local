import {VoiceHealth} from './voice-health.js';
import {WebRtcVoice,VoicePreparation,beginCallAudioSession,configureMicrophoneEcho} from './webrtc-voice.js';
import {VoiceTranscript} from './voice-transcript.js';
import {ChatTranscriptView,transcriptKeys} from './chat-transcript.js';
(() => {
  'use strict';
  const $ = (s, root = document) => root.querySelector(s);
  const app = $('#app');
  let latestUsage=null,textComposerOpen=false,pendingTextReply=null;
  const chatDrafts = new Map();
  const draftKey = (bookId=state.book?.id, sessionId=state.sessionId) => `${bookId || ''}:${sessionId || ''}`;
  let navigationVersion=0, bookRequestVersion=0, pendingBookNavigation=0;
  let renderedDraftKey=null;
  function captureDraft() { const input=$('#chat-input');if(input&&renderedDraftKey)chatDrafts.set(renderedDraftKey,input.value); }
  function assertNavigation(version) { if(version!==navigationVersion) { const error=new Error('');error.staleNavigation=true;throw error; } }
  const state = { books: [], settings: {}, token: '', book: null, sessions: [], claims: [], chapters: [], view: 'home', sessionId: null, paused: false, busy: false, exiting: false, sourceId: null, archivedBooks: [], focus: {stage:'不限阶段',theme:'成长经历'} };
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const fmt = value => { if (!value) return ''; const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('zh-CN', {year:'numeric',month:'long',day:'numeric'}); };
  const truncate = (s, n = 76) => String(s || '').length > n ? String(s).slice(0, n) + '…' : String(s || '');
  let chapterJobs=[], pollingJobs=false;
  const storyTitleAttempts=new Set();
  let storyTitlesLoading=false;
  const storyAttemptKey=s=>`${state.book?.id}:${s.id}:${s.storyFingerprint}`;
  async function updateStoryTitles() {
    if(storyTitlesLoading||!state.book||!['book','memory'].includes(state.view))return;
    const pending=state.sessions.filter(s=>s.storyTitlePending&&!storyTitleAttempts.has(storyAttemptKey(s))).slice(-2);
    if(!pending.length)return;
    const bookId=state.book.id;
    pending.forEach(s=>storyTitleAttempts.add(storyAttemptKey(s)));storyTitlesLoading=true;
    try {
      const data=await api(`/api/books/${bookId}/story-titles`,{method:'POST',body:{sessionIds:pending.map(s=>s.id)}});
      if(state.book?.id!==bookId)return;
      for(const result of data.sessions||[]) {
        const session=state.sessions.find(s=>s.id===result.id);
        if(session&&session.storyFingerprint===result.storyFingerprint)Object.assign(session,result);
      }
    } catch { /* Keep the current source excerpt; retry on the next visit. */ }
    finally {storyTitlesLoading=false;if(['book','memory'].includes(state.view))render();}
  }
  const completedJobTimers=new Map(),hiddenCompletedJobs=new Set();
  function renderChapterJobs(){
    const target=$('#chapter-jobs');if(!target)return;
    for(const job of chapterJobs){
      if(job.status!=='completed'||completedJobTimers.has(job.id)||hiddenCompletedJobs.has(job.id))continue;
      completedJobTimers.set(job.id,setTimeout(()=>{
        hiddenCompletedJobs.add(job.id);completedJobTimers.delete(job.id);renderChapterJobs();
        api('/api/chapter-jobs/dismiss',{method:'POST',body:{id:job.id}}).catch(()=>{});
      },5000));
    }
    const visibleJobs=chapterJobs.filter(j=>!hiddenCompletedJobs.has(j.id));
    const signature=JSON.stringify(visibleJobs);if(target.dataset.signature===signature){target.querySelectorAll('[data-started]').forEach(el=>el.textContent=Math.max(0,Math.floor((Date.now()-Date.parse(el.dataset.started))/1000)));return;}target.dataset.signature=signature;
    target.innerHTML=visibleJobs.map(j=>{
      const running=['queued','writing','saving'].includes(j.status),p=j.progress||{};
      const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(j.startedAt))/1000));
      const label=j.noChange?'书稿已是最新':({queued:'准备素材',writing:p.phase==='classifying'?'正在归类故事':'正在分批写作',saving:'正在保存书稿',completed:'书稿已生成',failed:'生成未完成'}[j.status]);
      const detail=p.phase==='classifying'?`已归类 ${p.classified||0} / ${p.sources||0} 段素材`:p.total!==undefined?`已完成 ${p.completed||0} / ${p.total} 个小节${p.currentTitle?' · '+p.currentTitle:''}`:'';
      return `<div class="chapter-job ${running?'is-running':''}"><span class="job-spinner" aria-hidden="true">${running?'':'✦'}</span><div class="job-copy"><strong>${escapeHTML(label)} · ${escapeHTML(j.title)}</strong><p>${escapeHTML(j.bookTitle)} · ${running?`已等待 <span data-started="${escapeHTML(j.startedAt)}">${seconds}</span> 秒，可以继续浏览或聊天。`:j.status==='failed'?escapeHTML(j.error):j.noChange?'没有新增或修改的素材。':'草稿已保存，请核对内容与出处。'}</p>${detail?`<p>${escapeHTML(detail)}</p>`:''}</div>${j.status==='completed'?`<button class="button secondary" data-action="view-job" data-id="${j.id}">查看书稿</button>`:''}${['update','reorganize'].includes(j.mode)&&j.status!=='completed'&&p.completed>0?`<button class="button secondary" data-action="preview-manuscript" data-book-id="${j.bookId}">查看已完成小节</button>`:''}${j.status==='failed'?`<button class="button primary" data-action="retry-manuscript" data-id="${j.id}">继续生成</button>`:''}${!running?`<button class="button ghost" data-action="dismiss-job" data-id="${j.id}" aria-label="关闭任务提醒">关闭</button>`:''}</div>`;
    }).join('');
  }
  async function pollChapterJobs(){
    if(!state.token||pollingJobs)return;pollingJobs=true;
    try{const jobs=await api('/api/chapter-jobs');for(const j of jobs){const old=chapterJobs.find(x=>x.id===j.id);if(old&&old.status!==j.status&&['completed','failed'].includes(j.status)){toast(j.status==='completed'?`「${j.title}」已生成，可查看书稿。`:`「${j.title}」生成未完成。`);if(j.status==='completed'&&state.book?.id===j.bookId&&state.view==='chapters'){const data=await api(`/api/books/${j.bookId}`);if(state.book?.id===j.bookId&&state.view==='chapters'){state.book=data.book;state.chapters=data.chapters;render();}}}}chapterJobs=jobs;renderChapterJobs();}catch{const el=$('#chapter-jobs');if(chapterJobs.some(j=>['queued','writing','saving'].includes(j.status))){el.textContent='暂时无法获取书稿进度，正在重新连接…';delete el.dataset.signature;}}finally{pollingJobs=false;}
  }
  setInterval(pollChapterJobs,2000);
  let toastTimer;
  let followLatest = true;
  let transcriptView=null,renderedChatKey=null;
  let voice = null, lastVoiceHealth = null;
  let voicePreparation=null,preparationKey='';
  const webRtcAllowed=()=>state.settings.mode==='qwen'&&state.settings.qwenConnection==='unified'&&state.settings.qwenVoiceModel==='qwen-audio-3.0-realtime-flash'&&state.webrtcAvailable;
  const voiceURL=()=>`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/voice`;
  function closePreparation(){voicePreparation?.close();voicePreparation=null;preparationKey='';}
  function prepareVoice(){
    const key=JSON.stringify([state.token,state.settings]);
    if(voice||!state.token||!webRtcAllowed()||typeof window.RTCPeerConnection!=='function'||typeof window.WebSocket!=='function'||document.visibilityState==='hidden'){closePreparation();return;}
    if(voicePreparation&&!voicePreparation.closed&&key===preparationKey)return;
    closePreparation();preparationKey=key;
    try{voicePreparation=new VoicePreparation({url:voiceURL(),token:state.token,onExpired:old=>{if(voicePreparation===old)voicePreparation=null;}});}catch{voicePreparation=null;}
  }
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')closePreparation();else prepareVoice();});
  document.addEventListener('pointerdown',()=>{if(!voice)prepareVoice();});
  window.addEventListener?.('pagehide',closePreparation);
  function liveTranscriptRows(){
    const session=currentSession();if(!session)return [];
    const turns=session.turns||[];
    const active=voice&&voice.bookId===state.book?.id&&voice.sessionId===state.sessionId;
    return active?voice.transcript.rows(turns):turns;
  }
  function liveRowHTML(t){
    return t.preview?`<div class="turn ${t.role}" data-chat-row="${escapeHTML(transcriptKeys(t)[0])}"><div class="avatar" aria-hidden="true">${t.role==='user'?'我':'✦'}</div><div class="turn-content"><div class="bubble">${escapeHTML(t.text)}</div><div class="turn-meta"><span>${t.role==='user'?'我':`LifeBook · 千问`}${t.interrupted?' · 已打断':t.complete?'':' · 正在说话'}</span></div></div></div>`:turnHTML(t,currentSession());
  }
  function liveTranscriptHTML(){return liveTranscriptRows().map(liveRowHTML).join('');}
  function refreshLiveTranscript(){
    if(state.view==='chat'&&renderedChatKey===draftKey())transcriptView?.update(liveTranscriptRows());
  }
  function updateLiveTranscript(active,event){
    if(voice!==active)return;active.transcript.event(event);
    if(state.view!=='chat'||state.book?.id!==active.bookId||state.sessionId!==active.sessionId)return;
    refreshLiveTranscript();
  }
  function healthText(){
    const h=voice?.health?.snapshot()||lastVoiceHealth;if(!h)return '语音测试时自动记录诊断日志；可导出之前保存的日志。';
    const ms=n=>Number.isFinite(n)?`${n} 毫秒`:'等待测量';
    const echo=({all:'已请求消除所有外放声音', 'remote-only':'仅针对远端通话声音','browser-default':'已开启，由浏览器选择范围',disabled:'未开启',unreported:'浏览器未报告'})[h.echoCancellationMode]||'等待确认';
    const audio=`当前麦克风：${h.micLabel||'等待确认'}；回声消除：${echo}${h.echoCancellationAllRejected?'（更完整的模式未能启用）':''}。`;
    return `WebRTC 已启用 · 浏览器直接传输声音。${audio}通话往返：${ms(h.rtcRttMs)}；抖动：${ms(h.rtcJitterMs)}；接收丢包：${h.rtcPacketsLost??0}；发送丢包：${h.rtcUplinkPacketsLost??'等待测量'}；麦克风音量：${h.rtcMicMeasured?`${Math.round(h.micRms*100)}%`:'尚未测量'}；控制连接：${h.rtcControlOpen?'已连接':'等待确认'}；检测到开口 ${h.speechEvents} 次。`;
  }
  function renderVoiceHealth(){const el=$('#voice-health-status');if(el)el.textContent=healthText();}

  let voiceStatus = '', lastVoiceError = '';
  const voiceAllowed = () => !!webRtcAllowed();
  function voiceHint() { return state.webrtcAvailable===false?'此安装尚未启用 WebRTC，请联系管理员。':'请在设置中填写千问 API Key，并使用支持 WebRTC 的浏览器。'; }
  function setVoiceStatus(value) { voiceStatus = value; const el = $('#voice-status'); if (el) el.textContent = value; }
  const voiceSaving=()=>!!voice?.stopping||(state.paused&&state.busy);
  const voiceButtonDisabled=()=>voiceSaving()||(!voice&&(state.busy||!voiceAllowed()));
  function voiceButtonContent(){
    const label=voiceSaving()?'正在保存…':voice&&!voice.ready?'正在准备 · 点击取消':voice?'暂停语音':state.paused||currentSession()?.turns.length?'继续语音聊天':'开始语音聊天';
    return `<span class="voice-main-icon" aria-hidden="true">${voice?'■':'🎙'}</span><span>${label}</span>`;
  }
  function idleVoiceStatus(){return state.paused&&state.busy?'正在保存最后一句话…':lastVoiceError||(voiceAllowed()?state.paused?'聊天已保存，想接着讲随时继续。':currentSession()?.turns.length?'点击继续语音，接着刚才的话聊。':'点击开始，主持人会围绕主线开场。':voiceHint());}
  function updateVoiceButton() { const btn = $('[data-action="voice-toggle"]'); if (!btn) return; btn.innerHTML = voiceButtonContent();btn.classList.toggle('primary',!voice);btn.classList.toggle('danger',!!voice); btn.disabled = voiceButtonDisabled(); btn.classList.toggle('recording', !!voice?.ready);btn.classList.toggle('preparing',!!voice&&!voice.ready&&!voice.stopping); btn.setAttribute('aria-pressed', String(!!voice)); }
  async function stopVoice() {
    const old = voice; if (!old) return; if (old.stopPromise) return old.stopPromise;
    clearTimeout(old.connectionTimer);clearInterval(old.healthTimer);if(old.health)lastVoiceHealth=old.health.snapshot();old.stopping = true; old.ready = false; updateVoiceButton(); setVoiceStatus('正在保存最后一句话…');
    old.stopPromise = (async () => {
      old.preparation?.close();
      try { if(old.rtc)old.rtc.muteInput();else old.stream?.getTracks().forEach(track => track.stop()); } catch {}
      const socket = old.socket;
      let timedOut = false;
      if (socket?.readyState === WebSocket.OPEN) {
        await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); old.finishStop = null; resolve(); };
          const timer = setTimeout(() => { timedOut = true; finish(); }, 18000);
          old.finishStop = finish;
          socket.addEventListener('close', finish, {once:true});
          try { socket.send(JSON.stringify({type:'stop',metrics:old.health?{...old.health.data,elapsedMs:Date.now()-old.health.started}:undefined})); } catch { finish(); }
        });
      }
      try { if (socket?.readyState === WebSocket.CONNECTING) socket.addEventListener('open', () => socket.close(1000), {once:true}); else if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000); } catch {}
      old.rtc?.close();
      if(!old.capturing)old.releaseAudioSession?.();
      if (voice === old) { if(old.health)lastVoiceHealth=old.health.snapshot();voice = null; updateVoiceButton(); setVoiceStatus(idleVoiceStatus()); }
      if (state.book && state.view === 'chat') { try { await loadBook(state.book.id,{background:true}); render(); } catch {} }
      if (timedOut) toast('停止语音时等待保存超时，请检查最后一句是否出现在聊天记录中。');
      prepareVoice();
    })();
    return old.stopPromise;
  }
  async function startVoice() {
    if (voice || !voiceAllowed() || !state.sessionId || state.paused || !state.token) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.WebSocket || !window.RTCPeerConnection) throw new Error('当前浏览器不支持实时语音所需的麦克风或音频处理功能。');
    const active = {bookId:state.book.id,sessionId:state.sessionId,transcript:new VoiceTranscript({preserveInterrupted:true}),socket:null, stream:null, ready:false, stopping:false, stopPromise:null, finishStop:null};
    active.health=new VoiceHealth(16000);lastVoiceHealth=null;lastVoiceError='';latestUsage=null;voice = active; updateVoiceButton();
    active.health.data.transport='webrtc';
    try {
      setVoiceStatus('正在准备麦克风，请稍等，先不用说话…');
      active.releaseAudioSession=beginCallAudioSession(navigator);
      if(preparationKey===JSON.stringify([state.token,state.settings])&&voicePreparation?.claim()){active.preparation=voicePreparation;voicePreparation=null;if(!active.releaseAudioSession.deferPlayback)active.preparation.unlock();}
      else closePreparation();
      const audio={channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true};
      // No deviceId or device enumeration: one capture follows the system default.
      // Request broader echo cancellation only after this track advertises it.
      active.capturing=true;
      try{active.stream = await navigator.mediaDevices.getUserMedia({audio,video:false});}
      finally{active.capturing=false;}
      if (voice !== active || active.stopping) { active.stream.getTracks().forEach(track => track.stop()); active.releaseAudioSession?.(); return; }
      active.releaseAudioSession.activate();
      const mic=active.stream.getAudioTracks()[0];
      Object.assign(active.health.data,await configureMicrophoneEcho(mic,navigator),{micLabel:mic.label||''});
      if (voice !== active || active.stopping) { active.stream.getTracks().forEach(track => track.stop()); active.releaseAudioSession?.(); return; }
      if(active.health.data.echoCancellationMode==='disabled')toast('浏览器报告回声消除未开启；外放声音可能被麦克风收进去。');
      setVoiceStatus('正在连接语音服务，请稍等，先不用说话…');
      let prepared;
      if(active.preparation){try{await active.preparation.ready;prepared=active.preparation.take();}catch{}if(!prepared)active.preparation.close();}
      if(voice!==active||active.stopping){prepared?.rtc.close();prepared?.socket.close();return;}
      active.socket=prepared?.socket||new WebSocket(voiceURL(),['lifebook',state.token]);active.socket.binaryType='arraybuffer';
      if(!prepared)await new Promise((resolve,reject) => { const timer = setTimeout(() => reject(new Error('语音服务连接超时。')),10000); active.socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true}); active.socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('语音服务连接失败。请确认密钥及网络。'));},{once:true}); active.socket.addEventListener('close',()=>{clearTimeout(timer);reject(new Error('语音连接已关闭。'));},{once:true}); });
      if (voice !== active || active.stopping) return;
      active.socket.addEventListener('message', async event => {
        if (voice !== active) return; let msg; try { msg = JSON.parse(event.data); } catch { return; }
        if(msg.type==='rtc_answer'){try{await active.rtc?.answer(msg.sdp);}catch{lastVoiceError='WebRTC 连接未完成，请重试。';toast(lastVoiceError);await stopVoice();}return;}
        if(msg.type==='rtc_command'){active.rtc?.command(msg.event);return;}
        if(msg.type==='rtc_close'){active.rtc?.close();return;}
        if(msg.type==='diagnostic_status'){active.logSaved=msg.saved;const el=$('#voice-log-status');if(el)el.textContent=msg.saved?'诊断日志已自动保存。':'诊断日志保存失败，请告知管理员。';return;}
        if(msg.type==='voice_probe_result'){active.health.acknowledge(msg);renderVoiceHealth();return;}
        if(msg.type==='voice_health'){active.health.data.server=msg.stats;renderVoiceHealth();return;}
        if(msg.type==='usage'){latestUsage=msg.usage;const panel=$('#usage-panel');if(panel){panel.innerHTML=usageContent();}}
        if (msg.type === 'stopped') { active.finishStop?.(); return; }
        if (msg.type === 'state' && !active.stopping) {
          active.waitingToListen=msg.state==='listening';
          if(active.startupProtection)setVoiceStatus('开场准备中，暂时先不用说话；稍后会提示你开口。');
          else if(msg.state==='listening'){clearTimeout(active.connectionTimer);active.ready=true;updateVoiceButton();setVoiceStatus('可以开始说话了，我在听。');}
          else setVoiceStatus(({connecting:'正在连接语音服务，请稍等，先不用说话…',thinking:'正在整理回应，你也可以继续说…',speaking:'已连接，正在准备回应；你也可以先开口。'})[msg.state]||msg.state||'语音已连接。');
        }
        // Transcript deltas may be a single punctuation mark; status comes from state events.
        // Live assistant text is previewed below; saved turns still come from the server.
        if(msg.type==='ready'&&!active.stopping){
          try{
            if(active.rtc){
              setVoiceStatus('正在准备麦克风与通话声音，请稍等…');
              if(!await active.rtc.ready())return;
              if(voice!==active||active.stopping||active.socket.readyState!==WebSocket.OPEN)return;
              active.socket.send(JSON.stringify({type:'rtc_media_ready',startupId:msg.startupId,metrics:{...active.health.data,rtcMicReady:true,rtcStartupMs:active.health.data.rtcStartupMs}}));
            }
          }catch(error){if(voice!==active||active.stopping)return;lastVoiceError=error.message||'麦克风未能接入 WebRTC，请重新开始。';toast(lastVoiceError);await stopVoice();return;}
          if(voice!==active||active.stopping)return;
          clearTimeout(active.connectionTimer);if(active.startupProtection){setVoiceStatus('开场准备中，暂时先不用说话；稍后会提示你开口。');return;}active.ready=true;updateVoiceButton();setVoiceStatus('WebRTC 已连接，可以开始说话。');
        }
        if(msg.type==='speech_started'){active.health.data.speechEvents++;renderVoiceHealth();}
        if (state.book?.id===active.bookId&&(msg.type === 'turns' || (msg.type === 'transcript' && msg.final))) { try { await loadBook(active.bookId,{background:true}); if (voice===active&&state.view==='chat'&&state.book?.id===active.bookId&&state.sessionId===active.sessionId) refreshLiveTranscript(); } catch {} }
        if (msg.type === 'error') { lastVoiceError=msg.message||'语音服务出错。';toast(lastVoiceError); if (!active.stopping) await stopVoice(); }
      });
      active.socket.addEventListener('close',()=>{ if (voice === active && !active.stopping) { lastVoiceError ||= '语音连接已断开，请重新开始语音聊天。';toast(lastVoiceError); stopVoice(); } });
      {
        active.health.data.rtcTransport=true;active.health.data.sampleRate=active.stream.getAudioTracks()[0].getSettings().sampleRate||0;active.health.data.micLabel=active.stream.getAudioTracks()[0].label||'';
        const rtcOptions={stream:active.stream,socket:active.socket,health:active.health,isCurrent:()=>voice===active,onEvent:event=>updateLiveTranscript(active,event),onStartupProtection:phase=>{
          if(voice!==active||active.stopping)return;
          active.startupProtection=phase!=='open';
          if(phase==='open'){active.ready=true;updateVoiceButton();setVoiceStatus('可以说话了，我在听；你也可以直接开口打断。');if(active.socket.readyState===WebSocket.OPEN)active.socket.send(JSON.stringify(active.health.probe()));}
          else setVoiceStatus('开场准备中，暂时先不用说话；稍后会提示你开口。');
        },onError:message=>{if(voice!==active||active.stopping)return;lastVoiceError=message;toast(message);void stopVoice();}};
        if(prepared){active.rtc=prepared.rtc;Object.assign(active.health.data,active.preparation.health.data,{rtcPrepared:true});active.rtc.activate(rtcOptions);}else active.rtc=new WebRtcVoice(rtcOptions);
        const offer=prepared?undefined:await active.rtc.offer();if(voice!==active||active.stopping)return;
        active.healthTimer=setInterval(async()=>{if(voice!==active||active.stopping||!active.ready||active.socket.readyState!==WebSocket.OPEN)return;try{await active.rtc.stats();if(voice===active&&!active.stopping){active.socket.send(JSON.stringify(active.health.probe()));renderVoiceHealth();}}catch{}},2000);
        active.stream.getAudioTracks().forEach(track=>track.addEventListener('ended',()=>{if(voice===active&&!active.stopping)void stopVoice();},{once:true}));
        active.connectionTimer=setTimeout(()=>{if(voice===active&&!active.ready&&!active.stopping){lastVoiceError='WebRTC 连接超时，请重试。';toast(lastVoiceError);void stopVoice();}},60000);
        setVoiceStatus('正在建立 WebRTC 通话，请稍等…');
        active.socket.send(JSON.stringify({type:'start',bookId:state.book.id,sessionId:state.sessionId,resume:!!currentSession()?.turns?.length,transport:'webrtc',offer}));
        return;
      }
    } catch (error) {
      if(voice!==active||active.stopping){if(!active.stream||voice!==active)active.releaseAudioSession?.();return;}
      lastVoiceError=errorMessage(error);await stopVoice();throw error;
    }
  }
  function toast(message) { if(!message)return;const el = $('#toast'); el.textContent = message; el.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 4000); }
  function errorMessage(error) { if(error?.staleNavigation)return '';return error?.message || '操作没有成功，请重试。'; }
  async function api(path, options = {}) {
    const headers = {...options.headers};
    if (options.body && !(options.body instanceof FormData) && typeof options.body !== 'string') { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.body); }
    if (state.token && path !== '/api/bootstrap') headers['X-LifeBook-Token'] = state.token;
    const res = await fetch(path, {...options, headers});
    if (res.status === 401 && document.body.className.includes('cloud-')) { location.replace('/login'); throw new Error('登录已过期'); }
    if (!res.ok) { let detail; try { const data = await res.json(); detail = data.error || data.message; if (typeof detail === 'object') detail = detail.message; } catch {} throw new Error(detail || `请求失败（${res.status}）`); }
    if (res.status === 204) return null;
    const type = res.headers.get('content-type') || '';
    return type.includes('json') ? res.json() : res.text();
  }
  async function bootstrap() { const data = await api('/api/bootstrap'); state.books = data.books || []; state.archivedBooks=data.archivedBooks||[]; state.settings = data.settings || {}; state.serviceSettings=data.serviceSettings||{};state.user=data.user; state.voiceModels=data.voiceModels||{};state.webrtcAvailable=!!data.webrtcAvailable; state.token = data.token || ''; renderSidebar();prepareVoice(); await pollChapterJobs(); }
  async function loadBook(id,{background=false}={}) {
    if(background&&pendingBookNavigation)return null;
    const navigation=navigationVersion,request=++bookRequestVersion;
    if(!background)pendingBookNavigation=request;
    try {const data=await api(`/api/books/${encodeURIComponent(id)}`);assertNavigation(navigation);
      if(request!==bookRequestVersion){const error=new Error('');error.staleNavigation=true;throw error;}
      state.book=data.book||data;try{localStorage.setItem('lifebook-last-book',state.book.id);}catch{}
      state.sessions=data.sessions||[];state.claims=data.claims||[];state.chapters=data.chapters||[];renderSidebar();return data;
    } finally {if(pendingBookNavigation===request)pendingBookNavigation=0;}
  }
  async function refresh() { if (state.book?.id) await loadBook(state.book.id,{background:true}); render(); }
  function currentSession() { return state.sessions.find(s => s.id === state.sessionId); }
  function renderSidebar() { $('#book-list').innerHTML = state.books.map(b => `<button type="button" class="book-item ${state.book?.id === b.id ? 'active' : ''}" data-book="${escapeHTML(b.id)}"><span>${escapeHTML(b.title)}</span><small>${escapeHTML(b.name || '我的回忆')}</small></button>`).join(''); }
  function setView(view) { navigationVersion++;state.view = view; state.sourceId = null; $('.sidebar')?.classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded','false'); render(); window.scrollTo({top:0,behavior:'instant'}); }
  function render() {
    captureDraft();
    const chatKey=state.view==='chat'&&currentSession()?draftKey():null;
    const reuse=chatKey&&chatKey===renderedChatKey&&transcriptView;
    const oldConversation=reuse?$('.conversation'):null;
    const readingPosition=oldConversation?transcriptView.capturePosition():null;
    if(!reuse){transcriptView?.dispose();transcriptView=null;followLatest=true;}
    $('#crumb').textContent = state.view === 'home' ? '主页' : state.view === 'shelf' ? '书架' : ['user-settings','voice-settings'].includes(state.view) ? '个人设置' : state.view === 'settings' ? '设置' : state.book ? state.book.title : '我的书架';
    const pages = {home: home, shelf: shelfPage, book: bookPage, chat: chatPage, memory: memoryPage, chapters: chaptersPage, settings: settingsPage, 'user-settings':userSettingsPage, 'voice-settings':userSettingsPage};
    document.querySelectorAll('.main-nav-link').forEach(link=>link.setAttribute('aria-current',state.view===link.dataset.view?'page':'false'));
    app.innerHTML = (pages[state.view] || home)();
    if(oldConversation){$('.conversation').replaceWith(oldConversation);transcriptView.restorePosition(readingPosition);refreshLiveTranscript();}
    else if(chatKey){
      transcriptView=new ChatTranscriptView({container:$('.conversation'),target:$('#live-transcript'),rows:liveTranscriptRows(),renderRow:liveRowHTML,following:followLatest,canAutoFollow:()=>!state.paused,onFollowChange:value=>{followLatest=value;const btn=$('[data-action="latest-message"]');if(btn)btn.hidden=value;}});
    }
    renderedChatKey=chatKey;
    // The text pending indicator sits outside the keyed transcript, and can change
    // during a same-session render without rebuilding any saved/live bubble.
    if(oldConversation){
      let thinking=oldConversation.querySelector('.text-thinking');
      const pending=pendingTextReply?.bookId===state.book?.id&&pendingTextReply?.sessionId===state.sessionId;
      if(!pending)thinking?.remove();
      else if(!thinking){thinking=document.createElement('div');thinking.className='turn assistant text-thinking';thinking.innerHTML='<div class="avatar">✦</div><div class="bubble loader">正在思考如何接着聊…</div>';oldConversation.append(thinking);}
      transcriptView.follow();
    }
    const composer=$('#chat-input');renderedDraftKey=composer?draftKey():null;if(composer)composer.value=chatDrafts.get(renderedDraftKey)||'';
    document.title = `${state.book && state.view !== 'home' && state.view !== 'settings' ? state.book.title + ' · ' : ''}LifeBook`;
    if(state.view==='chat'&&voice)updateVoiceButton();
    void updateStoryTitles();
  }
  function shelfCard(b,archived=false){return `<article class="card shelf-card"><h3>${escapeHTML(b.title)}</h3><p class="muted">${escapeHTML(b.name||'我的回忆')} · ${escapeHTML(fmt(b.createdAt))}</p><div class="shelf-actions">${archived?`<button class="button secondary" data-action="restore-book" data-id="${b.id}">放回书架</button>`:`<button class="button primary" data-book="${b.id}">打开这本书</button><button class="button secondary" data-action="archive-book" data-id="${b.id}">移出书架</button>`}<button class="button ghost delete-book" data-action="delete-book" data-id="${b.id}">永久删除</button></div></article>`;}
  function lastUsedBook(){let id;try{id=localStorage.getItem('lifebook-last-book');}catch{}return state.books.find(b=>b.id===id)||state.books[0];}
  function home() {
    const last=lastUsedBook();
    const recent=last?`<div class="section-head"><div><h2>接着写你的故事</h2><p>上次使用：${escapeHTML(last.title)}</p></div><button class="button ghost" data-view="shelf">查看书架与管理 →</button></div><div class="cards"><button class="card interactive" data-action="home-continue" data-id="${last.id}"><div class="mini-cover" aria-hidden="true">↗</div><h3>继续上次话题</h3><p>接着《${escapeHTML(last.title)}》里上次没讲完的故事聊。</p></button><button class="card interactive create" data-action="home-new-topic" data-id="${last.id}"><div class="mini-cover" aria-hidden="true">＋</div><h3>开启新篇章</h3><p>在这本书里换个话题，开始一段新的聊天。</p></button></div>`:'';
    return `<div class="page"><section class="hero"><div><p class="eyebrow">A LIFE, IN ITS OWN WORDS</p><h1 class="home-title"><span>每一个人，</span><span>都有自己独一无二的故事。</span></h1><p class="intro">像与一位愿意倾听的朋友聊天。从一件小事开始，慢慢聊起那些人、那些地方、那些还记得的瞬间。LifeBook 帮你整理成一本有出处的人生之书。</p><div class="hero-actions"><button class="button primary" data-action="new-book" type="button">＋ 开始一本新书</button>${last?`<button class="button secondary" data-book="${escapeHTML(last.id)}" type="button">打开上次的书 →</button>`:'<button class="button ghost" data-view="shelf" type="button">查看书架 →</button>'}</div></div><div class="hero-art" aria-hidden="true"><div class="book-cover"><b>✦</b><small>人生之书</small></div><span class="spark one">✧</span><span class="spark two">✦</span></div></section>${recent}</div>`;
  }
  function shelfPage(){return `<div class="page"><div class="section-head"><div><h1 class="page-title">书架</h1><p>打开一本书，继续讲你的故事。</p></div><button class="button primary" data-action="new-book">＋ 新建一本书</button></div><div class="cards">${state.books.map(b=>shelfCard(b)).join('')||'<p class="muted">书架还是空的，可以新建一本书。</p>'}</div><section class="shelf-archived"><h2>已移出书架</h2><p class="muted">这里只是收起，内容仍然保留；可以放回书架。永久删除后无法在这里恢复。</p><div class="cards">${state.archivedBooks.map(b=>shelfCard(b,true)).join('')||'<p class="muted">没有已移出的书。</p>'}</div></section><section class="shelf-backup"><h2>备份与恢复</h2><p class="muted">备份是下载到电脑的副本，包含聊天文字、回忆和书稿；可用备份文件恢复成一本新书。</p><button class="button secondary" data-action="restore">从备份文件恢复</button></section></div>`;}
  function tabs(active) { return `<nav class="tabs" aria-label="书籍页面"><button class="tab ${active==='book'?'active':''}" data-view="book">总览</button><button class="tab ${active==='memory'?'active':''}" data-view="memory">回忆与纠错</button><button class="tab ${active==='chapters'?'active':''}" data-view="chapters">书稿与出处</button></nav>`; }
  function bookHead() { return `<div class="book-heading"><div><p class="eyebrow">MY LIFEBOOK</p><h1 class="page-title">${escapeHTML(state.book?.title)}</h1><p class="muted">${state.sessions.length} 次聊天 · ${state.claims.length} 条回忆</p></div><button class="button secondary" data-action="backup" type="button">↓ 下载备份</button></div>`; }
  const stages=['不限阶段','童年','少年','青年','中年','晚年'];
  const themes=['成长经历','求学时光','家人与朋友','工作与事业','人生转折','日常的珍贵片段'];
  const focusLabel=s=>s?.focus?[s.focus.stage==='不限阶段'?'':s.focus.stage,(s.focus.theme==='成长的地方'?'成长经历':s.focus.theme)].filter(Boolean).join(' · '):'自由回忆';
  const storyLabel=s=>s.storyTitle||truncate(s.turns?.find(t=>t.role==='user'&&!t.avoided&&!t.deleted&&!t.excludedFromBook)?.text,28)||'还没聊到具体故事';
  function focusFields(f=state.focus) { return `<div class="focus-fields"><div class="field"><label for="focus-stage">人生阶段</label><select id="focus-stage">${stages.map(x=>`<option ${f.stage===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label for="focus-theme">回忆主题</label><select id="focus-theme">${themes.map(x=>`<option ${(f.theme==='成长的地方'?'成长经历':f.theme)===x?'selected':''}>${x}</option>`).join('')}</select></div></div>`; }
  function readFocus(root=document) {return {stage:$('#focus-stage',root).value,theme:$('#focus-theme',root).value};}
  function bookPage() {
    if(!state.book)return home();const last=state.sessions.at(-1);
    return `<div class="page">${bookHead()}${tabs('book')}
      ${last?`<section class="resume-panel"><div><h2>继续上次聊天</h2><p>${escapeHTML(storyLabel(last))}</p></div><button class="button primary" data-action="continue-story">继续上次聊天 →</button></section>`:''}
      <section class="topic-panel"><h2>${last?'聊新话题':'开始认识彼此'}</h2><p class="muted">主持人会结合这本书里已有的故事，邀请你聊聊还没展开的经历。你也可以直接讲想说的事。</p><div class="hero-actions">${voiceAllowed()?'<button class="button primary" data-action="new-focused-voice">🎙 开始聊天</button>':''}<button class="button ghost" data-action="new-focused-text">用文字聊</button></div></section>
      <div class="section-head"><div><h2>聊过的故事</h2><p>根据每次聊到的内容整理标题，随时回看。</p></div><button class="button ghost" data-view="shelf">到书架管理</button></div>
      ${state.sessions.length?`<div class="list">${[...state.sessions].reverse().map((x,i)=>`<div class="list-row"><button class="row-link" data-session="${escapeHTML(x.id)}"><h3>${escapeHTML(storyLabel(x))}</h3>${x.storyPreview?`<p>${escapeHTML(x.storyPreview)}</p>`:''}<p>第 ${state.sessions.length-i} 次 · ${escapeHTML(fmt(x.startedAt))} · ${x.turns?.length||0} 条消息</p></button><span class="badge">可继续</span></div>`).join('')}</div>`:'<div class="empty"><h3>从一段你愿意讲的往事开始</h3><p>不用按顺序，也不用一次讲完。</p></div>'}</div>`;
  }
  function turnHTML(t, session) {
    const excluded=!!t.excludedFromBook, user=t.role==='user';
    const attributes=`data-turn="${escapeHTML(t.id)}" data-session-id="${escapeHTML(session.id)}" type="button"`;
    return `<div class="turn ${user?'user':'assistant'} ${excluded?'excluded':''}" data-chat-row="${escapeHTML(transcriptKeys(t)[0])}"><div class="avatar" aria-hidden="true">${user?'我':'✦'}</div><div class="turn-content"><div class="bubble">${escapeHTML(t.text)}</div><div class="turn-meta"><span>${user?'我':t.provider==='qwen'?'LifeBook · 千问':'LifeBook'}${t.interrupted?' · 已打断':''}${excluded?' · 不写进书':''}</span>${user?`<details class="turn-actions"><summary aria-label="管理这条消息">更多</summary><div class="turn-action-list"><button class="small-action" data-action="exclude-turn" ${attributes}>${excluded?'恢复写入':'不写进书'}</button><button class="small-action" data-action="edit-turn" ${attributes}>修改</button><button class="small-action" data-action="delete-turn" ${attributes}>删除</button></div></details>`:''}</div></div></div>`;
  }
  function chatPage() {
    const s=currentSession();
    if(!s)return `<div class="page"><p>找不到这次聊天。</p><button class="button secondary" data-view="book">返回书本</button></div>`;
    const voiceControl=`<div class="voice-panel"><button class="button voice-main ${voice?'danger':'primary'} ${voice?.ready?'recording':''}" data-action="voice-toggle" type="button" aria-pressed="${!!voice}" ${voiceButtonDisabled()?'disabled':''}>${voiceButtonContent()}</button><span id="voice-status" role="status" aria-live="polite">${escapeHTML(voice?voiceStatus:idleVoiceStatus())}</span>${voiceAllowed()?'<small>录音前请确认在场的被录音者同意。当前语音：'+'千问'+'。音频及相关回忆会发送给所选服务商。</small>':''}</div>`;
    const textControl=!voiceSaving()?`<details class="text-option text-composer" ${textComposerOpen?'open':''}><summary>改用文字</summary><form id="chat-form" class="composer"><label class="sr-only" for="chat-input">输入你的故事</label><textarea id="chat-input" name="text" placeholder="想到什么，就从哪里说起…" required maxlength="4000"></textarea><div class="composer-actions"><span class="composer-hint">按 Enter 发送，Shift + Enter 换行</span><button class="button primary" type="submit" ${state.busy?'disabled':''}>发送 ↗</button></div></form></details>`:'';
    return `<div class="page chat-page"><div class="chat-header"><div><p class="eyebrow">A CONVERSATION</p><h1>聊聊你的故事</h1><p>${escapeHTML(fmt(s.startedAt))} · ${voiceSaving()?'正在保存…':'随时可以接着聊'}</p></div><div class="toolbar-actions"><button class="button secondary" data-action="exit-chat" type="button" ${state.exiting?'disabled':''}>${state.exiting?'正在保存…':'退出聊天'}</button></div></div><div class="conversation" tabindex="0" aria-label="聊天记录"><div id="live-transcript">${liveTranscriptHTML()}</div>${pendingTextReply?.bookId===state.book?.id&&pendingTextReply?.sessionId===s.id?'<div class="turn assistant text-thinking"><div class="avatar">✦</div><div class="bubble loader">正在思考如何接着聊…</div></div>':''}</div><button class="latest-message button ghost" data-action="latest-message" ${followLatest?'hidden':''}>↓ 回到最新消息</button><div class="chat-controls">${voiceControl}<div class="chat-tools">${textControl}${state.user?.role!=='member'?`<details class="text-option voice-diagnostics"><summary>语音诊断</summary><div class="diagnostics-content"><p id="voice-log-status">${voice?.logSaved===false?'诊断日志保存失败，请告知管理员。':voice?.logSaved?'诊断日志已自动保存。':'测试时自动记录，结束后可导出。'}</p><p id="voice-health-status">${escapeHTML(healthText())}</p><p>往返耗时包含排队与处理，不代表语音识别耗时。诊断日志自动保存在你的账号中，不含录音或聊天文字；刷新页面后仍可导出。</p><button class="button secondary" data-action="voice-health-download">导出诊断日志</button></div></details>`:''}</div><div id="usage-panel" class="usage-panel">${usageContent()}</div></div></div>`;
  }
  function sessionManagement() {
    if(!state.sessions.length)return '';
    return '<section class="card"><h2>按次管理聊天</h2><p class="muted">不想保留某次对话，可以连同原话、相关回忆和书稿引用一起删除。</p><div class="list">'+[...state.sessions].reverse().map(session=>'<div class="section-head"><div><strong>'+escapeHTML(fmt(session.startedAt))+' · '+escapeHTML(storyLabel(session))+'</strong><p class="muted">'+(session.turns||[]).filter(t=>t.role==='user').length+' 段原话 · '+(session.turns||[]).length+' 条消息</p></div><div class="toolbar-actions"><button class="small-action" data-session="'+escapeHTML(session.id)+'" type="button">查看聊天</button><button class="small-action" data-action="delete-session" data-session-id="'+escapeHTML(session.id)+'" type="button">删除这次聊天</button></div></div>').join('')+'</div></section>';
  }
  function memoryPage() { if (!state.book) return home(); return `<div class="page">${bookHead()}${tabs('memory')}${sessionManagement()}<div class="section-head"><div><h2>保存的回忆线索</h2><p>这里保存原话线索，聊天时会查找相关内容。纠错会用于之后的聊天；未确认内容不会当成已核实事实。</p></div></div>${state.claims.length ? `<div class="list">${state.claims.map(c => `<article class="card memory-card"><p>${escapeHTML(c.text)}</p><div class="memory-actions"><span class="badge ${c.status==='confirmed'?'':'warn'}">${c.status==='confirmed'?'已确认':'待确认'}</span><button class="small-action" data-action="claim-source" data-claim="${escapeHTML(c.id)}" type="button">查看原话</button>${c.status!=='confirmed' ? `<button class="small-action" data-action="confirm-claim" data-claim="${escapeHTML(c.id)}" type="button">确认无误</button>`:''}<button class="small-action" data-action="edit-claim" data-claim="${escapeHTML(c.id)}" type="button">纠正</button><button class="small-action" data-action="delete-claim" data-claim="${escapeHTML(c.id)}" type="button">删除</button></div>${state.sourceId===c.id?sourcePanel(c.sourceTurnId):''}</article>`).join('')}</div>` : `<div class="empty"><div class="empty-icon">✧</div><h3>还没有整理出的回忆</h3><p>聊几句之后，原话会列在这里，供你核对和纠错。</p><button class="button primary" data-action="start-chat" type="button">开始聊天</button></div>`}</div>`; }
  function findTurn(id) { for (const s of state.sessions) { const t = (s.turns || []).find(x => x.id === id); if (t) return {turn:t,session:s}; } return null; }
  function sourcePanel(ids) { const list = Array.isArray(ids) ? ids : ids ? [ids] : []; if (!list.length) return `<div class="source-panel">这段暂时没有可定位的原话，请人工核对。</div>`; return `<div class="source-panel"><strong>来自原始聊天</strong>${list.map(id => { const found = findTurn(id); return found ? `<div>「${escapeHTML(found.turn.text)}」<br><small>${escapeHTML(fmt(found.session.startedAt))} · ${found.turn.excludedFromBook?'已排除书稿':'原话记录'}</small></div>` : `<div>来源记录已不可用（${escapeHTML(id)}）</div>`; }).join('<hr>')}</div>`; }
  function pendingManuscriptPanel(){
    const pending=(state.book.manuscript?.pending||[]).filter(p=>{const found=findTurn(p.sourceTurnId);return found&&!found.turn.deleted&&!found.turn.excludedFromBook&&!found.turn.avoided&&state.claims.some(c=>c.sourceTurnId===p.sourceTurnId&&c.status!=='rejected');});
    if(!pending.length)return '';
    return `<details class="notice"><summary>待确认的原话（${pending.length}）</summary><p>这些片段暂未写进书稿，原话仍完整保留。补充上下文或纠正转写后，可以再次更新书稿。</p>${pending.map(p=>`<p>「${escapeHTML(p.text)}」<br><small>${escapeHTML(p.reason)}</small> <button class="small-action" data-action="edit-claim" data-claim="${escapeHTML(p.unitId.split(':')[0])}">纠正原话</button></p>`).join('')}</details>`;
  }
  function chaptersPage() { if (!state.book) return home(); return `<div class="page">${bookHead()}${tabs('chapters')}<div class="section-head"><div><h2>正在写成的书</h2><p>书稿或素材来自聊天记录。点击段落下方的出处，可核对原话。</p></div><div class="section-actions">${state.chapters.length ? '<button class="button secondary" data-action="export-html" type="button">↓ 导出书稿</button><button class="button primary" data-action="new-chapter" type="button">↻ 更新书稿</button><button class="button secondary" data-action="reorganize-manuscript" type="button">整理全书</button>' : ''}</div></div>${state.book.manuscriptVersions?.length?`<details class="manuscript-history"><summary>历史版本（${state.book.manuscriptVersions.length}）</summary><p>恢复前会保存当前书稿；涉及已修改或删除素材的旧版本不能恢复。</p>${[...state.book.manuscriptVersions].reverse().map(v=>`<p>${escapeHTML(new Date(v.savedAt).toLocaleString('zh-CN'))} · ${v.chapters.length} 篇 <button class="button secondary" data-action="restore-manuscript" data-version="${escapeHTML(v.id)}">恢复此版本</button></p>`).join('')}</details>`:''}<div class="notice">书稿由聊天内容整理而来，仍需核对事实。分享或印刷前，请本人通读并核对。${state.book.manuscript?.coverage?`<p>上次整理：${state.book.manuscript.coverage.included} / ${state.book.manuscript.coverage.total} 段素材已写入正文${state.book.manuscript.coverage.pending?`，另有 ${state.book.manuscript.coverage.pending} 段待确认，暂未写入`:""}。出处对应不代表所有细节已核实。</p>`:""}</div>${pendingManuscriptPanel()}${(state.book.manuscript?.sections||[]).some(s=>s.issues?.length)?`<details class="notice"><summary>待核对的问题</summary>${state.book.manuscript.sections.flatMap(s=>(s.issues||[]).map(x=>`<p>${escapeHTML(s.title)}：${escapeHTML(x)}</p>`)).join("")}</details>`:""}${state.chapters.length ? `<div class="list">${state.chapters.map(ch => `<article class="card chapter-card"><div class="section-head"><h2>${escapeHTML(ch.title)}</h2><span class="badge ${ch.status==='needs_review'?'warn':''}">${ch.invalidated?'素材有修改，待更新':'草稿'}</span></div>${(ch.paragraphs || []).map(p => `<div class="chapter-paragraph">${p.sectionTitle&&p.sectionTitle!==ch.title?`<h3 class="story-heading">${escapeHTML(p.sectionTitle)}</h3>`:""}${escapeHTML(p.text)}<button class="paragraph-source" data-action="source-paragraph" data-paragraph="${escapeHTML(p.id)}" type="button">查看出处 ${p.sourceTurnIds?.length || 0} 条</button>${state.sourceId===p.id?sourcePanel(p.sourceTurnIds):''}</div>`).join('') || '<p class="muted">这一章暂时没有可用素材。</p>'}</article>`).join('')}</div>` : `<div class="empty"><div class="empty-icon">✦</div><h3>书稿将在这里出现</h3><p>聊过一些故事后，可以用现有的内容生成书稿。素材不足时，章节会明确显示空缺。</p><button class="button primary" data-action="new-chapter" type="button">生成书稿</button></div>`}</div>`; }
  function options(values,current){return values.map(x=>{const v=Array.isArray(x)?x[0]:x,label=Array.isArray(x)?x[1]:x;return `<option value="${escapeHTML(v)}" ${String(current)===String(v)?'selected':''}>${escapeHTML(label)}</option>`;}).join('');}
  const voiceLabels={longanqian:'默认音色',longanlingxin:'龙安灵心 · 温暖女声',longanlingxi:'龙安灵希 · 甜美女声',longanxiaoxin:'龙安小昕 · 活泼女声',longanlufeng:'龙安鲁风 · 开朗男声'};
  function qwenVoiceOptions(model,settings=state.settings){const m=state.voiceModels[model];return options((m?.voices||[]).map(id=>[id,voiceLabels[id]||id]),settings.qwenVoices?.[model]||m?.voices?.[0]);}
  function userSettingsPage(){
    const s=state.settings,m=state.voiceModels[s.qwenVoiceModel];
    return `<div class="page form-panel"><p class="eyebrow">MAKE IT YOURS</p><h1 class="page-title">个人设置</h1><p class="muted">选择聊天的声音和书稿的表达方式，只影响你自己的账号。</p><form id="user-preferences-form" class="settings-card"><h2>书稿风格</h2><div class="field"><label for="personal-manuscript-style">生成书稿的风格</label><select id="personal-manuscript-style" name="manuscriptStyle">${options([['plain','朴实自然（默认）'],['conversational','保留口吻'],['reflective','细腻叙事']],s.manuscriptStyle||'plain')}</select><small>朴实自然：简洁顺畅，少修饰。保留口吻：保留你的说话特色和幽默。细腻叙事：细致呈现已有的场景与感受，稍有文采。</small></div><p class="muted">所有风格都会清理无意义的语气词，保留事实和细节。更改后，下次生成或更新书稿生效；更新时会按新风格重新整理已有正文，旧稿保存在历史版本中。</p><h2>聊天声音</h2>${s.mode==='qwen'&&m?`<div class="field"><label for="personal-voice">聊天音色</label><select id="personal-voice" name="voice">${qwenVoiceOptions(s.qwenVoiceModel)}</select></div><div class="field"><label for="personal-speech-rate">说话节奏</label><select id="personal-speech-rate" name="speechRate">${options([['slow','舒缓'],['normal','自然'],['fast','轻快']],s.qwenSpeechRate)}</select><small>这是语速偏好，实际节奏会随对话内容变化。</small></div>`:'<p class="muted">当前语音服务暂不支持个人声音设置。</p>'}<p class="muted">选择后自动保存。声音偏好在下次语音聊天生效。</p><p id="user-preferences-result" role="status" aria-live="polite"></p><button class="button secondary" type="submit">保存设置</button></form><button class="button ghost" data-view="home" type="button">返回主页 →</button></div>`;
  }
  function settingsPage() {
    if(state.user?.role==='member')return userSettingsPage();
    const defaults=state.serviceSettings?.mode?state.serviceSettings:state.settings;
    const s={...defaults,mode:'qwen'};
    return `<div class="page form-panel"><p class="eyebrow">MAKE IT YOURS</p><h1 class="page-title">连接与声音</h1><p class="muted">选择模型或声音后会立即保存；下一次语音连接生效。</p>
    <form id="settings-form" class="settings-card">
    <input type="hidden" name="mode" value="qwen">
    <section><h2>千问配置</h2>
    <div class="field"><label for="apiKey">千问 API Key</label><input type="password" id="apiKey" name="apiKey" autocomplete="new-password" placeholder="${s.hasKey?'已保存，留空保留':'尚未配置，请填写'}"><small>文字和实时语音共用一个密钥，可在千问 AI 平台获取。</small></div>
    <div class="field"><label for="qwenVoiceModel">千问实时语音模型</label><select id="qwenVoiceModel" name="qwenVoiceModel">${options(Object.entries(state.voiceModels).filter(([,v])=>v.provider==='qwen').map(([k,v])=>[k,v.label]),s.qwenVoiceModel)}</select></div>
    <div class="focus-fields"><div class="field"><label for="qwenVoice">默认千问音色</label><select id="qwenVoice" name="qwenVoice">${qwenVoiceOptions(s.qwenVoiceModel,s)}</select><small>未设置个人声音时使用；仅列出该模型支持的音色。</small></div>
    <div class="field"><label for="qwenSpeechRate">千问语速偏好</label><select id="qwenSpeechRate" name="qwenSpeechRate">${options([['slow','舒缓'],['normal','正常'],['fast','轻快']],s.qwenSpeechRate)}</select><small>通过语音指令控制，不保证精确倍速。</small></div></div>
    <div class="field"><label for="qwenTurnDetection">聊天节奏</label><select id="qwenTurnDetection" name="qwenTurnDetection">${options([['semantic_vad','理解话意，容许思考'],['server_vad','更快打断，停顿后回应']],s.qwenTurnDetection||'semantic_vad')}</select><small>更快打断适合安静环境；停顿约 1.2 秒后回应。</small></div>
    <p class="muted">语音通过 WebRTC 直接通话。</p>
    <div class="field"><label for="model">千问文字与书稿模型</label><select id="model" name="model">${options([['qwen3.8-flash','qwen3.8-flash'],['qwen3.7-plus','qwen3.7-plus'],['qwen3.8-max','qwen3.8-max'],...s.model&&!['qwen3.8-flash','qwen3.7-plus','qwen3.8-max'].includes(s.model)?[[s.model,'当前模型 · '+s.model]]:[]],s.model||'qwen3.8-flash')}</select><small>Flash 适合低成本起草；Plus、Max 可用于比较成稿效果。选择后自动保存；模型需在你的账号中可用。</small></div>

    </section>
    <button class="button secondary" type="submit">保存设置</button><p id="settings-result" role="status"></p></form>
    <div class="settings-card"><h2>书籍与备份</h2><p class="muted">移出、恢复和永久删除都在书架管理。</p><button class="button secondary" data-view="shelf">前往书架</button></div></div>`;

  }
  function usageContent(){
    if(!voice||!latestUsage?.warning)return '';
    return '<div class="notice" role="status">聊得比较久了，较早的细节可能不在模型当前记忆中。已保存的文字记录仍会保留，可以继续聊。</div>';
  }

  function dialog({title,body,confirm='确定',cancel='取消',danger=false,onConfirm}) { const root = $('#dialog-root'); root.innerHTML = `<div class="dialog-backdrop"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><h2 id="dialog-title">${escapeHTML(title)}</h2>${body}<div class="dialog-actions"><button class="button secondary" data-dialog-cancel type="button">${escapeHTML(cancel)}</button><button class="button ${danger?'danger':'primary'}" data-dialog-confirm type="button">${escapeHTML(confirm)}</button></div></div></div>`; const close = () => root.innerHTML = ''; $('[data-dialog-cancel]',root).onclick = close; $('.dialog-backdrop',root).onclick = e => { if (e.target.classList.contains('dialog-backdrop')) close(); }; $('[data-dialog-confirm]',root).onclick = async () => { const btn = $('[data-dialog-confirm]',root); btn.disabled = true; try { const result = await onConfirm(root); if (result !== false) close(); } catch(e) { const el = $('.dialog-error',root); if (el) {el.textContent = errorMessage(e);el.hidden=false;} else toast(errorMessage(e)); } finally { btn.disabled = false; } }; $('[autofocus]',root)?.focus(); }
  async function startChat(preferVoice = false, focus = null, forceNew = false) {
    if(!state.book)return;const bookId=state.book.id,navigation=navigationVersion;
    const ongoing=state.sessions.at(-1);
    const useOngoing=!forceNew&&ongoing;
    if(useOngoing){state.sessionId=ongoing.id;state.paused=false;setView('chat');}
    else {
      const nextFocus=focus||ongoing?.focus||state.sessions.at(-1)?.focus||state.focus;
      const session=await api(`/api/books/${bookId}/sessions`,{method:'POST',body:{voice:preferVoice,intent:forceNew?'new_topic':'continue',focus:nextFocus}});
      assertNavigation(navigation);state.sessionId=session.id;state.paused=false;await refresh();assertNavigation(navigation);setView('chat');
    }
    if(preferVoice)await startVoice();
  }
  async function download(path, name) { const res = await fetch(path,{headers:state.token?{'X-LifeBook-Token':state.token}:{}}); if (!res.ok) throw new Error(`下载失败（${res.status}）`); const url = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href=url; a.download=name; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),30000); }
  async function act(action, element) {
    if(action==='voice-health-download'){
      const data=await api('/api/voice-diagnostics');
      if(!data.trim()){toast('还没有保存的语音诊断日志。');return;}
      const url=URL.createObjectURL(new Blob([data],{type:'text/plain'}));
      const link=document.createElement('a');link.href=url;link.download='lifebook-voice-diagnostics.jsonl';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
    }

    const id = state.book?.id;
    if (voice && ['exclude-turn','edit-turn','delete-turn','confirm-claim','edit-claim','new-chapter'].includes(action)) await stopVoice();
    if(action==='reconnect-voice'){await stopVoice();await startVoice();return;}
    if(action==='latest-message'){transcriptView?.follow({resume:true});element.hidden=true;return;}
    if(action==='home-continue'||action==='home-new-topic'){if(state.busy)return;state.busy=true;element.disabled=true;try{if(voice)await stopVoice();await loadBook(element.dataset.id);textComposerOpen=false;await startChat(voiceAllowed(),null,action==='home-new-topic');}finally{state.busy=false;render();}return;}
    if(action==='dismiss-job'){await api('/api/chapter-jobs/dismiss',{method:'POST',body:{id:element.dataset.id}});await pollChapterJobs();return;}
    if(action==='retry-manuscript'){await api('/api/chapter-jobs/retry',{method:'POST',body:{id:element.dataset.id}});await pollChapterJobs();toast('正在继续生成；素材有变化时会重新核对。');return;}
    if(action==='preview-manuscript'){const data=await api(`/api/books/${element.dataset.bookId}/manuscript/progress`);return dialog({title:'已完成的小节（尚未更新正式书稿）',body:data.chapters.map(c=>`<h3>${escapeHTML(c.title)}</h3>${c.paragraphs.map(p=>`<p>${escapeHTML(p.text)}</p>`).join('')}`).join('')||'<p>暂无完成的小节。</p>',confirm:'关闭',onConfirm:async()=>{}});}
    if(action==='view-job'){const job=chapterJobs.find(j=>j.id===element.dataset.id);if(job){if(voice)await stopVoice();await loadBook(job.bookId);setView('chapters');}return;}
    if (action === 'reload') { location.reload(); return; }
    if (action === 'new-book') return dialog({title:'开始一本新书',body:'<p>给这段旅程起个名字。之后随时可以修改聊天内容。</p><div class="field"><label for="book-title">书名</label><input id="book-title" maxlength="80" value="我的人生之书" autofocus required></div><div class="field"><label for="book-name">讲述者的名字</label><input id="book-name" maxlength="80" placeholder="怎么称呼你？"></div><p class="dialog-error error" aria-live="polite" hidden></p>',confirm:'创建书本',onConfirm:async root=>{const title=$('#book-title',root).value.trim(); if(!title){$('#book-title',root).focus();return false;} if(voice)await stopVoice(); const book=await api('/api/books',{method:'POST',body:{title,name:$('#book-name',root).value.trim()}});state.books.unshift(book);await loadBook(book.id);setView('book');toast('新书已建立，可以开始聊天了。');}});
    if (action === 'start-chat') return await startChat();
    if (action === 'start-voice-chat') return await startChat(true);
    if (action === 'exit-chat') {
      if(state.exiting)return;const navigation=++navigationVersion;state.exiting=true;state.paused=true;render();
      try{if(voice)await stopVoice();assertNavigation(navigation);textComposerOpen=false;setView('book');toast('聊天记录已保存，下次可以接着聊。');}
      finally{state.exiting=false;render();}return;
    }
    if (action === 'voice-toggle') { if (voice) await act('pause-voice',element); else {if(state.busy||state.exiting)return;state.paused=false;transcriptView?.follow({resume:true});await startVoice();render();} return; }
    if (action === 'pause-voice') {
      if(state.busy)return;state.busy=true;state.paused=true;element.disabled=true;
      transcriptView?.pause();render();
      try{if(voice)await stopVoice();await loadBook(id,{background:true});textComposerOpen=false;state.paused=true;toast('语音已暂停，随时可以接着聊。');}
      finally{state.busy=false;render();}return;
    }
    if(action==='pick-stage'){state.focus=readFocus();state.focus.stage=element.dataset.stage;render();return;}
    if(action==='new-focused-voice'||action==='new-focused-text'){if(state.busy)return;textComposerOpen=action==='new-focused-text';state.busy=true;element.disabled=true;try{await startChat(action==='new-focused-voice',state.focus,true);}finally{state.busy=false;render();}return;}
    if(action==='continue-story'){textComposerOpen=false;await startChat(voiceAllowed(),state.sessions.at(-1)?.focus);return;}
    if(action==='archive-book'){const target=element.dataset.id||id;const book=state.books.find(b=>b.id===target);return dialog({title:'移出书架？',body:`<p>「${escapeHTML(book?.title)}」会放到书架下方的“已移出书架”，内容保留，随时可以放回。</p>`,confirm:'移出书架',onConfirm:async()=>{if(voice)await stopVoice();await api(`/api/books/${target}/archive`,{method:'POST',body:{archived:true}});if(state.book?.id===target){state.book=null;state.sessionId=null;}await bootstrap();setView('shelf');toast('已移出，内容仍保留。');}});}
    if(action==='restore-book'){await api(`/api/books/${element.dataset.id}/archive`,{method:'POST',body:{archived:false}});await bootstrap();render();toast('已放回书架。');return;}
    if(action==='delete-book'){const target=element.dataset.id;const book=[...state.books,...state.archivedBooks].find(b=>b.id===target);if(!book)return;return dialog({title:'永久删除这本书？',body:`<p>将删除「${escapeHTML(book.title)}」在本机的所有聊天、回忆和书稿，无法撤销。已下载的备份和已发送至服务商的数据不会因此删除。</p>`,confirm:'永久删除',danger:true,onConfirm:async()=>{if(voice)await stopVoice();await api(`/api/books/${target}`,{method:'DELETE',body:{confirmTitle:book.title}});if(state.book?.id===target){state.book=null;state.sessionId=null;state.sessions=[];state.claims=[];state.chapters=[];}await bootstrap();setView('shelf');toast('这本书已永久删除。');}});}
    if(action==='topic')return dialog({title:'换一个回忆方向',body:'<p>之前的故事会保留，接下来围绕新的主线聊。</p>'+focusFields(currentSession()?.focus||state.focus),confirm:'换到这个方向',onConfirm:async root=>{const focus=readFocus(root),wasVoice=!!voice;if(voice)await stopVoice();await api(`/api/books/${id}/topic`,{method:'POST',body:{sessionId:state.sessionId,focus,nextTopic:[focus.stage,focus.theme].join(' · ')}});state.focus=focus;await refresh();if(wasVoice)await startVoice();}});
    if (action === 'exclude-turn') {const sid=element.dataset.sessionId,tid=element.dataset.turn;const turn=findTurn(tid)?.turn;await api(`/api/books/${id}/sessions/${sid}/turns/${tid}`,{method:'PATCH',body:{excludedFromBook:!turn?.excludedFromBook}});await refresh();toast(turn?.excludedFromBook?'已恢复用于书稿。':'这段不会用于新书稿；已有章节会标记待核查。');return;}
    if (action === 'edit-turn') {const sid=element.dataset.sessionId,tid=element.dataset.turn,turn=findTurn(tid)?.turn;return dialog({title:'修改原话',body:`<p>纠正转写或措辞。依赖这段话的回忆和章节需要重新核查。</p><div class="field"><label for="turn-text">聊天内容</label><textarea id="turn-text" rows="5" autofocus>${escapeHTML(turn?.text)}</textarea></div>`,confirm:'保存修改',onConfirm:async root=>{const text=$('#turn-text',root).value.trim();if(!text)return false;await api(`/api/books/${id}/sessions/${sid}/turns/${tid}`,{method:'PATCH',body:{text}});await refresh();}});}
    if(action==='delete-claim'){
      const claim=state.claims.find(c=>c.id===element.dataset.claim),source=claim&&findTurn(claim.sourceTurnId);
      if(!source)throw new Error('找不到这条回忆的原话，请刷新后重试。');
      return act('delete-turn',{dataset:{sessionId:source.session.id,turn:source.turn.id,memory:'true'}});
    }
    if(action==='delete-session'){
      const sid=element.dataset.sessionId,session=state.sessions.find(s=>s.id===sid);if(!session)return;
      return dialog({title:'删除这次聊天？',body:'<p>将永久删除 '+escapeHTML(fmt(session.startedAt))+' 这次聊天的全部消息、相关回忆，以及当前和历史书稿中依赖它的内容。其他聊天会保留。</p><p>此操作无法撤销。已经下载的备份及已发送给服务商的数据不会因此删除。</p>',confirm:'永久删除这次聊天',danger:true,onConfirm:async()=>{
        if(voice)await stopVoice();
        await api('/api/books/'+id+'/sessions/'+sid,{method:'DELETE'});
        chatDrafts.delete(draftKey(id,sid));
        if(state.book?.id===id){if(state.sessionId===sid){state.sessionId=null;state.paused=false;}await refresh();}
        toast('已删除这次聊天及相关回忆。');
      }});
    }
    if (action === 'delete-turn') {const sid=element.dataset.sessionId,tid=element.dataset.turn;return dialog({title:element.dataset.memory?'删除这条回忆及原话？':'删除这段聊天？',body:'<p>这会永久删除选中的原话、由它产生的回忆，以及当前和历史书稿中依赖它的内容。已经下载的文件及已发送至在线服务商的数据无法召回。</p>',confirm:'永久删除',danger:true,onConfirm:async()=>{await api(`/api/books/${id}/sessions/${sid}/turns/${tid}`,{method:'DELETE'});await refresh();toast('已删除这段聊天。');}});}
    if (action === 'confirm-claim') {await api(`/api/books/${id}/claims/${element.dataset.claim}`,{method:'PATCH',body:{status:'confirmed'}});await refresh();return;}
    if (action === 'edit-claim') {const c=state.claims.find(x=>x.id===element.dataset.claim);return dialog({title:'纠正这条回忆',body:`<p>修改后，受影响的书稿会标记为需要核查。</p><div class="field"><label for="claim-text">正确的说法</label><textarea id="claim-text" rows="4" autofocus>${escapeHTML(c?.text)}</textarea></div>`,confirm:'保存纠正',onConfirm:async root=>{const text=$('#claim-text',root).value.trim();if(!text)return false;await api(`/api/books/${id}/claims/${c.id}`,{method:'PATCH',body:{text,status:'confirmed'}});await refresh();toast('已更新这条回忆。');}});}
    if (action === 'claim-source') {state.sourceId=state.sourceId===element.dataset.claim?null:element.dataset.claim;render();return;}
    if (action === 'source-paragraph') {state.sourceId=state.sourceId===element.dataset.paragraph?null:element.dataset.paragraph;render();return;}
    if(action==='restore-manuscript')return dialog({title:'恢复这个版本？',body:'<p>当前书稿会先保存为历史版本，之后可再恢复。</p>',confirm:'恢复',onConfirm:async()=>{await api(`/api/books/${id}/manuscript/restore`,{method:'POST',body:{versionId:element.dataset.version}});await refresh();toast('已恢复书稿，原稿保存在历史版本中。');}});
    if (action === 'reorganize-manuscript') return dialog({title:'整理全书',body:'<p>重新核对全部素材，逐批整理目录和故事小节。适合准备导出前使用，比日常局部更新耗时更多。旧稿会保留为历史版本。</p>',confirm:'开始整理',onConfirm:async()=>{await api(`/api/books/${id}/chapter-jobs`,{method:'POST',body:{title:state.book.title,mode:'reorganize'}});await pollChapterJobs();}});
    if (action === 'new-chapter') return dialog({title:state.chapters.length?'更新书稿':'生成书稿',body:'<p>AI 会参考已有目录，把新增故事归入相关章节，通常只更新受影响的小节；更改书稿风格后会重新整理已有正文。长素材自动分批，完整保留原话。首次升级会整理已有素材，旧稿保存在历史版本中。</p><p>后台生成期间可以继续聊天；新说的内容留待下次更新。已完成小节会保存进度，中断后可继续。</p>',confirm:state.chapters.length?'开始更新':'开始生成',onConfirm:async()=>{await api(`/api/books/${id}/chapter-jobs`,{method:'POST',body:{title:state.book.title,mode:'update'}});await pollChapterJobs();toast('正在后台更新书稿，完成后提醒你。');}});
    if (action === 'export-md' || action === 'export-html') return download(`/api/books/${id}/export?format=${action==='export-md'?'md':'html'}`,`${safeName(state.book.title)}.${action==='export-md'?'md':'html'}`);
    if (action === 'backup') return download(`/api/books/${id}/backup`,`${safeName(state.book.title)}-backup.json`);
    if (action === 'restore') { const input=document.createElement('input');input.type='file';input.accept='.json,application/json';input.onchange=async()=>{const file=input.files?.[0];if(!file)return;try{if(file.size>100*1024*1024)throw new Error('备份文件超过 100 MB，请选择较小的备份。');const backup=JSON.parse(await file.text());const book=await api('/api/restore',{method:'POST',body:backup});await bootstrap();await loadBook(book.id);setView('book');toast('备份已恢复。');}catch(e){toast(errorMessage(e));}};input.click();return; }
  }
  function safeName(name){return (name||'lifebook').replace(/[\\/:*?"<>|]/g,'-').slice(0,80);}
  document.addEventListener('click', async e => {const b=e.target.closest('button,[data-book],[data-view]');if(!b)return;if(b.tagName==='A')e.preventDefault();if(b.id==='menu-toggle'){const open=$('.sidebar').classList.toggle('open');b.setAttribute('aria-expanded',String(open));return;}if(b.id==='menu-backdrop'){$('.sidebar').classList.remove('open');$('#menu-toggle').setAttribute('aria-expanded','false');return;}try{if(b.dataset.book){const navigation=++navigationVersion;if(voice)await stopVoice();assertNavigation(navigation);await loadBook(b.dataset.book);assertNavigation(navigation);setView('book');return;}if(b.dataset.session){const navigation=++navigationVersion;if(voice)await stopVoice();assertNavigation(navigation);state.sessionId=b.dataset.session;state.paused=false;setView('chat');return;}if(b.dataset.view){const navigation=++navigationVersion;if(voice)await stopVoice();assertNavigation(navigation);setView(b.dataset.view);return;}if(b.id==='new-book-side'){await act('new-book',b);return;}if(b.dataset.action)await act(b.dataset.action,b);}catch(error){toast(errorMessage(error));}});
  document.addEventListener('input',e=>{if(e.target.id==='chat-input'&&renderedDraftKey)chatDrafts.set(renderedDraftKey,e.target.value);});
  document.addEventListener('toggle',e=>{if(e.target.matches?.('.text-composer'))textComposerOpen=e.target.open;},true);
  document.addEventListener('submit', async e => {if(e.target.id==='user-preferences-form'){e.preventDefault();await savePersonalPreferences(e.target);return;}if(e.target.id==='chat-form'){
      e.preventDefault();if(state.busy)return;
      const input=$('#chat-input'),text=input.value.trim();if(!text)return;
      const bookId=state.book.id,sessionId=state.sessionId,key=draftKey(bookId,sessionId);captureDraft();
      state.busy=true;state.paused=false;chatDrafts.delete(key);input.value='';followLatest=true;transcriptView?.follow({resume:true});render();
      let sent=false;
      try{if(voice)await stopVoice();pendingTextReply={bookId,sessionId};render();await api(`/api/books/${bookId}/sessions/${sessionId}/turns`,{method:'POST',body:{text}});sent=true;pendingTextReply=null;if(state.book?.id===bookId&&state.sessionId===sessionId)await loadBook(bookId,{background:true});}
      catch(error){if(!sent){captureDraft();const next=chatDrafts.get(key)||'',restored=next?text+'\n'+next:text;chatDrafts.set(key,restored);if(renderedDraftKey===key&&$('#chat-input'))$('#chat-input').value=restored;}toast(errorMessage(error));}
      finally{pendingTextReply=null;state.busy=false;render();if(state.book?.id===bookId&&state.sessionId===sessionId)$('#chat-input')?.focus();}return;
    }if(e.target.id==='settings-form'){e.preventDefault();const f=new FormData(e.target);const body={mode:f.get('mode'),qwenConnection:'unified',model:String(f.get('model')||'').trim()};body.qwenVoiceModel=f.get('qwenVoiceModel');body.qwenVoice=f.get('qwenVoice');body.qwenSpeechRate=f.get('qwenSpeechRate');body.qwenTurnDetection=f.get('qwenTurnDetection');if(f.get('apiKey'))body.apiKey=String(f.get('apiKey')).trim();try{if(voice)await stopVoice();const settings=await api('/api/settings',{method:'PUT',body});state.serviceSettings=settings.settings||settings;state.settings={...state.settings,...state.serviceSettings};await bootstrap();render();$('#settings-result').textContent='设置已保存，下次语音连接生效。';toast('设置已保存。');}catch(error){toast(errorMessage(error));}}});
  let voicePreferenceSaving=false;
  async function savePersonalPreferences(form){
    if(voicePreferenceSaving)return;
    const f=new FormData(form),body={manuscriptStyle:f.get('manuscriptStyle')};
    if(f.has('voice'))Object.assign(body,{model:state.settings.qwenVoiceModel,voice:f.get('voice'),speechRate:f.get('speechRate')});
    const selects=[...form.querySelectorAll('select')];voicePreferenceSaving=true;selects.forEach(select=>select.disabled=true);
    const result=form.querySelector('#user-preferences-result');if(result)result.textContent='正在保存…';
    try{
      state.settings={...state.settings,...await api('/api/user-preferences',{method:'PUT',body})};
      if(result)result.textContent='已保存。声音在下次语音聊天生效，书稿风格在下次生成或更新生效。';
    }catch(error){if(result)result.textContent='保存失败：'+errorMessage(error);toast(errorMessage(error));}
    finally{voicePreferenceSaving=false;selects.forEach(select=>select.disabled=false);}
  }
  document.addEventListener('change',e=>{
    const personal=e.target.closest?.('#user-preferences-form');if(personal&&e.target.tagName==='SELECT'){void savePersonalPreferences(personal);return;}
    if(e.target.id==='qwenVoiceModel')$('#qwenVoice').innerHTML=qwenVoiceOptions(e.target.value,state.serviceSettings?.mode?state.serviceSettings:state.settings);
    // Choices are durable immediately; credentials and free-text fields still require an explicit form submit.
    if(e.target.closest?.('#settings-form')&&e.target.tagName==='SELECT')$('#settings-form').requestSubmit();
  });
  document.addEventListener('keydown',e=>{if(e.target.id==='chat-input'&&e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#chat-form').requestSubmit();}if(e.key==='Escape'){if($('#dialog-root').innerHTML)$('#dialog-root').innerHTML='';$('.sidebar')?.classList.remove('open');$('#menu-toggle').setAttribute('aria-expanded','false');}});
  (async()=>{try{await bootstrap();render();}catch(error){app.innerHTML=`<div class="page"><div class="error">无法连接 LifeBook 服务：${escapeHTML(errorMessage(error))}</div><p class="muted">请确认本地服务已启动，然后刷新页面。</p><button class="button secondary" data-action="reload">重试</button></div>`;}})();
})();


