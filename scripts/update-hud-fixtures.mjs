/** Refresh rendered frames only. Hand-written expectations stay independent of the implementation. */
import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {emptyHud,reduceHud,hudSnapshot} from '../packages/dsh-collab/src/hud-projection.js';
const directory=new URL('../contracts/fixtures/',import.meta.url);
for(const file of readdirSync(directory).filter(name=>name.startsWith('hud-')&&name.endsWith('.json'))) {
  const path=new URL(file,directory),fixture=JSON.parse(readFileSync(path,'utf8'));
  if(!fixture.steps) continue;
  let state=emptyHud();
  fixture.frames=fixture.steps.map(step=>{
    if(step.input) state=reduceHud(state,step.input);
    return hudSnapshot(state,step.now??step.input.at);
  });
  writeFileSync(path,JSON.stringify(fixture,null,2)+'\n');
}
