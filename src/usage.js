import {randomUUID} from 'node:crypto';
import {voiceModels,priceFor} from './models.js';
const num=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:null;
export function normalizeUsage(u){
  if(!u||num(u.input_tokens)===null||num(u.output_tokens)===null)return null;
  return {input:num(u.input_tokens),output:num(u.output_tokens),cached:num((u.input_token_details||u.input_tokens_details)?.cached_tokens)||0,inputDetails:u.input_token_details||u.input_tokens_details||{},outputDetails:u.output_token_details||u.output_tokens_details||{}};
}
export function estimateCost(u,price){
  if(!u||!price)return null;
  let cost=0;
  for(const [kind,total,details] of [['input',u.input,u.inputDetails],['output',u.output,u.outputDetails]]){
    let counted=0;
    for(const modality of ['text','audio','image']){
      const amount=num(details[modality+'_tokens'])||0;counted+=amount;
      if(!amount)continue;
      if(kind==='output'&&modality==='text'&&price.audioTextFree&&(details.audio_tokens||0)>0)continue;
      const rate=price[kind]?.[modality];if(rate===undefined)return null;
      const cached=kind==='input'?(num(details.cached_tokens_details?.[modality+'_tokens'])||0):0;
      if(cached>amount)return null;
      if(cached&&!price.cached)return null;
      cost+=(amount-cached)*rate+cached*(price.cached?.[modality]||0);
    }
    // Unknown modality breakdown must not silently be priced as text.
    if(counted!==total)return null;
  }
  if(u.cached&&!u.inputDetails.cached_tokens_details)return null;
  return cost/1e6;
}
export class VoiceUsage {
  constructor(model,region,prompt){
    this.seen=new Set();this.seenTranscripts=new Set();this.model=voiceModels[model];this.price=priceFor(model,region);
    this.state={id:randomUUID(),model,region,startedAt:new Date().toISOString(),responses:0,reportedResponses:0,missingResponses:0,inputTokens:0,outputTokens:0,cachedTokens:0,transcriptionTokens:0,transcriptionReports:0,transcriptionMissing:0,cost:0,unpricedResponses:0,currency:this.price?.currency||null,priceDate:'2026-09-29',latestInput:null,promptCharacters:prompt.length,userAudioSeconds:0,assistantAudioSeconds:0,audioTurns:0};
  }
  response(event){
    const key=event.response?.id||event.event_id;
    if(key&&this.seen.has(key))return false;if(key)this.seen.add(key);
    const s=this.state;s.responses++;const u=normalizeUsage(event.response?.usage||event.usage);
    if(!u){s.missingResponses++;return true;}
    s.reportedResponses++;s.inputTokens+=u.input;s.outputTokens+=u.output;s.cachedTokens+=u.cached;s.latestInput=u.input;
    const cost=estimateCost(u,this.price);if(cost===null)s.unpricedResponses++;else s.cost+=cost;
    return true;
  }
  transcription(event){
    const key=event.item_id||event.event_id;if(key&&this.seenTranscripts.has(key))return;
    if(key)this.seenTranscripts.add(key);
    const u=event.usage;
    if(num(u?.total_tokens)!==null){this.state.transcriptionTokens+=u.total_tokens;this.state.transcriptionReports++;}
    else this.state.transcriptionMissing++;
  }
  snapshot(ongoingSeconds=0){
    const s={...this.state,userAudioSeconds:this.state.userAudioSeconds+ongoingSeconds},limit=this.model?.inputLimit||null;
    // Latest request input is only a proxy for current occupancy, never cumulative billed tokens.
    const used=s.latestInput;const tokenRatio=used!==null&&limit?used/limit:null;
    const audio=this.model?.family==='audio';
    const seconds=s.userAudioSeconds+s.assistantAudioSeconds;
    const historyRatio=audio?Math.max(s.audioTurns/50,seconds/300):0;
    return {...s,inputLimit:limit,contextWindow:this.model?.context||null,remainingInputEstimate:used!==null&&limit?Math.max(0,limit-used):null,tokenRatio,audioHistoryLimit:audio?300:null,historyRatio,warning:Math.max(tokenRatio||0,historyRatio)>=0.8,historyMayRoll:historyRatio>=1};
  }
}
