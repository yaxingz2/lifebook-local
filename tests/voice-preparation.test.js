import test from 'node:test';
import assert from 'node:assert/strict';
import {VoicePreparation} from '../public/webrtc-voice.js';
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(t){
  const previous=globalThis.WebSocket;globalThis.WebSocket={OPEN:1};
  t.mock.timers.enable({apis:['setTimeout']});
  class Socket extends EventTarget {
    readyState=0;sent=[];
    send(raw){this.sent.push(JSON.parse(raw));}
    open(){this.readyState=1;this.dispatchEvent(new Event('open'));}
    message(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}
    close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}
  }
  class Rtc {
    constructor(options){Object.assign(this,options);this.pc={connectionState:'connected'};this.output={};this.playCount=0;this.closeCount=0;assert.deepEqual(this.stream.getAudioTracks(),[]);}
    offer(){return Promise.resolve('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n');}
    answer(sdp){this.sdp=sdp;return Promise.resolve();}
    command(event){this.lastCommand=event;}
    play(){this.playCount++;}
    close(){this.closeCount++;}
  }
  let expired=0;
  const warm=new VoicePreparation({url:'wss://example.test/api/voice',token:'test-token',Socket,Rtc,onExpired:()=>expired++});
  t.after(()=>{warm.close();globalThis.WebSocket=previous;t.mock.timers.reset();});
  return {warm,expired:()=>expired,advance:async ms=>{t.mock.timers.tick(ms);await tick();},ready:async()=>{warm.socket.open();await tick();warm.socket.message({type:'prepared'});await warm.ready;}};
}
test('background preparation sends only a trackless offer and never plays audio',async t=>{
  const f=fixture(t);assert.equal(f.warm.rtc.playCount,0);await f.ready();
  assert.deepEqual(f.warm.socket.sent.map(e=>e.type),['prepare']);
  assert.equal(f.warm.socket.sent[0].bookId,undefined);assert.equal(f.warm.socket.sent[0].sessionId,undefined);
  assert.equal(f.warm.rtc.playCount,0);assert.equal(f.warm.rtc.prepareOnly,true);
});
test('explicit activation transfers the same peer and socket without closing them',async t=>{
  const f=fixture(t);await f.ready();assert.equal(f.warm.claim(),true);f.warm.unlock();
  assert.equal(f.warm.rtc.playCount,1);
  const taken=f.warm.take();assert.equal(taken.rtc,f.warm.rtc);assert.equal(taken.socket,f.warm.socket);
  f.warm.close();await f.advance(70000);assert.equal(taken.rtc.closeCount,0);assert.equal(taken.socket.readyState,1);assert.equal(f.expired(),0);
  taken.socket.message({type:'rtc_close'});assert.equal(taken.rtc.closeCount,0,'old preparation handler was removed');
});
test('background timeout releases an unused peer and socket',async t=>{
  const f=fixture(t);await f.ready();await f.advance(60000);
  assert.equal(f.warm.closed,true);assert.equal(f.warm.rtc.closeCount,1);assert.equal(f.warm.socket.readyState,3);assert.equal(f.expired(),1);assert.equal(f.warm.take(),null);
});
test('cancel during connection rejects readiness and cannot transfer a stale peer',async t=>{
  const f=fixture(t);const rejected=assert.rejects(f.warm.ready,/过期/);f.warm.close();await rejected;await tick();
  assert.equal(f.warm.take(),null);assert.equal(f.warm.claim(),false);assert.equal(f.warm.rtc.closeCount,1);assert.equal(f.expired(),1);
});
test('a preparation error is optional and frees resources for cold-start fallback',async t=>{
  const f=fixture(t);f.warm.socket.open();await tick();f.warm.socket.message({type:'error'});
  await assert.rejects(f.warm.ready,/过期/);assert.equal(f.warm.closed,true);assert.equal(f.warm.rtc.closeCount,1);assert.equal(f.warm.take(),null);
});
