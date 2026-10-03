import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {VoiceDiagnostics,readVoiceDiagnostics,diagnosticMetrics} from '../src/voice-diagnostics.js';

test('echo diagnostics retain only known modes and browser families without device or user-agent identifiers',()=>{
  const metrics={browserPlatform:'ios',browserFamily:'chrome',browserMajor:154,echoCancellationMode:'all',echoCancellationAllSupported:true,
    echoCancellationAllRequested:true,echoCancellationAllRejected:false,noiseSuppressionReported:true,noiseSuppressionEnabled:true,
    autoGainControlReported:true,autoGainControlEnabled:true,micSampleRate:48000,micChannelCount:1,
    rtcPlaybackContinuous:true,rtcPlaybackStarts:1,rtcOutputMuted:false,rtcOutputPaused:false,
    rtcStartupInputProtected:true,rtcStartupInputReleased:false,rtcStartupProtectionMs:2000,rtcStartupPlaybackWaitMs:527};
  assert.deepEqual(diagnosticMetrics({...metrics,userAgent:'private-user-agent',micLabel:'personal microphone',deviceId:'private-device'}),metrics);
  assert.deepEqual(diagnosticMetrics({browserFamily:'private text',echoCancellationMode:'private story'}),{});
});

test('diagnostics survive new recorder instances, serialize writes and exclude sensitive fields',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lifebook-voice-logs-'));
  try{
    const recorder=new VoiceDiagnostics({directory:root,model:'qwen-audio-3.0-realtime-flash'});
    await Promise.all(Array.from({length:20},(_,i)=>recorder.record('sample',{client:{sentBytes:i*3200,micRms:.1,apiKey:'secret',text:'private story',deviceId:'device',server:{token:'hidden'}},server:{receivedBytes:i*3200}})));
    const again=new VoiceDiagnostics({directory:root,model:'injected secret'});await again.record('client_close');
    const raw=await readVoiceDiagnostics(root),rows=raw.trim().split('\n').map(JSON.parse);
    assert.equal(rows.length,21);assert.equal(rows[19].sequence,20);assert.notEqual(rows[0].run,rows[20].run);
    assert.equal(rows[0].model,'qwen-audio-3.0-realtime-flash');
    assert.doesNotMatch(raw,/secret|private story|deviceId|hidden|token|apiKey/);
    assert.equal((await stat(join(root,'voice-diagnostics.jsonl'))).mode&0o777,0o600);
    assert.equal(await readVoiceDiagnostics(join(root,'different-account')),'');
    assert.equal(await recorder.record('arbitrary private text'),false);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('diagnostic rotation keeps at most two bounded files and returns chronological records',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lifebook-log-rotation-'));
  try{
    const recorder=new VoiceDiagnostics({directory:root,maxBytes:1024});
    for(let i=0;i<100;i++)await recorder.record('sample',{client:{sentBytes:i*3200}});
    const names=await readdir(root);assert.equal(names.length,2);
    for(const name of names)assert.ok((await stat(join(root,name))).size<=1024);
    const rows=(await readVoiceDiagnostics(root)).trim().split('\n').map(JSON.parse);
    assert.equal(rows.at(-1).sequence,100);assert.ok(rows.length<100);
    assert.ok(rows.every((r,i)=>i===0||r.sequence>rows[i-1].sequence));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('logging failures return a failure status without throwing into the voice path',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lifebook-log-failure-'));
  try{
    const normal=new VoiceDiagnostics({directory:root});assert.equal(await normal.record('session_start'),true);
    const invalid=new VoiceDiagnostics({directory:join(root,'voice-diagnostics.jsonl','child')});
    assert.equal(await invalid.record('sample'),false);
  }finally{await rm(root,{recursive:true,force:true});}
});
