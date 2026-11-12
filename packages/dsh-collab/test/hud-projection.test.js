import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import Ajv from 'ajv';
import {emptyHud,reduceHud,hudSnapshot,HudProjection} from '../src/hud-projection.js';
const read=path=>JSON.parse(readFileSync(new URL('../../../contracts/'+path,import.meta.url),'utf8'));
const ajv=new Ajv({strict:false,formats:{'date-time':value=>Number.isFinite(Date.parse(value))}});
const validate=ajv.compile(read('hud-v1.schema.json'));
for(const file of ['hud-normal.json','hud-invalidated.json','hud-restarted.json']) test(`deterministic HUD replay: ${file}`,()=>{
  const fixture=read('fixtures/'+file);
  const replay=()=>{let state=emptyHud();return fixture.steps.map(step=>{
    state=reduceHud(state,step.input);const snapshot=hudSnapshot(state,step.input.at);
    assert.equal(snapshot.agents[0].state,step.state);assert.equal(snapshot.seq,step.seq);
    assert.ok(validate(snapshot),JSON.stringify(validate.errors));return snapshot;
  });};
  assert.deepEqual(replay(),replay());
  assert.deepEqual(replay(),fixture.frames);
  const events=replay().at(-1).events;
  assert.equal(events.filter(e=>e.kind==='turn.start').length,events.filter(e=>e.kind==='turn.end').length);
  assert.equal(events.filter(e=>e.kind==='tool.start').length,events.filter(e=>e.kind==='tool.end').length);
});

test('silence does not change state or sequence; confirmations resolve against open turn',()=>{
  let state=reduceHud(emptyHud(),{kind:'turn.start',agentId:'a',turn:1,at:'2026-11-12T00:00:00Z'});
  const stale=hudSnapshot(state,'2026-11-12T00:01:00Z');
  assert.equal(stale.agents[0].state,'running');assert.equal(stale.agents[0].stalled,true);assert.equal(stale.seq,2);
  const apply=input=>{state=reduceHud(state,{agentId:'a',at:'2026-11-12T00:01:01Z',...input});return hudSnapshot(state,'2026-11-12T00:02:00Z').agents[0];};
  assert.equal(apply({kind:'attention.raised',attentionId:'p'}).state,'waiting-human');
  assert.equal(apply({kind:'attention.raised',attentionId:'q'}).stalled,false);
  assert.equal(apply({kind:'attention.resolved',attentionId:'p'}).state,'waiting-human');
  assert.equal(apply({kind:'attention.resolved',attentionId:'q'}).state,'running');
  assert.equal(apply({kind:'attention.raised',attentionId:'p'}).state,'waiting-human');
  assert.equal(apply({kind:'turn.end',turn:1,outcome:'completed'}).state,'waiting-human');
  assert.equal(apply({kind:'attention.resolved',attentionId:'p'}).state,'idle');
});

function storeFixture() {
  const frames=[];return {frames,listRuns:()=>[{id:'r'}],getAgents:()=>[],getRun:()=>({ticketId:'t'}),
    eventsByKind:(id,kind)=>frames.filter(e=>e.runId===id&&e.kind===kind),appendEvent:event=>frames.push(structuredClone(event))};
}
test('native input is whitelisted, duplicate delivery is idempotent, restart clears ghosts durably',()=>{
  const store=storeFixture(),now=()=> '2026-11-12T00:01:00.000Z',hud=new HudProjection(store,{now});
  const binding={id:'a',runId:'r',role:'worker'};
  const start={type:'turn/start',seq:1,time:Date.parse(now()),data:{turn:1,model:'SECRET_MODEL'}};
  hud.observe(binding,start);hud.observe(binding,start);
  hud.observe(binding,{type:'tool/call',seq:2,time:Date.parse(now()),data:{callId:'c',name:'shell',arguments:'SECRET_COMMAND'}});
  assert.doesNotMatch(JSON.stringify(hud.snapshot('r')),/SECRET|arguments|model|callId/);
  const before=hud.snapshot('r').seq;
  const recovered=new HudProjection(store,{now});
  assert.equal(recovered.snapshot('r').agents[0].state,'idle');assert.ok(recovered.snapshot('r').seq>before);
  const again=new HudProjection(store,{now});assert.equal(again.snapshot('r').seq,recovered.snapshot('r').seq);
  assert.ok(validate(again.snapshot('r')),JSON.stringify(validate.errors));
});

test('pending user question stays visible after tool and turn end until reply',()=>{
  const hud=new HudProjection(storeFixture()),binding={id:'a',runId:'r'};
  const send=(type,data,seq)=>hud.observe(binding,{type,data,seq,time:Date.parse('2026-11-12T00:00:00Z')});
  send('turn/start',{turn:1},1);send('tool/call',{callId:'q',name:'ask_user_question'},2);
  send('tool/result',{message:{toolCallId:'q',content:[{type:'text',text:'{"pending":true,"private":"SECRET"}'}]}},3);
  send('turn/end',{turn:1,reason:{kind:'completed'}},4);
  assert.equal(hud.snapshot('r').agents[0].state,'waiting-human');
  send('user/message',{source:{kind:'user-question-reply',callId:'q'},content:'PRIVATE_ANSWER'},5);
  assert.equal(hud.snapshot('r').agents[0].state,'idle');assert.doesNotMatch(JSON.stringify(hud.snapshot('r')),/PRIVATE|SECRET/);
});

test('native error is failed, abort is idle, tool boundaries remain paired and terminal state persists',()=>{
  const hud=new HudProjection(storeFixture()),binding={id:'a',runId:'r'};
  const send=(type,data,seq)=>hud.observe(binding,{type,data,seq,time:Date.parse('2026-11-12T00:00:00Z')});
  send('turn/start',{turn:1},1);send('tool/call',{callId:'c',name:'shell'},2);
  send('turn/end',{turn:1,reason:{kind:'error',error:{message:'SECRET_PATH'}}},3);
  assert.equal(hud.snapshot('r').agents[0].state,'failed');
  const seq=hud.snapshot('r').seq;assert.equal(hud.snapshot('r').seq,seq);
  send('turn/start',{turn:2},4);send('turn/end',{turn:2,reason:{kind:'aborted'}},5);
  const snapshot=hud.snapshot('r');assert.equal(snapshot.agents[0].state,'idle');
  assert.equal(snapshot.events.filter(e=>e.kind==='tool.end').length,1);
  assert.equal(snapshot.events.filter(e=>e.kind==='turn.end').length,2);
  assert.doesNotMatch(JSON.stringify(snapshot),/SECRET_PATH|message/);
});
