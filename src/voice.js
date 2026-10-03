import {VoiceDiagnostics} from './voice-diagnostics.js';
import {WebRtcProvider} from './webrtc-provider.js';
import {trackAccountUsage} from './account-usage.js';
import {VoiceUsage} from './usage.js';
import {voiceConnectionError,voiceProviderMessage} from './voice-connection.js';
import {TranscriptOrder} from './transcript-order.js';
import {selectedModel,initialVoiceConfig,speechPreference} from './models.js';
import { buildContext, contextInstructions } from './context.js';
import { interviewGuidance, openingRequestFor, resumeRequestFor } from './interview.js';
import { WebSocket, WebSocketServer } from 'ws';
import {createHash} from 'node:crypto';
import { getBook, getSecret, getSettings, updateBook } from './storage.js';
import { turn, extractClaim, refusedTopic, invalidate } from './engine.js';

const server = new WebSocketServer({ noServer:true, maxPayload:128*1024, handleProtocols:protocols=>protocols.has('lifebook')?'lifebook':false });
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const send=(ws,data)=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(data));};
export const voicePrompt=(book,session)=>contextInstructions(book,session)+'\n'+interviewGuidance;
const preparationSignature=(settings,apiKey)=>createHash('sha256').update(JSON.stringify([settings.mode,settings.qwenConnection,initialVoiceConfig(settings,''),apiKey])).digest('hex');

async function prepareSession(ws,offer){
  const settings=await getSettings(),apiKey=await getSecret();
  if(ws.stopRequested||ws.readyState!==WebSocket.OPEN)throw Error('连接已取消');
  if(settings.mode!=='qwen'||settings.qwenConnection!=='unified'||!apiKey)throw Error('当前语音连接不支持预连接');
  const preparationDiagnostics=new VoiceDiagnostics({model:selectedModel(settings)}),preparingAt=Date.now();
  void preparationDiagnostics.record('preparation_start');
  const provider=new WebRtcProvider(ws,{apiKey,model:selectedModel(settings),offer});ws.provider=provider;
  return new Promise((resolve,reject)=>{
    let configured=false;
    let timer=setTimeout(()=>fail(),20000);
    const cleanup=()=>{clearTimeout(timer);provider.off('message',message);provider.off('error',fail);provider.off('close',fail);ws.off('close',fail);};
    const fail=()=>{cleanup();reject(Error('语音预连接未完成'));};
    const message=raw=>{
      let event;try{event=JSON.parse(raw.toString());}catch{return;}
      if(event.type==='session.created')provider.send(JSON.stringify({type:'session.update',session:initialVoiceConfig(settings,'等待用户开始聊天。')}));
      if(event.type==='error')return fail();
      if(event.type==='session.updated'&&!configured){
        configured=true;clearTimeout(timer);
        timer=setTimeout(()=>{cleanup();if(ws.readyState===WebSocket.OPEN)ws.close(1000,'preparation expired');},65000);timer.unref();
        send(ws,{type:'prepared'});
        void preparationDiagnostics.record('preparation_ready',{server:{connectMs:Date.now()-preparingAt,rtcPrepared:true}});
        resolve({provider,signature:preparationSignature(settings,apiKey),dispose:cleanup});
      }
    };
    provider.on('message',message);provider.on('error',fail);provider.on('close',fail);ws.on('close',fail);
  });
}

