// Speech/commit events establish order before asynchronous transcription finishes.
// Completed text is saved immediately; this index repairs its order when an
// earlier transcript arrives, without keeping completed memories only in RAM.
export class TranscriptOrder {
  constructor() { this.items=new Map(); this.next=0; }
  observe(id) {
    if(id&&!this.items.has(id))this.items.set(id,{order:this.next++,complete:false,text:''});
  }
  complete(id,text) {
    if(!id)return true;
    this.observe(id);
    const item=this.items.get(id);
    if(item.complete)return false;
    item.complete=true;item.text=text;
    return true;
  }
  isComplete(id) { return this.items.get(id)?.complete===true; }
  compare(a,b) {
    if(!this.items.has(a)||!this.items.has(b))return 0;
    return this.items.get(a).order-this.items.get(b).order;
  }
  join(ids) {
    const ordered=[...new Set(ids)].sort((a,b)=>this.compare(a,b));
    return {ids:ordered,text:ordered.map(id=>this.items.get(id)?.text||'').join('')};
  }
}
