import test from 'node:test';
import assert from 'node:assert/strict';
import {Context,Service} from '@deepseek-ai/cordis';
import Registry from '@deepseek-ai/dsh-session-projection';
import Questions from '@deepseek-ai/dsh-user-questions';
import {HudProjection} from '../src/hud-projection.js';
import {syncHostQuestions,installBlockingAttention} from '../src/hud-host.js';

async function fixture() {
  const ctx=new Context();new Registry(ctx);const questions=new Questions(ctx);
  await questions[Service.init]();
  const frames=[],log=[];
  const store={listRuns:()=>[],getAgents:()=>[],getRun:()=>({ticketId:'t'}),
    eventsByKind:(_run,kind)=>frames.filter(e=>e.kind===kind),appendEvent:e=>frames.push(structuredClone(e))};
  const hud=new HudProjection(store),binding={id:'a',runId:'r',role:'worker'};
  const session={id:'a',seq:0,header:{},inheritedEventCount:0,
    snapshotEvents:()=>log,eventAt:seq=>log[seq]};
  const send=(type,data)=>{
    const event={type,data,seq:session.seq++,time:Date.now()};log.push(event);
    // Intentionally read before registry's eager callback: snapshot must catch up itself.
    hud.observe(binding,event);syncHostQuestions(ctx,hud,binding,session,undefined,event);
  };
  const state=()=>hud.snapshot('r').agents[0].state;
  return {ctx,hud,binding,session,send,state};
}

test('pinned Harness projection drives native questions through timeout, cross-turn reply and cancellation',async()=>{
  const {hud,send,state}=await fixture();
  send('turn/start',{turn:1});
  send('request/header',{header:{tools:[{name:'ask_user_question',parameters:{properties:{timeout:{type:'number'}}}}]}});
  send('tool/call',{callId:'q',name:'ask_user_question',arguments:JSON.stringify({questions:[{id:'choice',question:'PRIVATE'}]})});
  assert.equal(state(),'waiting-human');
  send('tool/result',{message:{toolCallId:'q',content:[{type:'text',text:JSON.stringify({pending:true,padding:'x'.repeat(70000)})}]}});
  send('turn/end',{turn:1,reason:{kind:'completed'}});
  assert.equal(state(),'waiting-human');
  send('turn/start',{turn:2});
  send('approval/asked',{id:'p'});
  send('user/message',{source:{kind:'user-question-reply',callId:'q'},content:[{type:'text',text:'{"answers":[]}'}]});
  assert.equal(state(),'waiting-human');
  send('approval/decided',{id:'p'});assert.equal(state(),'running');
  send('approval/asked',{id:'cancel'});
  send('turn/end',{turn:2,reason:{kind:'aborted'}});assert.equal(state(),'idle');
  send('approval/asked',{id:'late-unseen'});assert.equal(state(),'idle');
  assert.deepEqual(hud.load('r').agents.a.attention,[]);
  assert.doesNotMatch(JSON.stringify(hud.snapshot('r')),/PRIVATE|padding|answers/);
});

test('PTC timed foreground wait hands off to host projection without a false running pulse',async()=>{
  const {ctx,hud,binding,send,state}=await fixture();
  let handler;
  installBlockingAttention({on:(_name,fn)=>{handler=fn;}},{hud,binding:()=>binding},()=>false);
  send('turn/start',{turn:1});
  let rejectWait;
  const pending=handler({agent:{id:'a'},wait:{callId:'ptc',timed:true}},()=>new Promise((_resolve,reject)=>{rejectWait=reject;}));
  assert.equal(state(),'waiting-human');
  // A separate committed event must not erase a foreground PTC wait.
  send('tool/call',{callId:'other',name:'read'});assert.equal(state(),'waiting-human');
  rejectWait(Object.assign(new Error('timed wait expired'),{code:'ASK_TIMED_OUT'}));
  await assert.rejects(pending);
  const seq=hud.snapshot('r').seq;
  send('tool/ptc-dispatch',{name:'ask_user_question',subCallId:'ptc',arguments:{questions:[{id:'q',question:'PRIVATE'}]},content:[{type:'text',text:'{"pending":true}'}]});
  assert.equal(state(),'waiting-human');assert.equal(hud.snapshot('r').seq,seq);
  send('tool/result',{message:{toolCallId:'other',content:[]}});
  send('turn/end',{turn:1,reason:{kind:'completed'}});assert.equal(state(),'waiting-human');
  send('user/message',{source:{kind:'user-question-reply',callId:'ptc'},content:[]});assert.equal(state(),'idle');
  assert.equal(hud.snapshot('r').events.filter(e=>e.kind==='attention.raised').length,1);
});
