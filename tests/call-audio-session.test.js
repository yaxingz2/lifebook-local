import test from 'node:test';
import assert from 'node:assert/strict';
import {beginCallAudioSession} from '../public/webrtc-voice.js';

test('optional call audio routing is restored exactly once after overlapping captures end',()=>{
  const writes=[];let type='auto';
  const audioSession={get type(){return type;},set type(value){writes.push(value);type=value;}};
  const first=beginCallAudioSession({audioSession}),second=beginCallAudioSession({audioSession});
  assert.equal(type,'play-and-record');assert.deepEqual(writes,['play-and-record']);
  first();first();assert.equal(type,'play-and-record','old permission request must not reset a newer call');
  second();second();assert.equal(type,'auto');assert.deepEqual(writes,['play-and-record','auto']);
});

test('unsupported or unavailable audio session routing never prevents a call',()=>{
  for(const browser of [{},{get audioSession(){throw Error('unavailable');}},{audioSession:{get type(){return 'auto';},set type(_){throw Error('unsupported');}}}]){
    assert.doesNotThrow(()=>{const release=beginCallAudioSession(browser);release();release();});
  }
});

test('cleanup respects another owner changing audio routing during a call',()=>{
  const audioSession={type:'auto'},release=beginCallAudioSession({audioSession});
  audioSession.type='ambient';release();assert.equal(audioSession.type,'ambient');
});

test('cleanup tolerates the browser revoking audio session access',()=>{
  let revoked=false,type='auto';
  const audioSession={get type(){if(revoked)throw Error('revoked');return type;},set type(value){type=value;}};
  const release=beginCallAudioSession({audioSession});revoked=true;assert.doesNotThrow(release);
});

test('iOS call routing is selected after capture rather than during permission or preconnection',()=>{
  for(const platform of [{userAgent:'Mozilla/5.0 (iPhone) CriOS/154.0'},{userAgent:'Mozilla/5.0 (Macintosh)',platform:'MacIntel',maxTouchPoints:5}]){
    const writes=[];let type='auto';
    const audioSession={get type(){return type;},set type(value){writes.push(value);type=value;}};
    const release=beginCallAudioSession({...platform,audioSession});
    assert.equal(release.deferPlayback,true);assert.deepEqual(writes,[]);
    release.activate();release.activate();assert.deepEqual(writes,['play-and-record']);
    release();assert.deepEqual(writes,['play-and-record','auto']);
    release.activate();assert.equal(type,'auto','a cancelled capture cannot reactivate the route');
  }
});

test('cancelled iOS permission requests never change a newer capture route',()=>{
  const writes=[];let type='auto';
  const audioSession={get type(){return type;},set type(value){writes.push(value);type=value;}};
  const browser={userAgent:'iPhone',audioSession};
  const old=beginCallAudioSession(browser);old();
  assert.deepEqual(writes,[],'cancelling permission did not activate or reset a route');
  const pending=beginCallAudioSession(browser),active=beginCallAudioSession(browser);
  active.activate();old.activate();pending();assert.equal(type,'play-and-record');
  active();assert.equal(type,'auto');assert.deepEqual(writes,['play-and-record','auto']);
});

test('iOS playback deferral also works without the optional audio session API',()=>{
  const release=beginCallAudioSession({userAgent:'iPhone'});
  assert.equal(release.deferPlayback,true);assert.doesNotThrow(()=>{release.activate();release();});
});
