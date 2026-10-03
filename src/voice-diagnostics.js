import {appendFile,readFile,mkdir,rename,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {dataRoot,serial} from './storage.js';
import {voiceModels} from './models.js';

const numeric=['rtcRttMs','rtcJitterMs','rtcPacketsLost','rtcReceivedBytes','rtcSentBytes','flushedBytes','maxSendCallbackMs','browserQueueHighForMs','providerQueueHighForMs','sampleRate','capturedBytes','sentBytes','rejectedBytes','maxCaptureGapMs','maxBrowserQueueMs','micRms','maxMicRms','intervalMicPeak','browserRttMs','maxBrowserRttMs','speechEvents','playbackClearCount','lastClearElapsedMs','lastSpeechEventElapsedMs','playbackQueuedMs','captureClockMs','elapsedMs','pendingProbes','receivedBytes','forwardedBytes','providerQueueMs','maxProviderQueueMs','providerRttMs','maxProviderRttMs','audioStartMs','audioEndMs','transcriptChars','closeCode','family','connectMs'];
numeric.push('rtcStartupMs','rtcUplinkPacketsLost','rtcOutputRms','rtcPlayoutBufferMs','rtcConcealedSamples','rtcEventsReceived','rtcEventAgeMs','rtcPlaybackStarts');
numeric.push('browserMajor','micChannelCount','micSampleRate');
numeric.push('rtcStartupProtectionMs','rtcStartupPlaybackWaitMs');
const flags=['rtcMicReady','echoCancellationReported','echoCancellationEnabled','rtcTransport','rtcMicMeasured','rtcControlOpen','trackEnabled','captureSuspended','trackMuted','trackEnded','playing','interrupted'];
flags.push('rtcPrepared');
flags.push('rtcStartupInputProtected','rtcStartupInputReleased');
flags.push('echoCancellationAllSupported','echoCancellationAllRequested','echoCancellationAllRejected','noiseSuppressionReported','noiseSuppressionEnabled','autoGainControlReported','autoGainControlEnabled','rtcPlaybackContinuous','rtcOutputMuted','rtcOutputPaused');
const enums={browserPlatform:new Set(['desktop','ios','android']),browserFamily:new Set(['chrome','edge','other']),echoCancellationMode:new Set(['all','remote-only','browser-default','disabled','unreported'])};
const events=new Set(['preparation_start','preparation_ready','session_start','tls_start','tls_retry','tls_ready','tls_failed','provider_open','provider_prepared','provider_ready','microphone_ready','microphone_timeout','sample','speech_started','speech_stopped','transcript_complete','transcript_failed','response_started','response_done','upload_overloaded','provider_error','provider_close','client_stop','client_close']);
const filename='voice-diagnostics.jsonl';
// Client measurements are untrusted. Never persist arbitrary objects, text or errors.
export function diagnosticMetrics(value={}) {
  const out={};if(!value||typeof value!=='object')return out;
  for(const key of numeric)if(Number.isFinite(value[key])&&value[key]>=0&&value[key]<=1e12)out[key]=value[key];
  for(const key of flags)if(typeof value[key]==='boolean')out[key]=value[key];
  for(const [key,allowed] of Object.entries(enums))if(allowed.has(value[key]))out[key]=value[key];
  return out;
}
export class VoiceDiagnostics {
  constructor({directory=dataRoot,maxBytes=2*1024*1024,model,now=()=>Date.now()}={}) {
    this.model=Object.hasOwn(voiceModels,model)?model:undefined;this.directory=directory;this.maxBytes=maxBytes;this.now=now;this.started=now();this.id=randomUUID();this.sequence=0;
  }
  record(event,{client,server}={}) {
    if(!events.has(event))return Promise.resolve(false);
    const line=JSON.stringify({version:1,model:this.model,run:this.id,sequence:++this.sequence,at:new Date(this.now()).toISOString(),elapsedMs:Math.max(0,this.now()-this.started),event,client:diagnosticMetrics(client),server:diagnosticMetrics(server)})+'\n';
    const path=join(this.directory,filename);
    return serial('voice-diagnostics:'+path,async()=>{
      await mkdir(this.directory,{recursive:true,mode:0o700});
      let size=0;try{size=(await stat(path)).size;}catch(e){if(e.code!=='ENOENT')throw e;}
      if(size+Buffer.byteLength(line)>this.maxBytes&&size)await rename(path,path+'.1');
      await appendFile(path,line,{mode:0o600});return true;
    }).catch(()=>false); // Logging must not break a voice conversation.
  }
}
export function readVoiceDiagnostics(directory=dataRoot) {
  const path=join(directory,filename);
  return serial('voice-diagnostics:'+path,async()=>{
    const chunks=[];for(const file of [path+'.1',path]){
      try{chunks.push(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    return chunks.join('');
  });
}