async function attachSession(ws,bookId,sessionId,resume=false,options={}) {
  if(!idPattern.test(bookId||'')||!idPattern.test(sessionId||''))throw new Error('无效的书籍或会话 ID');
  const book=await getBook(bookId), session=book.sessions.find(s=>s.id===sessionId);
  if(!session)throw new Error('找不到这次聊天，请从书本重新进入');
  const settings=await getSettings(), apiKey=await getSecret();
  if(options.transport!=='webrtc')throw Error('语音仅支持 WebRTC，请刷新网页后重试');
  if(settings.mode!=='qwen')throw Error('请先配置千问 API Key');
  const model=selectedModel(settings);
  const instructions=(b,s)=>speechPreference(settings)+'\n'+voicePrompt(b,s);
  const meter=new VoiceUsage(model,'unified',instructions(book,session));
  let speechStart=null;
  if(ws.stopRequested||ws.readyState!==WebSocket.OPEN)return;
  if(!apiKey)throw new Error('请先填写千问 API Key');
  const diagnostics=new VoiceDiagnostics({model});
  void diagnostics.record('session_start',{server:{rtcTransport:true}});
  if(options.prepared&&(options.prepared.signature!==preparationSignature(settings,apiKey)||options.prepared.provider.readyState!==WebSocket.OPEN))throw Error('语音设置或连接已更新，请重新开始聊天');
  const provider=options.prepared?.provider||new WebRtcProvider(ws,{apiKey,model,offer:options.offer});
  ws.provider=provider;
  let activeResponseId=null;
  let configured=false,active=false,assistantText='',stopping=false,stopFinished=false,stopIdle,stopDeadline,suppressOutput=false;
  const resuming=resume&&session.turns.length>0;
  let openingPending=resuming||Boolean(session.voiceOnly&&session.turns.length===0);
  let microphoneReady=false,microphoneDeadline,startupFinished=false;
  const startConversation=()=>{
    if(!configured||!microphoneReady||startupFinished||stopping||suppressOutput||ws.readyState!==WebSocket.OPEN||provider.readyState!==WebSocket.OPEN)return;
    startupFinished=true;clearTimeout(microphoneDeadline);
    if(openingPending){
      send(ws,{type:'state',state:'speaking'});
      const context=buildContext(book,session);
      provider.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:resuming?resumeRequestFor(context):openingRequestFor(context.payload.interview)}]}}));
      provider.send(JSON.stringify({type:'response.create'}));
    }else if(!active)send(ws,{type:'state',state:'listening'});
  };
  let pendingWrites=Promise.resolve();
  let interruptedResponse=false;
  const pendingTranscriptions=new Set();
  const transcriptOrder=new TranscriptOrder();
  // ASR completes asynchronously. Reserve positions when speech/response starts,
  // before either side's text is ready, and persist them across page reloads.
  const positions=new Map(), cancelledResponses=new Set();
  let nextPosition=0, activeResponsePosition=null;
  const position=key=>{if(!positions.has(key))positions.set(key,nextPosition++);return positions.get(key);};
  const orderedFields=order=>({voiceRunId:diagnostics.id,voiceOrder:order});
  const insertTurn=(s,t)=>{
    const next=s.turns.findIndex(x=>x.voiceRunId===t.voiceRunId&&Number.isFinite(x.voiceOrder)&&x.voiceOrder>t.voiceOrder);
    if(next>=0)s.turns.splice(next,0,t);else s.turns.push(t);
  };
  const saveAssistant=(text,responseId,order,interrupted=false)=>{
    if(!text.trim())return;
    const assistantTurn=turn('assistant',text.trim().slice(0,4000),{viaVoice:true,provider:settings.mode,providerResponseId:responseId,...orderedFields(order),...(interrupted?{interrupted:true}:{})});
    queueWrite(async()=>{await updateBook(bookId,current=>{
      const s=current.sessions.find(x=>x.id===sessionId);if(!s)throw new Error('找不到这次聊天');s.endedAt=null;
      insertTurn(s,assistantTurn);current.updatedAt=new Date().toISOString();
    });send(ws,{type:'transcript',role:'assistant',text:assistantTurn.text,final:true,turn:assistantTurn});});
  };
  const queueWrite=fn=>{pendingWrites=pendingWrites.then(fn).catch(e=>send(ws,{type:'error',message:'保存语音记录失败：'+e.message}));return pendingWrites;};
  const publishUsage=(persist=false)=>{
    const snapshot={...meter.snapshot(speechStart?Math.max(0,Date.now()-speechStart.at)/1000:0),transport:'webrtc',clientReported:true,audioDurationIncomplete:true};send(ws,{type:'usage',usage:snapshot});
    void trackAccountUsage('voice',snapshot.id,snapshot.userAudioSeconds+snapshot.assistantAudioSeconds);
    if(persist)queueWrite(()=>updateBook(bookId,b=>{const s=b.sessions.find(x=>x.id===sessionId);if(!s)return;s.voiceRuns ||= [];const i=s.voiceRuns.findIndex(x=>x.id===snapshot.id);if(i<0)s.voiceRuns.push(snapshot);else s.voiceRuns[i]=snapshot;}));
  };
  const readyDeadline=setTimeout(()=>{if(!configured){send(ws,{type:'error',message:'语音服务连接超时，请检查 API Key、模型权限及网络后重试。'});provider.terminate();}},20000);
  const usageTick=setInterval(()=>publishUsage(),5000);
  const completeStop=(force=false)=>{
    if(!force&&pendingTranscriptions.size&&provider.readyState===WebSocket.OPEN)return;
    if(!stopping||stopFinished)return;stopFinished=true;
    clearTimeout(stopIdle);clearTimeout(stopDeadline);clearInterval(usageTick);clearTimeout(readyDeadline);clearTimeout(microphoneDeadline);
    // Pausing can close WebRTC before response.done arrives. Persist the text
    // already received before discarding the live preview and acknowledging stop.
    if(!suppressOutput&&!interruptedResponse&&assistantText){
      saveAssistant(assistantText,activeResponseId,activeResponsePosition??nextPosition++,active);
      assistantText='';
    }
    meter.state.endedAt=new Date().toISOString();publishUsage(true);
    pendingWrites.finally(()=>{send(ws,{type:'stopped'});if(ws.readyState===WebSocket.OPEN)ws.close(1000,'stopped');if(provider.readyState===WebSocket.OPEN)provider.close();});
  };
  const stopActivity=()=>{if(stopping){clearTimeout(stopIdle);stopIdle=setTimeout(completeStop,2200);}};
  const health={speechEvents:0};
  let lastProbe=0,lastClientMetrics={};
  const healthSnapshot=()=>({...health,transport:'webrtc'});
  provider.on('open',()=>{void diagnostics.record('provider_open');send(ws,{type:'state',state:'connecting'});});
  provider.on('message',data=>{
    if(stopFinished)return;
    let event;try{event=JSON.parse(data.toString());}catch{return;}
    event.type=({'response.output_audio.delta':'response.audio.delta','response.output_audio_transcript.delta':'response.audio_transcript.delta','response.output_audio_transcript.done':'response.audio_transcript.done'})[event.type]||event.type;
    if(event.type==='session.created'){
      provider.send(JSON.stringify({type:'session.update',session:initialVoiceConfig(settings,instructions(book,session))}));
      send(ws,{type:'usage',usage:meter.snapshot()});
    } else if(event.type==='session.updated'){
      if(configured||stopping)return;
      configured=true;void diagnostics.record('provider_ready');clearTimeout(readyDeadline);
      send(ws,{type:'ready',opening:openingPending,startupId:diagnostics.id});
      {
        send(ws,{type:'state',state:'正在准备麦克风与通话声音，请稍等…'});
        microphoneDeadline=setTimeout(()=>{
          if(microphoneReady||stopping||ws.readyState!==WebSocket.OPEN)return;
          void diagnostics.record('microphone_timeout');
          send(ws,{type:'error',message:'未收到麦克风就绪确认，请刷新网页后重新开始。'});provider.terminate();
        },12000);
      }
      startConversation();
    } else if(event.type==='conversation.item.input_audio_transcription.completed'){
      meter.transcription(event);
      const transcript=String(event.transcript||'').trim();
      void diagnostics.record('transcript_complete',{server:{...healthSnapshot(),transcriptChars:transcript.length}});
      if(event.item_id)pendingTranscriptions.delete(event.item_id);
      if(!transcriptOrder.complete(event.item_id,transcript))return;
      if(transcript){
        const userTurn=turn('user',transcript,{viaVoice:true,provider:settings.mode,providerItemId:event.item_id||null,...orderedFields(position(event.item_id?`user:${event.item_id}`:Symbol()))});
        const refusal=/(?:不要再提|别再提|别提|不想聊|不要聊)/.test(transcript);
        if(refusal){suppressOutput=true;assistantText='';if(active&&provider.readyState===WebSocket.OPEN)provider.send(JSON.stringify({type:'response.cancel'}));}
        queueWrite(async()=>{
          let duplicate=false;
          await updateBook(bookId,current=>{
            const s=current.sessions.find(x=>x.id===sessionId);if(!s)throw new Error('找不到这次聊天');s.endedAt=null;
            if(userTurn.providerItemId&&s.turns.some(t=>t.providerItemId===userTurn.providerItemId||t.providerItemIds?.includes(userTurn.providerItemId))){duplicate=true;return;}
            let avoided=refusedTopic(transcript);
            if(refusal&&!avoided)avoided=s.turns.filter(t=>t.role==='user'&&!t.avoided).at(-1)?.text.slice(0,50)||'';
            if(refusal){
              userTurn.avoided=true;
              if(avoided&&!current.avoidedTopics.some(x=>x.topic===avoided))current.avoidedTopics.push({topic:avoided,createdAt:new Date().toISOString()});
              const matching=refusedTopic(transcript)?current.sessions.flatMap(x=>x.turns).filter(t=>t.role==='user'&&!t.avoided&&t.text.includes(avoided)):[...s.turns].reverse().filter(t=>t.role==='user'&&!t.avoided).slice(0,1);
              for(const previous of matching){previous.avoided=true;previous.excludedFromBook=true;for(const group of current.sessions){const index=group.turns.findIndex(t=>t.id===previous.id);if(index>=0&&group.turns[index+1]?.role==='assistant')group.turns[index+1].avoided=true;}invalidate(current,previous.id);}
            }
            insertTurn(s,userTurn);
            if(!refusal)current.claims.push(extractClaim(userTurn));
            const sourceOrder=new Map(current.sessions.flatMap(group=>group.turns).map((t,index)=>[t.id,index]));
            current.claims.sort((a,b)=>(sourceOrder.get(a.sourceTurnId)??Infinity)-(sourceOrder.get(b.sourceTurnId)??Infinity));
            current.updatedAt=new Date().toISOString();
          });if(duplicate)return;
          send(ws,{type:'transcript',role:'user',text:userTurn.text,final:true,turn:userTurn});
          // Qwen owns VAD and response generation and already retains live audio history.
          // Reconfiguring instructions when its asynchronous ASR arrives can collide
          // with the response that is already being generated. Rebuild saved memory
          // on the next connection; keep this live conversation uninterrupted.
          if(refusal){
            clearTimeout(stopIdle);clearTimeout(stopDeadline);stopFinished=true;
            if(stopping)send(ws,{type:'stopped'});
            else send(ws,{type:'error',message:'已避开这个话题。请重新开启语音聊天，以清除语音模型中的旧上下文。'});
            if(ws.readyState===WebSocket.OPEN)ws.close(1000,'topic reset');
            if(provider.readyState===WebSocket.OPEN)provider.close();
          }
        });
      }
      stopActivity();
    } else if(event.type==='conversation.item.input_audio_transcription.failed'){
      void diagnostics.record('transcript_failed');
      if(event.item_id)pendingTranscriptions.delete(event.item_id);
      send(ws,{type:'error',message:'语音转写失败，请重试或改用文字输入'});stopActivity();
    } else if(event.type==='input_audio_buffer.committed'){
      transcriptOrder.observe(event.item_id);
      if(event.item_id)position(`user:${event.item_id}`);
      if(event.item_id&&!transcriptOrder.isComplete(event.item_id))pendingTranscriptions.add(event.item_id);
    } else if(event.type==='response.audio_transcript.delta'){
      if(suppressOutput||interruptedResponse)return;
      if(event.response_id&&cancelledResponses.has(event.response_id))return;
      assistantText=(assistantText+String(event.delta||'')).slice(0,4000);
      send(ws,{type:'transcript',role:'assistant',text:String(event.delta||''),responseId:event.response_id||activeResponseId,final:false});
    } else if(event.type==='response.audio_transcript.done'){
      if(suppressOutput||interruptedResponse)return;
      if(event.response_id&&cancelledResponses.has(event.response_id))return;
      assistantText=String(event.transcript||assistantText).trim();
    } else if(event.type==='response.created'){
      if(!startupFinished)openingPending=false;
      void diagnostics.record('response_started',{server:healthSnapshot()});
      interruptedResponse=false;assistantText='';activeResponsePosition=position(event.response?.id?`assistant:${event.response.id}`:Symbol());
      if(suppressOutput){if(provider.readyState===WebSocket.OPEN)provider.send(JSON.stringify({type:'response.cancel'}));return;}
      activeResponseId=event.response?.id||null;active=true;send(ws,{type:'response_started',responseId:activeResponseId});send(ws,{type:'state',state:'speaking'});
    } else if(event.type==='response.done'){
      void diagnostics.record('response_done',{server:{...healthSnapshot(),interrupted:interruptedResponse||event.response?.status==='cancelled'}});
      if(!meter.response(event))return;publishUsage(true);
      // A cancelled response can finish after the next response has begun.
      if(event.response?.id&&cancelledResponses.has(event.response.id)&&event.response.id!==activeResponseId)return;
      if(suppressOutput)return;
      active=false;
      if(event.response?.status==='cancelled'){
        // Qwen may cancel before speech_started arrives. Preserve the received
        // partial text here, unless that speech event already saved it.
        const responseId=event.response.id||activeResponseId;
        if(!interruptedResponse)saveAssistant(assistantText,responseId,activeResponsePosition??nextPosition++,true);
        if(responseId)cancelledResponses.add(responseId);
      }
      if(interruptedResponse||event.response?.status==='cancelled')assistantText='';
      if(assistantText){saveAssistant(assistantText,event.response?.id||activeResponseId,activeResponsePosition??nextPosition++);}
      send(ws,{type:'response_done',responseId:event.response?.id||activeResponseId,status:interruptedResponse?'cancelled':event.response?.status||'completed'});
      activeResponseId=null;assistantText='';openingPending=false;interruptedResponse=false;
      send(ws,{type:'state',state:'listening'});stopActivity();
    } else if(event.type==='input_audio_buffer.speech_started'){
      // If the user speaks during preparation, let Qwen answer that speech;
      // do not inject a second automatic greeting when readiness arrives.
      if(!startupFinished)openingPending=false;
      health.speechEvents++;void diagnostics.record('speech_started',{server:{...healthSnapshot(),audioStartMs:event.audio_start_ms},client:lastClientMetrics});
      transcriptOrder.observe(event.item_id);
      if(event.item_id)position(`user:${event.item_id}`);
      speechStart={at:Date.now(),offset:event.audio_start_ms};
      if(event.item_id)pendingTranscriptions.add(event.item_id);
      if(active&&!interruptedResponse){
        {
          saveAssistant(assistantText,activeResponseId,activeResponsePosition??nextPosition++,true);
          if(activeResponseId)cancelledResponses.add(activeResponseId);
        }
        interruptedResponse=true;assistantText='';
        // Qwen VAD owns response cancellation.
      }
      send(ws,{type:'speech_started',itemId:event.item_id});
    } else if(event.type==='input_audio_buffer.speech_stopped'){
      void diagnostics.record('speech_stopped',{server:{...healthSnapshot(),audioEndMs:event.audio_end_ms}});
      if(event.reason==='turn_invalid'){speechStart=null;if(event.item_id)pendingTranscriptions.delete(event.item_id);stopActivity();return;}
      if(speechStart){const duration=Number.isFinite(event.audio_end_ms)&&Number.isFinite(speechStart.offset)?event.audio_end_ms-speechStart.offset:Date.now()-speechStart.at;meter.state.userAudioSeconds+=Math.max(0,duration)/1000;meter.state.audioTurns++;speechStart=null;publishUsage();}
    } else if(event.type==='error'){
      void diagnostics.record('provider_error',{server:healthSnapshot()});
      if(event.error?.code==='response_cancel_not_active')return;
      send(ws,{type:'error',message:voiceProviderMessage(event.error?.message)});
    }
  });
  provider.on('error',error=>{void diagnostics.record('provider_error',{server:healthSnapshot()});send(ws,{type:'error',message:voiceConnectionError(error)});});
  provider.on('close',code=>{void diagnostics.record('provider_close',{server:{...healthSnapshot(),closeCode:code}});if(stopping){completeStop(true);return;}send(ws,{type:'state',state:'语音连接已关闭'});if(ws.readyState===WebSocket.OPEN)ws.close(1011,'provider closed');});
  ws.on('message',(data,isBinary)=>{
    if(isBinary)return; // Media is carried only by WebRTC.
    let msg;try{msg=JSON.parse(data.toString());}catch{return;}
    if(msg.type==='rtc_media_ready'){
      if(!configured||microphoneReady||stopping||msg.startupId!==diagnostics.id)return;
      microphoneReady=true;clearTimeout(microphoneDeadline);
      void diagnostics.record('microphone_ready',{client:msg.metrics});startConversation();return;
    }
    if(msg.type==='voice_probe'&&Number.isSafeInteger(msg.id)&&Date.now()-lastProbe>=500){
      lastProbe=Date.now();lastClientMetrics=msg.metrics;
      void diagnostics.record('sample',{client:lastClientMetrics,server:healthSnapshot()}).then(saved=>send(ws,{type:'diagnostic_status',saved}));
      send(ws,{type:'voice_probe_result',id:msg.id,stats:healthSnapshot()});return;
    }
    if(msg.type==='stop'&&!stopping){
      void diagnostics.record('client_stop',{client:msg.metrics,server:healthSnapshot()});
      stopping=true;clearTimeout(microphoneDeadline);send(ws,{type:'state',state:'正在保存最后一句…'});
      stopIdle=setTimeout(completeStop,3500);stopDeadline=setTimeout(()=>completeStop(true),8000);
    }
  });
  ws.on('close',code=>{void diagnostics.record('client_close',{server:{...healthSnapshot(),closeCode:code},client:lastClientMetrics});clearTimeout(stopIdle);clearTimeout(stopDeadline);clearInterval(usageTick);clearTimeout(readyDeadline);clearTimeout(microphoneDeadline);meter.state.endedAt=new Date().toISOString();publishUsage(true);});
  ws.sessionAttached=true;
  // A prepared peer has already emitted session.created. Configure current
  // book memory only now; no greeting or microphone existed during preparation.
  if(options.prepared){void diagnostics.record('provider_prepared');provider.send(JSON.stringify({type:'session.update',session:initialVoiceConfig(settings,instructions(book,session))}));}
}

