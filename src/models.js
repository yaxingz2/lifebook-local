// Official provider documentation checked 2026-09-29. Prices are estimates,
// per million tokens; unknown rates stay unknown instead of borrowing a model's rate.
const audioVoices=['longanqian','longanlingxin','longanlingxi','longanxiaoxin','longanlufeng'];
export const voiceModels={
  'qwen-audio-3.0-realtime-flash':{provider:'qwen',family:'audio',label:'Qwen Audio 3.0 Flash · 推荐',context:40960,inputLimit:16384,voices:audioVoices},
};
export function selectedModel(s){return s.qwenVoiceModel;}
export function speechPreference(s){
  const pace={slow:'语速适度偏慢',normal:'使用自然语速',fast:'语速稍快但清晰'}[s.qwenSpeechRate]||'使用自然语速';
  return ` 用自然清晰的普通话交谈，${pace}，语调平和，句间留自然停顿。表达亲切而克制，像耐心听人讲话的访谈者，不刻意气声、拖长尾音或过度兴奋。根据讲述者的表达自然接话，给他开口和继续说的空间。`;
}
export function initialVoiceConfig(s,instructions){
  const model=voiceModels[selectedModel(s)];
  if(!model)throw Error('此语音模型尚未适配 WebRTC');
  const voice=s.qwenVoices?.[s.qwenVoiceModel]||model.voices[0];
  return {modalities:['text','audio'],instructions,voice,enable_speech_emotion:false,input_audio_format:'pcm',output_audio_format:'pcm',max_history_turns:50,turn_detection:s.qwenTurnDetection==='server_vad'?{type:'server_vad',threshold:0.75,silence_duration_ms:1200}:{type:'smart_turn'}};
}
export function priceFor(model,region){
  // Legacy regional rates do not establish the unified endpoint's billing rate.
  if(region==='unified')return null;
  const intl=region==='ap-southeast-1';
  if(model==='qwen-audio-3.0-realtime-flash')return {currency:'CNY',input:{text:intl?1.677:1.5,audio:intl?6.781:6},output:{text:intl?5.104:4.5,audio:intl?13.636:12},audioTextFree:true};
  if(['qwen-audio-3.0-realtime-plus','qwen-audio-3.1-realtime-plus'].includes(model))return {currency:'CNY',input:{text:intl?5.995:5,audio:intl?47.963:40},output:{text:intl?47.963:40,audio:intl?179.861:150},audioTextFree:true};
  return null;
}
