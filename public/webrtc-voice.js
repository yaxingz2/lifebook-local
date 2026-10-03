const callAudioSessions=new WeakMap();
// Boolean true leaves the cancellation scope to the browser. Prefer system
// playout cancellation on the same microphone when its capabilities advertise
// it. Do this before connecting capture to RTP.
export async function configureMicrophoneEcho(track,browser=globalThis.navigator,{allRequested=false}={}){
  const initialSettings=track.getSettings();
  let capabilities;
  try{capabilities=track.getCapabilities?.();}catch{}
  const allSupported=Array.isArray(capabilities?.echoCancellation)&&capabilities.echoCancellation.includes('all');
  let allRejected=false;
  if(allSupported&&initialSettings.echoCancellation!=='all'&&track.applyConstraints&&track.readyState!=='ended'){
    allRequested=true;
    try{
      await track.applyConstraints({...track.getConstraints?.(),echoCancellation:{exact:'all'}});
    }catch{
      // Reconfiguration may be unavailable despite advertised capabilities.
      // A rejected constraint leaves the existing capture settings intact.
      allRejected=true;
    }
  }
  const settings=track.getSettings(),echo=settings.echoCancellation;
  const mode=echo==='all'||echo==='remote-only'?echo:echo===true?'browser-default':echo===false?'disabled':'unreported';
  const ua=browser?.userAgent||'',edge=ua.match(/Edg(?:e|A|iOS)?\/(\d+)/),chrome=ua.match(/(?:Chrome|CriOS)\/(\d+)/);
  const browserFamily=edge?'edge':chrome?'chrome':'other';
  const metrics={
    browserPlatform:/iPhone|iPad|iPod/.test(ua)||browser?.platform==='MacIntel'&&browser?.maxTouchPoints>1?'ios':/Android/.test(ua)?'android':'desktop',
    browserFamily,browserMajor:Number((edge||chrome)?.[1]||0),
    echoCancellationMode:mode,echoCancellationReported:mode!=='unreported',
    echoCancellationEnabled:['all','remote-only','browser-default'].includes(mode),
    echoCancellationAllSupported:allSupported,echoCancellationAllRequested:allRequested,echoCancellationAllRejected:allRejected,
    noiseSuppressionReported:typeof settings.noiseSuppression==='boolean',noiseSuppressionEnabled:settings.noiseSuppression===true,
    autoGainControlReported:typeof settings.autoGainControl==='boolean',autoGainControlEnabled:settings.autoGainControl===true,
  };
  if(Number.isFinite(settings.channelCount))metrics.micChannelCount=settings.channelCount;
  if(Number.isFinite(settings.sampleRate))metrics.micSampleRate=settings.sampleRate;
  return metrics;
}

// This is an optional browser routing hint, not a guarantee of echo removal.
// Keep it until capture has stopped; an older cancelled permission request may
// still finish while a newer call is starting.
export function beginCallAudioSession(browser=globalThis.navigator){
  const ua=browser?.userAgent||'';
  const deferPlayback=/iPhone|iPad|iPod/.test(ua)||browser?.platform==='MacIntel'&&browser?.maxTouchPoints>1;
  const unavailable=()=>{};unavailable.activate=()=>{};unavailable.deferPlayback=deferPlayback;
  let session,entry;
  try{
    session=browser?.audioSession;if(!session)return unavailable;
    entry=callAudioSessions.get(session);
    if(!entry){
      entry={previous:session.type,users:0,activated:false};callAudioSessions.set(session,entry);
    }
    entry.users++;
  }catch{return unavailable;}
  let released=false;
  const release=()=>{
    if(released)return;released=true;
    if(--entry.users)return;
    callAudioSessions.delete(session);
    try{if(entry.activated&&session.type==='play-and-record')session.type=entry.previous;}catch{}
  };
  release.deferPlayback=deferPlayback;
  release.activate=()=>{
    if(released||entry.activated||callAudioSessions.get(session)!==entry)return;
    try{session.type='play-and-record';entry.activated=true;}catch{}
  };
  // On iOS, establish capture before selecting the duplex route and starting
  // the native remote player. A trackless preconnection must not start a
  // playback-only route that then changes when getUserMedia completes.
  if(!deferPlayback)release.activate();
  return release;
}

