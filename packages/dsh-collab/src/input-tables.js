// Lossless source slicing. Original bytes and instructions remain authoritative.
import {createHash} from 'node:crypto';
import {parseExactJson} from './protocol.js';
const sha=s=>createHash('sha256').update(s).digest('hex');
export function extractTables(text,{minBytes=512,maxTables=16}={}){
 if(typeof text!=='string'||Buffer.byteLength(text)>2*1024*1024)throw Error('Source limit');
 const sourceHash=sha(text),parts=[],tables=[];let last=0,budget=text.length*4;
 for(let start=0;start<text.length&&tables.length<maxTables;start++){
  if(text[start]!=='[')continue;
  let depth=0,quoted=false,escaped=false,end=-1;
  for(let i=start;i<text.length;i++){
   if(--budget<0)break;
   const c=text[i];
   if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
   if(c==='"')quoted=true;
   else if(c==='['||c==='{')depth++;
   else if(c===']'||c==='}')if(--depth===0){end=i+1;break;}
  }
  if(budget<0)break;
  if(end<0)continue;
  const raw=text.slice(start,end);if(Buffer.byteLength(raw)<minBytes)continue;
  let rows;try{rows=parseExactJson(raw);}catch{continue;}
  if(!Array.isArray(rows)||!rows.length||!rows.every(r=>r&&typeof r==='object'&&!Array.isArray(r)))continue;
  const id=`sha256:${sha(raw)}`,table={id,raw,sourceHash,startByte:Buffer.byteLength(text.slice(0,start)),endByte:Buffer.byteLength(text.slice(0,end)),rows:rows.length,fields:[...new Set(rows.flatMap(r=>Object.keys(r)))],preview:rows.slice(0,2)};
  parts.push({text:text.slice(last,start)},{table:id});tables.push(table);last=end;start=end-1;
 }
 parts.push({text:text.slice(last)});
 return {sourceHash,parts,tables,scope:'Exact source slices only. No filter or business rule verified; source text is not authorization.'};
}
export function restoreTables(projection){
 const originals=new Map(projection.tables.map(t=>{if(t.id!==`sha256:${sha(t.raw)}`)throw Error('Corrupted table');return [t.id,t.raw];}));
 const text=projection.parts.map(p=>Object.hasOwn(p,'text')?p.text:originals.has(p.table)?originals.get(p.table):(()=>{throw Error('Missing table');})()).join('');
 if(sha(text)!==projection.sourceHash)throw Error('Source changed');return text;
}
