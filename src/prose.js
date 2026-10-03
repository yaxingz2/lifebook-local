// Strip only internal provenance markers, not ordinary brackets, dates or quotations.
export function cleanProse(value,ids=[]){
  const known=new Set(ids.flatMap(id=>[String(id),String(id).replace(/:\d+$/,'')]));
  const uuid=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::\d+)?/gi;
  return String(value||'').replace(/\[[^\]\n]*\]|【[^】\n]*】|\([^()\n]*\)|（[^（）\n]*）/g,marker=>{
    const found=marker.match(uuid)||[];
    if(!found.length||found.some(id=>!known.has(id)&&!known.has(id.replace(/:\d+$/,''))))return marker;
    const residue=marker.replace(uuid,'').replace(/来源|出处|素材|source|unitIds?|turnIds?/gi,'').replace(/[\[\]【】()（）'"“”‘’，,;；:：\s]/g,'');
    return residue?marker:'';
  }).trim();
}
export function hasInternalIds(text,ids){return ids.some(id=>String(text).includes(id));}
