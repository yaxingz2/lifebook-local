// Validate the structures consumed by the app before an imported book can
// become durable data. A matching checksum proves integrity, not schema safety.
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid=()=>{throw Object.assign(new Error('备份结构错误，请使用完整的 LifeBook 备份文件。'),{status:400});};
const object=x=>{if(!x||typeof x!=='object'||Array.isArray(x))invalid();};
const array=x=>{if(!Array.isArray(x))invalid();};
const string=x=>{if(typeof x!=='string')invalid();};
const id=x=>{if(typeof x!=='string'||!idPattern.test(x))invalid();};
const optional=(x,key,check)=>{if(x[key]!==undefined)check(x[key]);};
const strings=x=>{array(x);x.forEach(string);};
const boolean=x=>{if(typeof x!=='boolean')invalid();};
const integer=x=>{if(!Number.isSafeInteger(x)||x<0)invalid();};
const unique=(items,key='id')=>{const seen=new Set();for(const item of items){object(item);if(seen.has(item[key]))invalid();seen.add(item[key]);}};

function paragraph(p,sourceIds){
  object(p);id(p.id);string(p.text);array(p.sourceTurnIds);if(!p.sourceTurnIds.length)invalid();
  for(const source of p.sourceTurnIds){id(source);if(!sourceIds.has(source))invalid();}
  optional(p,'sectionId',id);optional(p,'sectionTitle',string);
}
function chapters(items,sourceIds){
  array(items);unique(items);
  for(const c of items){object(c);id(c.id);string(c.title);array(c.paragraphs);unique(c.paragraphs);c.paragraphs.forEach(p=>paragraph(p,sourceIds));}
}
function manuscript(value,sourceIds){
  if(value===null)return;
  object(value);array(value.sections);unique(value.sections);
  for(const s of value.sections){
    object(s);id(s.id);id(s.chapterId);string(s.title);strings(s.unitIds);
    optional(s,'summary',string);optional(s,'issues',strings);
    optional(s,'paragraphs',rows=>{array(rows);rows.forEach(p=>paragraph(p,sourceIds));});
    optional(s,'deferred',rows=>{array(rows);for(const row of rows){object(row);string(row.unitId);string(row.reason);}});
  }
  optional(value,'chapters',rows=>{array(rows);for(const c of rows){object(c);id(c.id);string(c.title);}});
  optional(value,'pending',rows=>{array(rows);for(const p of rows){object(p);string(p.unitId);id(p.sourceTurnId);string(p.text);string(p.reason);if(!sourceIds.has(p.sourceTurnId))invalid();}});
  optional(value,'coverage',c=>{object(c);integer(c.total);integer(c.included);integer(c.pending);});
}
export function validateBackupBook(book){
  object(book);if(book.schemaVersion!==1)invalid();id(book.id);string(book.title);string(book.createdAt);
  optional(book,'name',string);optional(book,'revision',integer);
  for(const field of ['sessions','claims','chapters','avoidedTopics'])array(book[field]);
  const sources=new Set(),turnIds=new Set();unique(book.sessions);unique(book.claims);
  for(const s of book.sessions){
    object(s);id(s.id);array(s.turns);optional(s,'startedAt',string);
    optional(s,'focus',f=>{object(f);string(f.stage);string(f.theme);});
    optional(s,'voiceRuns',rows=>{array(rows);rows.forEach(object);});
    optional(s,'storySummary',summary=>{object(summary);string(summary.title);strings(summary.sourceTurnIds);string(summary.fingerprint);});
    for(const t of s.turns){
      object(t);id(t.id);string(t.text);if(!['user','assistant'].includes(t.role)||turnIds.has(t.id))invalid();turnIds.add(t.id);
      if(t.role==='user')sources.add(t.id);
      for(const key of ['deleted','avoided','excludedFromBook'])optional(t,key,boolean);
      optional(t,'providerItemIds',strings);
    }
  }
  for(const c of book.claims){object(c);id(c.id);id(c.sourceTurnId);string(c.text);if(!sources.has(c.sourceTurnId)||!['proposed','confirmed','rejected'].includes(c.status))invalid();}
  for(const topic of book.avoidedTopics){object(topic);string(topic.topic);}
  chapters(book.chapters,sources);optional(book,'manuscript',m=>manuscript(m,sources));
  optional(book,'manuscriptVersions',versions=>{
    array(versions);unique(versions);
    for(const version of versions){
      object(version);id(version.id);chapters(version.chapters,sources);array(version.evidence);string(version.avoidedHash);
      for(const e of version.evidence){object(e);id(e.id);string(e.hash);}
      optional(version,'manuscript',m=>manuscript(m,sources));
    }
  });
  return book;
}
