import test from 'node:test';
import assert from 'node:assert/strict';
import {voiceConnectionError,voiceProviderMessage} from '../src/voice-connection.js';
test('Qwen idle timeout explains how to resume and other failures keep their cause',()=>{
 assert.match(voiceProviderMessage('Your session was closed because no response was generated for 180 seconds.'),/已暂停.*开始语音聊天/);
 assert.equal(voiceProviderMessage('Quota exceeded'),'Quota exceeded');
});

test('authentication and throttling errors stay distinct',()=>{assert.match(voiceConnectionError(Error('Unexpected server response: 401')),/密钥/);assert.match(voiceConnectionError(Error('Unexpected server response: 429')),/限流/);});
