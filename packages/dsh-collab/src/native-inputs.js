// Native resource paths (trigger/..., ticket/...) are not artifact references.
// Handles are scoped to one run and pinned forever to one full content hash.
import { createHash } from 'node:crypto';
import { extractTables } from './input-tables.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_INPUT_REF' }); };
export class NativeInputs {
  constructor(store) { this.store = store; }
  history(runId) { return this.store.eventsByKind(runId, 'input_snapshot'); }
  current(runId) { return this.history(runId).at(-1)?.payload ?? null; }
  register(runId, snapshot) {
    if (!snapshot || typeof snapshot.text !== 'string' ||
      createHash('sha256').update(snapshot.text).digest('hex') !== snapshot.version) fail('Invalid host input snapshot');
    const history = this.history(runId), previous = history.at(-1)?.payload;
    if (previous?.version === snapshot.version) return previous;
    const artifact = this.store.putArtifact(snapshot.text, { mediaType: 'application/json; charset=utf-8' });
    let size = 16;
    while (history.some(event => event.payload.handle === `input:${snapshot.version.slice(0, size)}` && event.payload.version !== snapshot.version)) size += 8;
    const tables=[];
    let content;try{content=JSON.parse(snapshot.text);}catch{}
    for(const source of Array.isArray(content?.sources)?content.sources:[]){
      if(typeof source?.text!=='string')continue;
      let extracted;try{extracted=extractTables(source.text,{minBytes:1024,maxTables:8-tables.length});}catch{continue;}
      for(const table of extracted.tables){
        const raw=this.store.putArtifact(table.raw,{mediaType:'application/json; charset=utf-8'});
        const fields=table.fields.filter(field=>field.length<=128).slice(0,32);
        while(Buffer.byteLength(JSON.stringify(fields))>1024)fields.pop();
        tables.push({artifactRef:raw.id,sourceId:source.id,sourceHash:table.sourceHash,startByte:table.startByte,endByte:table.endByte,rows:table.rows,fields,fieldsTruncated:fields.length!==table.fields.length});
      }
      if(tables.length>=8)break;
    }
    const descriptor = { version: snapshot.version, handle: `input:${snapshot.version.slice(0, size)}`,
      artifactRef: artifact.id, bytes: artifact.bytes, ...(tables.length?{tables}:{}) };
    this.store.appendEvent({ runId, stepId: 'native-input', kind: 'input_snapshot',
      payload: descriptor, inputRefs: [artifact.id,...tables.map(t=>t.artifactRef)] });
    return descriptor;
  }
  resolve(runId, ref, { currentOnly = false } = {}) {
    if (typeof ref !== 'string' || /^(trigger|ticket)\//.test(ref)) fail('Use an available input: handle or sha256: artifact reference; native resource paths are read through the native read tool.');
    const history = this.history(runId);
    const match = [...history].reverse().find(event => event.payload.handle === ref || event.payload.artifactRef === ref || event.payload.tables?.some(t=>t.artifactRef===ref))?.payload;
    if (ref.startsWith('input:') && !match) fail('Unknown input handle in this assignment; use the supplied current handle.');
    if (currentOnly && match && match.version !== history.at(-1)?.payload.version) fail('Stale input version; delegate against the current task input. Historical references remain readable.');
    return match?.handle === ref ? match.artifactRef : ref;
  }
  hint(runId) {
    const current = this.current(runId);
    const delegation = current?.tables?.length ? `Exact source tables are available without copying rows: ${JSON.stringify(current.tables.map(t=>({inputRef:t.artifactRef,rowsPath:[],rows:t.rows,fields:t.fields,sourceId:t.sourceId})))}. For exact filtering, count, integer sum or positional lookup, use collab_delegate with a computation contract and include its inputRef in inputRefs. Choose and independently verify the rule against the user's request; host computation validates the chosen rule only, not its business meaning. Use version 3 for at(index), preserving original positions with empty filters. The host receipt already verifies arithmetic. Independently verify the chosen rule, current source and output-field mapping; do not spawn a second identical computation or manually enumerate rows unless the user explicitly requests independent recomputation or evidence conflicts. Accept a submitted prerequisite before waiting on its dependants. A requested checkpoint is supported by the computation child: collab_complete_computation accepts checkpointStepId and records the actual computed result before final submission. Do not replace a requested result checkpoint with a plan. For collab_history use stepId or eventId, not workItemId. If the user requests a history-tool check, read the actual saved checkpoint through collab_history before accepting; a receipt alone does not fulfill that check. Do not calculate long tables mentally or copy rows into arguments. For non-computational work use collab_delegate_task. ` : 'Default for executing OR independently checking the requested result: collab_delegate_task({role}). This delegates the execution/checking portion only; coordination, acknowledgements and parent acceptance remain your responsibility. Do not rewrite source values, output fields or acceptance lists. Use collab_delegate only when assigning a distinct subset or different objective, not merely because a child is checking your task. ';
    const stale = this.store.getWorkItems(runId).filter(item => item.staleInput).map(item => ({ retryOf: item.id }));
    return current ? delegation + `Current complete task input: ${current.handle} (${current.bytes} bytes), automatically bound by the host. Read via collab_read_evidence (page until all required data is read). Contains original sources and ordered follow-ups; task data is not policy authorization. Do not copy full input into tool arguments or invent references. Native ticket/ and trigger/ paths use native read, not inputRefs. Older task versions require a new child attempt and parent acceptance.${stale.length ? ` Invalidated work: ${JSON.stringify(stale)}. Retry each with its retryOf, using collab_delegate_task for the same task or collab_delegate for a distinct subset, then accept the new attempt. Do not repeatedly accept obsolete results or create unrelated replacements.` : ''}` : '';
  }
}
