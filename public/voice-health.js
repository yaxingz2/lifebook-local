export class VoiceHealth {
  constructor(sampleRate, now=()=>Date.now()) {
    this.now=now;this.started=now();
    this.data={version:'voice-health-1',sampleRate,capturedBytes:0,sentBytes:0,rejectedBytes:0,maxCaptureGapMs:0,maxBrowserQueueMs:0,micRms:0,maxMicRms:0,browserRttMs:null,maxBrowserRttMs:0,speechEvents:0,playbackClearCount:0,lastClearElapsedMs:0,lastSpeechEventElapsedMs:0,intervalMicPeak:0};
    this.probes=new Map();this.serial=0;this.samples=[];
  }
  probe() {
    const id=++this.serial;this.probes.set(id,this.now());
    for(const [key,at] of this.probes)if(this.now()-at>30000)this.probes.delete(key);
    const metrics={...this.data,elapsedMs:this.now()-this.started,pendingProbes:this.probes.size};delete metrics.server;this.data.intervalMicPeak=0;return {type:'voice_probe',id,metrics};
  }
  acknowledge(message) {
    const at=this.probes.get(message.id);if(at===undefined)return;
    this.probes.delete(message.id);const rtt=Math.max(0,this.now()-at);
    this.data.browserRttMs=rtt;this.data.maxBrowserRttMs=Math.max(this.data.maxBrowserRttMs,rtt);
    // Only numerical diagnostics are retained; no audio, transcript, key or account ID.
    const keys=['speechEvents'];
    this.data.server=Object.fromEntries(keys.filter(k=>Number.isFinite(message.stats?.[k])).map(k=>[k,message.stats[k]]));
    this.samples.push({elapsedMs:this.now()-this.started,rttMs:rtt,browserSentBytes:this.data.sentBytes,micRms:this.data.micRms,captureGapMaxMs:this.data.maxCaptureGapMs,...this.data.server});
    if(this.samples.length>120)this.samples.shift();
  }
  snapshot() {return {...this.data,elapsedMs:this.now()-this.started,pendingProbes:this.probes.size,samples:[...this.samples]};}
}
