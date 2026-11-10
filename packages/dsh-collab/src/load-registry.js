import { readFileSync } from 'node:fs';
import { ProtocolRegistry } from './protocol.js';

/** Only explicitly configured versions are eligible for NEW messages; archived versions remain decodable. */
export function loadRegistry(store, file) {
  const parsed=file?JSON.parse(readFileSync(file,'utf8')):[];
  const input=Array.isArray(parsed)?parsed:[parsed];
  const configured=new ProtocolRegistry({definitions:input});
  const versions=configured.exportVersions();
  for(const definition of versions) {
    if(definition.status==='draft') {
      if(store.loadProtocol(definition.id,definition.version)) throw new Error('An archived protocol version cannot return to draft');
      continue;
    }
    // Archive immutable meaning and original evaluation, independently of current eligibility.
    store.registerProtocol({id:definition.id,version:definition.version,definition:{...definition,status:'published'}});
  }
  const active=new Set(versions.map(d=>`${d.id}@${d.version}`));
  const retired=store.listProtocols().filter(row=>row.definition&&!active.has(`${row.id}@${row.version}`))
    .map(row=>({...row.definition,status:'retired'}));
  return new ProtocolRegistry({definitions:[...versions,...retired]});
}
