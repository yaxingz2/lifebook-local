// Live text and saved turns share the positions reserved by speech/response
// events. ASR arrival time must not determine the conversation's order.
let transcriptSerial=0;
export class VoiceTranscript {
  constructor({preserveInterrupted=false}={}){
    this.responses=new Map();this.users=new Map();this.positions=new Map();this.current=null;this.serial=0;this.next=0;this.ignored=new Set();this.preserveInterrupted=preserveInterrupted;this.uiPrefix=++transcriptSerial;
  }
  position(key){if(!this.positions.has(key))this.positions.set(key,this.next++);return this.positions.get(key);}
  event(e){
    const type=e.type.replace('response.output_audio_transcript.','response.audio_transcript.');
    const id=e.response_id||e.response?.id;
    if(type==='response.created'){
      this.current=id||`local-${++this.serial}`;
      if(!this.responses.has(this.current)&&!this.ignored.has(this.current))this.responses.set(this.current,{id:this.current,role:'assistant',text:'',complete:false,order:this.position(`assistant:${this.current}`)});
      return;
    }
    if(type==='input_audio_buffer.speech_started'||type==='input_audio_buffer.committed'||type==='conversation.item.input_audio_transcription.completed'){
      if(e.item_id){
        const order=this.position(`user:${e.item_id}`);
        if(type==='conversation.item.input_audio_transcription.completed'&&e.transcript)this.users.set(e.item_id,{id:e.item_id,role:'user',text:String(e.transcript),complete:true,order});
      }
      if(type==='input_audio_buffer.speech_started'){
        const current=this.responses.get(this.current);
        if(current&&!current.complete){
          if(this.preserveInterrupted&&current.text){current.interrupted=true;current.complete=true;}
          else this.responses.delete(this.current);
          this.ignored.add(this.current);
        }
      }
      return;
    }
    if(id&&this.current?.startsWith('local-')&&!this.responses.has(id)&&this.responses.has(this.current)){
      const preview=this.responses.get(this.current);this.responses.delete(this.current);preview.id=id;this.positions.set(`assistant:${id}`,preview.order);this.responses.set(id,preview);this.current=id;
    }
    const key=id||this.current;if(!key||this.ignored.has(key))return;
    const current=this.responses.get(key);if(!current)return;
    if(type==='response.audio_transcript.delta'&&!current.complete)current.text=(current.text+String(e.delta||'')).slice(0,4000);
    if(type==='response.audio_transcript.done'&&!current.complete)current.text=String(e.transcript||current.text).slice(0,4000);
    if(type==='response.done'){
      if(e.response?.status&&e.response.status!=='completed'){
        if(this.preserveInterrupted&&current.text){current.interrupted=true;current.complete=true;}
        else this.responses.delete(key);
        this.ignored.add(key);
      }else current.complete=true;
    }
  }
  reconcile(turns){
    for(const t of turns){
      if(t.role==='assistant'&&t.providerResponseId)this.responses.delete(t.providerResponseId);
      if(t.role==='user'&&t.providerItemId)this.users.delete(t.providerItemId);
    }
  }
  visible(){return [...this.responses.values()].filter(r=>r.text);}
  rows(turns){
    this.reconcile(turns);
    const rows=turns.map(t=>{
      const order=this.positions.get(`${t.role}:${t.role==='user'?t.providerItemId:t.providerResponseId}`);
      return {turn:order===undefined?t:{...t,uiKey:`${t.role}:live:${this.uiPrefix}:${order}`},order};
    });
    // Sort only positions observed in this connection; historical rows retain
    // their exact positions. Reconnecting cannot infer older missing metadata.
    const live=rows.filter(r=>r.order!==undefined);
    for(const t of [...this.users.values(),...this.responses.values()])if(t.text)live.push({turn:{...t,preview:true,uiKey:`${t.role}:live:${this.uiPrefix}:${t.order}`},order:t.order});
    live.sort((a,b)=>a.order-b.order);
    let index=0;
    const merged=rows.map(r=>r.order===undefined?r.turn:live[index++].turn);
    merged.push(...live.slice(index).map(r=>r.turn));return merged;
  }
}