export function attachVoiceUpgrade(httpServer,token){
  httpServer.on('upgrade',(req,socket,head)=>{
    const host=req.headers.host,allowed=new Set([`127.0.0.1:${httpServer.address().port}`,`localhost:${httpServer.address().port}`]),origin=`http://${host}`;
    const protocols=String(req.headers['sec-websocket-protocol']||'').split(',').map(x=>x.trim());
    if(req.url!=='/api/voice'||!allowed.has(host)||req.headers.origin!==origin||protocols[0]!=='lifebook'||protocols[1]!==token){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    server.handleUpgrade(req,socket,head,ws=>{
      send(ws,{type:'state',state:'准备语音连接'});
      let started=false;
      const earlyStop=data=>{let msg;try{msg=JSON.parse(data.toString());}catch{return;}if(msg.type==='stop'&&!ws.sessionAttached){ws.stopRequested=true;send(ws,{type:'stopped'});ws.close(1000,'stopped');}};
      ws.on('message',earlyStop);
      const start=async data=>{if(started)return;let msg;try{msg=JSON.parse(data.toString());}catch{return;}
        if(msg.type==='prepare'&&msg.transport==='webrtc'&&!ws.preparation){
          ws.preparation=prepareSession(ws,msg.offer);ws.preparation.catch(()=>{if(!started&&ws.readyState===WebSocket.OPEN)ws.close(1000,'preparation failed');});return;
        }
        if(msg.type!=='start')return;started=true;ws.off('message',start);
        try{const prepared=ws.preparation?await ws.preparation:null;prepared?.dispose();await attachSession(ws,msg.bookId,msg.sessionId,msg.resume===true,{transport:msg.transport,offer:msg.offer,prepared});ws.off('message',earlyStop);}catch(e){ws.off('message',earlyStop);if(ws.readyState===WebSocket.OPEN){send(ws,{type:'error',message:e.message});ws.close(1008,'configuration error');}}
      };
      ws.on('message',start);
      ws.on('close',()=>{if(ws.provider?.readyState===WebSocket.CONNECTING)ws.provider.terminate();else if(ws.provider?.readyState===WebSocket.OPEN)ws.provider.close();});
    });
  });
}