export class WebRtcVoice {
  constructor({stream,socket,isCurrent,onError,health,onEvent,onStartupProtection,prepareOnly=false}) {
    Object.assign(this,{stream,socket,isCurrent,onError,health,onEvent,onStartupProtection});this.closed=false;this.mutedInput=false;this.pending=[];this.seen=new Set();this.channels=new Set();this.lastEventAt=null;
    this.prepareOnly=prepareOnly;
    Object.assign(this.health.data,{rtcPlaybackContinuous:true,rtcPlaybackStarts:0});
    this.output=new Audio();this.output.autoplay=!prepareOnly;this.output.muted=false;this.output.setAttribute('playsinline','');
    this.output.hidden=true;document.body.append(this.output);
    this.pc=new RTCPeerConnection({iceServers:[]});
    // An enabled=false track still sends zeroes. Start with no track at all.
    this.sender=this.pc.addTransceiver('audio',{direction:'sendrecv'}).sender;
    this.pc.ontrack=e=>{if(this.closed)return;this.output.srcObject=e.streams[0]||new MediaStream([e.track]);if(!this.prepareOnly)this.play();};
    this.pc.ondatachannel=e=>this.attach(e.channel);this.attach(this.pc.createDataChannel('oai-events'));
    this.pc.onconnectionstatechange=()=>{
      if(this.closed||!this.isCurrent())return;
      clearTimeout(this.disconnectedTimer);
      if(this.pc.connectionState==='failed')this.onError('WebRTC 连接中断，请重新开始。');
      if(this.pc.connectionState==='disconnected')this.disconnectedTimer=setTimeout(()=>{if(!this.closed&&this.isCurrent())this.onError('WebRTC 网络连接中断，请重试。');},8000);
    };
  }
  activate(options){Object.assign(this,options);this.prepareOnly=false;this.output.autoplay=true;if(!this.playbackRequested)this.play();}
  play(){if(!this.closed){this.health.data.rtcPlaybackStarts++;this.playbackRequested=true;const playback=this.output.play();this.playbackPromise=playback;playback.then(()=>{if(!this.closed&&this.playbackPromise===playback)this.playbackStarted=true;},()=>{if(this.isCurrent()&&!this.closed&&this.playbackPromise===playback)this.onError('浏览器未能播放语音，请允许本站播放声音后重试。');});}}
  attach(dc){
    this.channels.add(dc);
    dc.onopen=()=>this.flush();
    dc.onclose=()=>{if(!this.closed&&!this.mutedInput&&this.isCurrent()&&dc===this.channel)this.onError('语音控制连接已断开，请停止后重新开始。');};
    dc.onerror=()=>{if(!this.closed&&!this.mutedInput&&this.isCurrent()&&dc===this.channel)this.onError('语音控制连接出错，请停止后重新开始。');};
    dc.onmessage=raw=>{
      if(this.closed||!this.isCurrent())return;
      let e;try{e=JSON.parse(raw.data);}catch{return;}
      this.lastEventAt=Date.now();this.health.data.rtcEventsReceived=(this.health.data.rtcEventsReceived||0)+1;
      if(e.event_id){if(this.seen.has(e.event_id))return;this.seen.add(e.event_id);if(this.seen.size>2000)this.seen.delete(this.seen.values().next().value);}
      if(e.type==='session.created'){if(this.channel)return;this.channel=dc;this.flush();}
      // Qwen's VAD cancels its RTP response. Keep the native renderer running:
      // WebKit stops it on element.muted and clears its source on restart. A
      // per-turn mute/unmute therefore disrupts the playout reference for AEC.
      // Only an explicit end of the call mutes output; capture stays full duplex.
      if(/^(response\.(created|done|(output_)?audio_transcript\.(delta|done))|input_audio_buffer\.(speech_started|committed)|conversation\.item\.input_audio_transcription\.completed)$/.test(e.type))this.onEvent?.(e);
      // RTP carries the audio. Sending PCM or audio deltas over the control socket
      // would recreate the server bottleneck this transport is meant to remove.
      if(/^(session\.(created|updated)|error|response\.(created|done|audio_transcript\.(delta|done)|output_audio_transcript\.(delta|done))|input_audio_buffer\.(speech_started|speech_stopped|committed)|conversation\.item\.input_audio_transcription\.(completed|failed))$/.test(e.type)&&this.socket.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify({type:'rtc_event',event:e}));
    };
  }
  flush(){if(this.channel?.readyState!=='open')return;for(const e of this.pending.splice(0))this.channel.send(JSON.stringify(e));}
  command(e){if(this.closed)return;if(this.channel?.readyState==='open')this.channel.send(JSON.stringify(e));else if(this.pending.length<20)this.pending.push(e);}
  async offer(){
    await this.pc.setLocalDescription(await this.pc.createOffer());
    if(this.closed||!this.isCurrent())throw Error('连接已取消');
    if(this.pc.iceGatheringState!=='complete')await new Promise((resolve,reject)=>{
      const finish=error=>{clearTimeout(timer);this.pc.removeEventListener('icegatheringstatechange',change);this.cancelOffer=null;error?reject(error):resolve();};
      const change=()=>{if(this.pc.iceGatheringState==='complete')finish();};
      const timer=setTimeout(()=>finish(Error('WebRTC 网络准备超时，请重试')),10000);
      this.cancelOffer=()=>finish(Error('连接已取消'));this.pc.addEventListener('icegatheringstatechange',change);
    });
    if(this.closed||!this.isCurrent())throw Error('连接已取消');return this.pc.localDescription.sdp;
  }
  async answer(sdp){if(!this.closed&&this.isCurrent())await this.pc.setRemoteDescription({type:'answer',sdp:String(sdp).trim().replace(/\r?\n/g,'\r\n')+'\r\n'});}
  startupTrack(track){
    if(this.health.data.browserPlatform!=='ios'||!track.clone)return track;
    // Explicitly requested startup-only input protection. Keep the original
    // capture live so native AEC can adapt; send zeroes through a disabled clone
    // until the first audible reply has played for two seconds. This runs once
    // per call and never gates later replies or human interruptions.
    const silent=track.clone();silent.enabled=false;this.startupSilentTrack=silent;
    Object.assign(this.health.data,{rtcStartupInputProtected:true,rtcStartupInputReleased:false,rtcStartupProtectionMs:2000});
    this.onStartupProtection?.('waiting');return silent;
  }
  watchStartupPlayback(track){
    if(!this.startupSilentTrack)return;
    const started=Date.now();
    const current=()=>!this.closed&&!this.mutedInput&&this.isCurrent();
    const fail=message=>{this.cancelStartupProtection();if(current())this.onError(message);};
    this.startupDeadline=setTimeout(()=>fail('开场语音尚未播放，请停止后重试。'),20000);
    const sample=async()=>{
      if(!current()){this.cancelStartupProtection();return;}
      const report=await this.pc.getStats();if(!current())return;
      let audible=false,energy=0,levelReported=false;
      for(const row of report.values())if(row.type==='inbound-rtp'&&(row.kind==='audio'||row.mediaType==='audio')){
        if(Number.isFinite(row.audioLevel)){levelReported=true;if(row.audioLevel>=.001)audible=true;}
        if(Number.isFinite(row.totalAudioEnergy))energy+=row.totalAudioEnergy;
      }
      if(!levelReported&&this.startupPreviousEnergy!==undefined&&energy-this.startupPreviousEnergy>1e-8)audible=true;
      this.startupPreviousEnergy=energy;
      if(this.playbackStarted&&this.output.paused!==true&&audible){
        clearTimeout(this.startupDeadline);this.startupDeadline=null;
        this.health.data.rtcStartupPlaybackWaitMs=Date.now()-started;this.onStartupProtection?.('settling');
        this.startupReleaseTimer=setTimeout(async()=>{
          if(!current()){this.cancelStartupProtection();return;}
          try{
            if(track.readyState==='ended')throw Error('麦克风已断开，请重新开始。');
            await this.sender.replaceTrack(track);
            if(!current()){this.cancelStartupProtection();return;}
            this.startupSilentTrack?.stop();this.startupSilentTrack=null;
            this.health.data.rtcStartupInputReleased=true;this.onStartupProtection?.('open');
          }catch(error){if(current())fail(error.message||'麦克风未能恢复，请重新开始。');}
        },2000);
        return;
      }
      this.startupPollTimer=setTimeout(()=>sample().catch(()=>fail('无法确认开场声音播放，请停止后重试。')),100);
    };
    sample().catch(()=>fail('无法确认开场声音播放，请停止后重试。'));
  }
  cancelStartupProtection(){
    clearTimeout(this.startupDeadline);clearTimeout(this.startupReleaseTimer);clearTimeout(this.startupPollTimer);
    this.startupSilentTrack?.stop();this.startupSilentTrack=null;
  }
  ready(){
    if(this.closed||this.mutedInput||!this.isCurrent())return Promise.resolve(false);
    if(this.readyPromise)return this.readyPromise;
    const started=Date.now(),track=this.stream.getAudioTracks()[0];
    // RTP progress alone can precede native playout and the iOS audio-route
    // transition. Keep capture live while allowing a short, uninterrupted setup
    // interval before requesting the greeting. This is a startup precaution,
    // not a measurement or guarantee of acoustic echo cancellation.
    const settleMs=this.health.data.browserPlatform==='ios'?700:0;
    this.readyPromise=new Promise((resolve,reject)=>{
      let finished=false,pollTimer,previousSent,stableSince,progress=false;
      const finish=(error,ready=false)=>{
        if(finished)return;finished=true;clearTimeout(deadline);clearTimeout(pollTimer);this.cancelReady=null;
        if(ready)Object.assign(this.health.data,{rtcMicReady:true,rtcStartupMs:Date.now()-started});
        error?reject(error):resolve(ready);
      };
      const deadline=setTimeout(()=>finish(Error('麦克风音频尚未准备好，请刷新网页后重新开始。')),8000);
      this.cancelReady=()=>finish(null,false);
      const sample=async()=>{
        if(finished)return;
        if(this.closed||this.mutedInput||!this.isCurrent())return finish(null,false);
        if(!track||track.readyState==='ended')return finish(Error('麦克风已断开，请重新开始。'));
        const report=await this.pc.getStats();if(finished)return;
        if(this.closed||this.mutedInput||!this.isCurrent())return finish(null,false);
        let sent=0;
        for(const row of report.values())if(row.type==='outbound-rtp'&&(row.kind==='audio'||row.mediaType==='audio'))sent+=row.bytesSent||0;
        // A silent provider may not deliver its first audio frame until the
        // greeting is requested. Do not await play() resolving and deadlock it.
        const healthy=track.readyState==='live'&&track.enabled&&!track.muted&&this.pc.connectionState==='connected'&&this.channel?.readyState==='open'&&!!this.output.srcObject&&this.playbackRequested&&this.output.paused!==true;
        if(!healthy){stableSince=undefined;progress=false;}
        else {
          stableSince??=Date.now();
          if(previousSent!==undefined&&sent>previousSent)progress=true;
          if(progress&&Date.now()-stableSince>=settleMs)return finish(null,true);
        }
        previousSent=healthy?sent:undefined;
        pollTimer=setTimeout(()=>sample().catch(finish),100);
      };
      (async()=>{await this.sender.replaceTrack(this.startupTrack(track));if(finished)return;if(this.closed||this.mutedInput||!this.isCurrent())return finish(null,false);this.watchStartupPlayback(track);await sample();})().catch(finish);
    });
    return this.readyPromise;
  }
  muteInput(){
    if(this.closed)return;this.mutedInput=true;this.output.muted=true;
    this.cancelStartupProtection();
    this.cancelReady?.();
    for(const t of this.stream.getAudioTracks())t.enabled=false;
    // Let native RTP silence finish the last VAD turn before releasing capture.
    this.inputStopTimer=setTimeout(()=>this.stream.getTracks().forEach(t=>t.stop()),1600);
  }
  async stats(){
    if(this.closed)return;const result=await this.pc.getStats();let rtt,jitter,uplinkLost,outputRms,lost=0,received=0,sent=0,inputRms,playoutMs,concealed=0;
    for(const s of result.values()){
      if(s.type==='candidate-pair'&&s.state==='succeeded'&&Number.isFinite(s.currentRoundTripTime))rtt=Math.round(s.currentRoundTripTime*1000);
      if(s.type==='inbound-rtp'&&(s.kind==='audio'||s.mediaType==='audio')){received+=s.bytesReceived||0;lost+=Math.max(0,s.packetsLost||0);concealed+=s.concealedSamples||0;if(Number.isFinite(s.jitter))jitter=Math.round(s.jitter*1000);if(Number.isFinite(s.audioLevel))outputRms=s.audioLevel;if(s.jitterBufferEmittedCount>0&&Number.isFinite(s.jitterBufferDelay))playoutMs=Math.round(s.jitterBufferDelay/s.jitterBufferEmittedCount*1000);}
      if(s.type==='outbound-rtp'&&(s.kind==='audio'||s.mediaType==='audio'))sent+=s.bytesSent||0;
      if(s.type==='remote-inbound-rtp'&&(s.kind==='audio'||s.mediaType==='audio')&&Number.isFinite(s.packetsLost))uplinkLost=Math.max(0,s.packetsLost);
      if(s.type==='media-source'&&s.kind==='audio'){
        if(Number.isFinite(s.audioLevel))inputRms=s.audioLevel;
        if(Number.isFinite(s.totalAudioEnergy)&&Number.isFinite(s.totalSamplesDuration)){
          const previous=this.inputEnergy;
          if(previous?.id===s.id&&s.totalSamplesDuration>previous.duration&&s.totalAudioEnergy>=previous.energy)inputRms=Math.sqrt((s.totalAudioEnergy-previous.energy)/(s.totalSamplesDuration-previous.duration));
          this.inputEnergy={id:s.id,energy:s.totalAudioEnergy,duration:s.totalSamplesDuration};
        }
      }
    }
    const track=this.stream.getAudioTracks()[0];
    Object.assign(this.health.data,{transport:'webrtc',rtcRttMs:rtt??null,rtcJitterMs:jitter??null,rtcPacketsLost:lost,rtcUplinkPacketsLost:uplinkLost??null,rtcReceivedBytes:received,rtcSentBytes:sent,rtcMicMeasured:Number.isFinite(inputRms),rtcOutputRms:outputRms??null,rtcPlayoutBufferMs:playoutMs??null,rtcConcealedSamples:concealed,rtcEventAgeMs:this.lastEventAt===null?null:Date.now()-this.lastEventAt,rtcControlOpen:this.channel?.readyState==='open',rtcOutputMuted:this.output.muted,rtcOutputPaused:!!this.output.paused,trackMuted:!!track?.muted,trackEnded:track?.readyState==='ended',trackEnabled:!!track?.enabled});
    if(Number.isFinite(inputRms)){this.health.data.micRms=Number(inputRms.toFixed(5));this.health.data.maxMicRms=Math.max(this.health.data.maxMicRms||0,this.health.data.micRms);}
  }
  close(){
    if(this.closed)return;this.closed=true;clearTimeout(this.disconnectedTimer);clearTimeout(this.inputStopTimer);this.cancelOffer?.();this.cancelReady?.();
    this.cancelStartupProtection();
    this.stream.getTracks().forEach(t=>t.stop());this.pc.close();this.output.srcObject=null;this.output.remove();this.pending=[];
  }
}

