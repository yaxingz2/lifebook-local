import {EventEmitter} from 'node:events';
import {WebSocket} from 'ws';

// Audio travels over the browser/provider peer connection. This adapter relays
// only control and transcription metadata through the authenticated app socket.
// Metadata is client-reported, so it is not authoritative billing evidence.
export class WebRtcProvider extends EventEmitter {
  constructor(client,{apiKey,model,offer}) {
    super();
    if(process.env.LIFEBOOK_WEBRTC_ALLOWED==='0')throw Error('此安装尚未启用 WebRTC');
    if(model!=='qwen-audio-3.0-realtime-flash')throw Error('WebRTC 当前支持千问 Audio 3.0 Flash');
    if(typeof offer!=='string'||offer.length>60000||!offer.startsWith('v=0')||!/^m=audio /m.test(offer))throw Error('无效的 WebRTC 连接请求');
    this.client=client;this.readyState=WebSocket.CONNECTING;this.bufferedAmount=0;
    this.controller=new AbortController();
    this.receive=(raw,binary)=>{
      if(binary||this.readyState!==WebSocket.OPEN)return;
      let msg;try{msg=JSON.parse(raw.toString());}catch{return;}
      if(msg.type!=='rtc_event')return;
      const e=msg.event;
      if(!e||typeof e.type!=='string'||!/^(session\.(created|updated)|error|response\.(created|done|audio_transcript\.(delta|done)|output_audio_transcript\.(delta|done))|input_audio_buffer\.(speech_started|speech_stopped|committed)|conversation\.item\.input_audio_transcription\.(completed|failed))$/.test(e.type))return;
      const data=JSON.stringify(e);if(data.length>60000)return;
      this.emit('message',Buffer.from(data));
    };
    client.on('message',this.receive);
    queueMicrotask(async()=>{
      try{
        const address=process.env.NODE_ENV==='test'&&process.env.LIFEBOOK_WEBRTC_TEST_URL
          ?process.env.LIFEBOOK_WEBRTC_TEST_URL
          :`https://maas.qianwenaiapi.com/api/v1/webrtc/realtime?model=${encodeURIComponent(model)}`;
        const response=await fetch(address,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/sdp'},body:offer,signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(20000)])});
        const answer=await response.text();
        if(!response.ok||!answer.startsWith('v=0')||answer.length>60000)throw Error('千问 WebRTC 握手未完成，请重试');
        if(this.readyState!==WebSocket.CONNECTING||client.readyState!==WebSocket.OPEN)return;
        this.readyState=WebSocket.OPEN;this.emit('open');
        client.send(JSON.stringify({type:'rtc_answer',sdp:answer}));
      }catch{
        if(this.readyState===WebSocket.CLOSED)return;
        this.emit('error',Error('WebRTC 连接未完成，请重试'));
        this.close(1011);
      }
    });
  }
  send(raw) {
    if(this.readyState!==WebSocket.OPEN||this.client.readyState!==WebSocket.OPEN)return;
    this.client.send(JSON.stringify({type:'rtc_command',event:JSON.parse(raw)}));
  }
  close(code=1000) {
    if(this.readyState===WebSocket.CLOSED)return;
    this.readyState=WebSocket.CLOSED;this.controller.abort();this.client.off('message',this.receive);
    if(this.client.readyState===WebSocket.OPEN)this.client.send(JSON.stringify({type:'rtc_close'}));
    this.emit('close',code);
  }
  terminate(){this.close(1006);}
}
