import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import Ajv from 'ajv';
import {emptyHud,reduceHud,hudSnapshot,HudProjection} from '../src/hud-projection.js';
import {hudLabel} from '../src/hud-label.js';
import {syncHostQuestions,installBlockingAttention} from '../src/hud-host.js';
import {emittedToolIds} from './tool-inventory.js';
const read=path=>JSON.parse(readFileSync(new URL('../../../contracts/'+path,import.meta.url),'utf8'));
const ajv=new Ajv({strict:false,formats:{'date-time':value=>Number.isFinite(Date.parse(value))}});
const validate=ajv.compile(read('hud-v1.schema.json'));
test('label boundary fixtures: Unicode length, sanitization, fallback and title precedence',()=>{
  for(const {input,expected} of read('fixtures/hud-labels.json').cases) {
    assert.equal(hudLabel(input),expected);
    assert.ok(Array.from(hudLabel(input)).length<=12);
  }
});

test('alias file covers producer inventory in both directions, with native IDs unchanged',()=>{
  const table=read('tool-aliases-v2.json'),previous=read('tool-aliases-v1.json'),ids=emittedToolIds();
  assert.equal(table.version,2);
  for (const [id, alias] of Object.entries(previous.aliases)) assert.equal(table.aliases[id], alias);
  assert.deepEqual(Object.keys(table.aliases).sort(),ids);
  for(const id of ids) {
    assert.equal(typeof table.aliases[id],'string');
    const state=reduceHud(reduceHud(emptyHud(),{kind:'turn.start',turn:1,agentId:'a',at:'2026-11-12T00:00:00Z'}),
      {kind:'tool.start',tool:id,callId:'c',agentId:'a',at:'2026-11-12T00:00:01Z'});
    const snapshot = hudSnapshot(state,'2026-11-12T00:00:01Z');
    assert.equal(snapshot.agents[0].lastEvent.tool,id);
    assert.equal(snapshot.aliasVersion,id === 'collab_csv_workflow' ? 2 : 1);
  }
  assert.equal(hudSnapshot(emptyHud(),'2026-11-12T00:00:00Z').aliasVersion,1);
});
for(const file of ['hud-normal.json','hud-invalidated.json','hud-restarted.json','hud-attention.json','hud-stalled.json']) test(`deterministic HUD replay: ${file}`,()=>{
  const fixture=read('fixtures/'+file);
  const replay=()=>{let state=emptyHud();return fixture.steps.map(step=>{
    if(step.input) state=reduceHud(state,step.input);const snapshot=hudSnapshot(state,step.now??step.input.at);
    assert.equal(snapshot.agents[0].state,step.state);assert.equal(snapshot.seq,step.seq);
    if(step.label!==undefined) assert.equal(snapshot.agents[0].label,step.label);
    if(step.stalled!==undefined) assert.equal(snapshot.agents[0].stalled,step.stalled);
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

test('registration persists label and only explicit registration changes it, across turns and restart',()=>{
  const store=storeFixture(),hud=new HudProjection(store),binding={id:'a',runId:'r',role:'worker',hudLabel:'核对报告'};
  hud.register(binding);const seq=hud.snapshot('r').seq;
  hud.register(binding);assert.equal(hud.snapshot('r').seq,seq);
  for(let turn=1;turn<=3;turn++) {
    hud.observe(binding,{type:'turn/start',data:{turn}});
    hud.observe(binding,{type:'turn/end',data:{turn,reason:{kind:'completed'}}});
    assert.equal(hud.snapshot('r').agents[0].label,'核对报告');
  }
  const restarted=new HudProjection(store);
  assert.equal(restarted.snapshot('r').agents[0].label,'核对报告');
  restarted.register({...binding,hudLabel:'编写测试'});
  assert.equal(restarted.snapshot('r').agents[0].lastEvent.kind,'agent.register');
  assert.equal(restarted.snapshot('r').agents[0].label,'编写测试');
});

test('host structured questions and approvals coexist; text cannot raise or resolve attention',()=>{
  const hud=new HudProjection(storeFixture()),binding={id:'a',runId:'r'},session={id:'a'};
  let active=[];
  const ctx={sessionProjections:{snapshot:(s,keys)=>{assert.equal(s,session);assert.deepEqual(keys,['userQuestions']);return {values:{userQuestions:{active}}};}}};
  const sync=()=>syncHostQuestions(ctx,hud,binding,session);
  hud.observe(binding,{type:'turn/start',data:{turn:1}});
  hud.observe(binding,{type:'tool/call',data:{callId:'q',name:'ask_user_question'}});
  hud.observe(binding,{type:'tool/result',data:{message:{toolCallId:'q',content:[{type:'text',text:'{"pending":true}'}]}}});
  assert.equal(hud.snapshot('r').agents[0].state,'running');
  active=[{callId:'q',state:'continued',questions:'PRIVATE'}];sync();
  const seq=hud.snapshot('r').seq;sync();assert.equal(hud.snapshot('r').seq,seq);
  hud.observe(binding,{type:'approval/asked',data:{id:'p'}});
  active=[];sync();assert.equal(hud.snapshot('r').agents[0].state,'waiting-human');
  hud.observe(binding,{type:'approval/decided',data:{id:'p'}});
  assert.equal(hud.snapshot('r').agents[0].state,'running');
  active=[{callId:'late',state:'continued'}];sync();
  hud.observe(binding,{type:'turn/end',data:{turn:1,reason:{kind:'aborted'}}});
  const cancelled=hud.snapshot('r').seq;sync();
  assert.equal(hud.snapshot('r').seq,cancelled);assert.equal(hud.snapshot('r').agents[0].state,'idle');
  assert.deepEqual(hud.load('r').agents.a.attention,[]);
  assert.doesNotMatch(JSON.stringify(hud.snapshot('r')),/PRIVATE|"pending"|callId/);
});

test('blocking structured requests raise immediately and settle on answer or provider failure',async()=>{
  const hud=new HudProjection(storeFixture()),binding={id:'a',runId:'r'};
  hud.observe(binding,{type:'turn/start',data:{turn:1}});
  let handler;
  installBlockingAttention({on:(name,fn)=>{assert.equal(name,'user-questions/request');handler=fn;}},{hud,binding:()=>binding},()=>false);
  let answer;const reply=new Promise(resolve=>{answer=resolve;});
  const pending=handler({agent:{id:'a'}},()=>reply);
  assert.equal(hud.snapshot('r').agents[0].state,'waiting-human');
  answer({answers:[]});await pending;
  assert.equal(hud.snapshot('r').agents[0].state,'running');
  await assert.rejects(handler({agent:{id:'a'}},()=>Promise.reject(new Error('provider failed'))));
  assert.equal(hud.snapshot('r').agents[0].state,'running');
});

test('activity timestamps refresh at every real turn, tool and attention transition',()=>{
  let state=emptyHud();
  const inputs=[{kind:'turn.start',turn:1},{kind:'tool.start',callId:'c',tool:'read'},
    {kind:'tool.end',callId:'c'},{kind:'attention.raised',attentionId:'q'},{kind:'attention.resolved',attentionId:'q'}];
  for(const [i,input] of inputs.entries()) {
    const at=new Date(Date.UTC(2026,10,12,0,0,i*25)).toISOString();
    state=reduceHud(state,{...input,agentId:'a',at});
    assert.equal(state.agents.a.lastActivity,at);
    assert.equal(hudSnapshot(state,at).agents[0].stalled,false);
  }
  for(const outcome of ['completed','failed','cancelled']) {
    const end=reduceHud(state,{kind:'turn.end',turn:1,agentId:'a',outcome,at:'2026-11-12T00:03:00Z'});
    assert.equal(hudSnapshot(end,'2026-11-13T00:00:00Z').agents[0].stalled,false);
  }
});

test('upgrade retains published sequence floor and durable event deltas',()=>{
  const store=storeFixture();
  store.appendEvent({runId:'r',kind:'hud_frame',payload:{seq:100,input:{kind:'agent.register',agentId:'a',at:'2026-11-12T00:00:00Z'}}});
  const hud=new HudProjection(store),binding={id:'a',runId:'r'};
  assert.equal(hud.snapshot('r').seq,100);
  hud.observe(binding,{type:'turn/start',seq:50,data:{turn:1}});
  const before=hud.snapshot('r').seq;
  const restarted=new HudProjection(store);
  assert.ok(restarted.snapshot('r').seq>before);
  const events=restarted.snapshot('r').events;
  assert.equal(new Set(events.map(e=>e.seq)).size,events.length);
});
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
  hud.syncQuestions(binding,{active:[{callId:'q',state:'open'}]});
  send('tool/result',{message:{toolCallId:'q',content:[{type:'text',text:'{"pending":true,"private":"SECRET"}'}]}},3);
  send('turn/end',{turn:1,reason:{kind:'completed'}},4);
  assert.equal(hud.snapshot('r').agents[0].state,'waiting-human');
  send('user/message',{source:{kind:'user-question-reply',callId:'q'},content:'PRIVATE_ANSWER'},5);
  hud.syncQuestions(binding,{active:[]});
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