// Prepare a trackless peer and its authenticated signalling connection. No
// capture permission, microphone track, playback or response is started here.
// The same peer is handed to the explicit Start action, preserving negotiation.
export class VoicePreparation {
  constructor({url,token,onExpired=()=>{},Socket=WebSocket,Rtc=WebRtcVoice}){
    this.closed=false;this.claimed=false;this.onExpired=onExpired;
    this.socket=new Socket(url,['lifebook',token]);this.socket.binaryType='arraybuffer';
    this.health={data:{}};
    this.rtc=new Rtc({stream:{getAudioTracks:()=>[],getTracks:()=>[]},socket:this.socket,health:this.health,prepareOnly:true,isCurrent:()=>!this.closed,onError:()=>this.close()});
    this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
    // Background preparation failure is optional; activation falls back to a
    // fresh connection. Attach a rejection handler before any asynchronous work.
    this.ready.catch(()=>{});
    this.message=async event=>{
      if(this.closed)return;let msg;try{msg=JSON.parse(event.data);}catch{return;}
      try{
        if(msg.type==='rtc_answer')await this.rtc.answer(msg.sdp);
        else if(msg.type==='rtc_command')this.rtc.command(msg.event);
        else if(msg.type==='prepared'){this.prepared=true;clearTimeout(this.timer);this.timer=setTimeout(()=>this.close(),60000);this.resolveReady(this);}
        else if(['error','rtc_close'].includes(msg.type))this.close();
      }catch{this.close();}
    };
    this.failed=()=>this.close();this.socket.addEventListener('message',this.message);this.socket.addEventListener('error',this.failed);this.socket.addEventListener('close',this.failed);
    this.timer=setTimeout(()=>this.close(),20000);
    const opened=new Promise((resolve,reject)=>{
      this.opened=resolve;this.openFailed=reject;
      this.socket.addEventListener('open',this.opened,{once:true});
      this.socket.addEventListener('close',this.openFailed,{once:true});
      this.socket.addEventListener('error',this.openFailed,{once:true});
    });
    Promise.all([opened,this.rtc.offer()]).then(([,offer])=>{if(!this.closed)this.socket.send(JSON.stringify({type:'prepare',transport:'webrtc',offer}));}).catch(()=>this.close());
  }
  claim(){if(this.closed)return false;this.claimed=true;clearTimeout(this.timer);this.timer=setTimeout(()=>this.close(),20000);return true;}
  unlock(){if(!this.closed){this.rtc.prepareOnly=false;this.rtc.output.autoplay=true;this.rtc.play();}}
  detach(){clearTimeout(this.timer);this.socket.removeEventListener('message',this.message);this.socket.removeEventListener('error',this.failed);this.socket.removeEventListener('close',this.failed);this.socket.removeEventListener('open',this.opened);this.socket.removeEventListener('close',this.openFailed);this.socket.removeEventListener('error',this.openFailed);}
  take(){if(this.closed||!this.prepared||this.socket.readyState!==WebSocket.OPEN||this.rtc.pc.connectionState!=='connected')return null;this.detach();this.closed=true;return {rtc:this.rtc,socket:this.socket};}
  close(){if(this.closed)return;this.closed=true;this.detach();this.rejectReady(Error('语音预连接已过期'));this.rtc.close();try{this.socket.close();}catch{}this.onExpired(this);}
}
