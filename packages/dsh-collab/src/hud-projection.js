/** Server-owned HUD projection. Internal correlation keys never enter the public snapshot. */
const states = new Set(['idle','running','waiting-human','done','failed']);
const safeTool = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;
export function emptyHud() { return { seq:0, agents:{}, events:[] }; }

export function reduceHud(previous, input) {
  const next = structuredClone(previous);
  const emit = (kind, tool=null, extra={}) => {
    const event = {seq:++next.seq,agentId:input.agentId,kind,at:input.at,tool:safeTool(tool),...extra};
    next.events.push(event); return event;
  };
  let agent = Object.hasOwn(next.agents,input.agentId) ? next.agents[input.agentId] : null;
  if (!agent) {
    agent = {id:input.agentId,label:'',role:input.role ?? 'worker',parentId:input.parentId ?? null,
      ticketId:input.ticketId ?? null,state:'idle',since:input.at,lastEvent:null,turn:null,tools:{},attention:[],lastActivity:input.at};
    Object.defineProperty(next.agents,input.agentId,{value:agent,enumerable:true,writable:true,configurable:true});
  }
  if (input.role !== undefined) agent.role = input.role;
  if (input.parentId !== undefined) agent.parentId = input.parentId;
  if (input.ticketId !== undefined) agent.ticketId = input.ticketId;
  const change = (state, reason) => {
    if (!states.has(state) || state === agent.state) return;
    const from = agent.state; agent.state = state; agent.since = input.at;
    agent.lastEvent = emit('state.changed',null,{from,to:state,reason});
  };
  const activity = (kind, tool=null, extra={}) => { agent.lastActivity=input.at; agent.lastEvent=emit(kind,tool,extra); };
  const closeTools = () => {
    for (const name of Object.values(agent.tools)) activity('tool.end',name,{reason:'interrupted',synthetic:true});
    agent.tools={};
  };
  switch (input.kind) {
    case 'agent.register': activity('agent.register'); break;
    case 'turn.start':
      if (agent.turn === input.turn) break;
      if (agent.turn !== null) {closeTools();activity('turn.end',null,{reason:'superseded',synthetic:true});}
      agent.turn=input.turn; activity('turn.start'); change(agent.attention.length?'waiting-human':'running','turn_started'); break;
    case 'tool.start':
      if (agent.turn === null || Object.hasOwn(agent.tools,input.callId)) break;
      Object.defineProperty(agent.tools,input.callId,{value:safeTool(input.tool),enumerable:true,writable:true,configurable:true}); activity('tool.start',input.tool);
      if (input.tool === 'ask_user_question') {
        if (!agent.attention.includes(input.callId)) agent.attention.push(input.callId);
        activity('attention.raised'); change('waiting-human','question_pending');
      }
      break;
    case 'tool.end': {
      if (!Object.hasOwn(agent.tools,input.callId)) break;
      const name=agent.tools[input.callId];delete agent.tools[input.callId];activity('tool.end',name);
      if (name==='ask_user_question' && !input.pending) {
        agent.attention=agent.attention.filter(id=>id!==input.callId);activity('attention.resolved');
        change(agent.attention.length?'waiting-human':agent.turn!==null?'running':'idle','question_resolved');
      }
      break;
    }
    case 'attention.raised':
      if (agent.attention.includes(input.attentionId)) break;
      agent.attention.push(input.attentionId);activity('attention.raised');change('waiting-human','confirmation_pending');break;
    case 'attention.resolved':
      if (!agent.attention.includes(input.attentionId)) break;
      agent.attention=agent.attention.filter(id=>id!==input.attentionId);activity('attention.resolved');
      change(agent.attention.length?'waiting-human':agent.turn!==null?'running':'idle','confirmation_resolved');break;
    case 'turn.end':
      if (agent.turn === null || (input.turn !== undefined && input.turn !== agent.turn)) break;
      closeTools();agent.turn=null;activity('turn.end',null,{reason:input.outcome});
      if (input.outcome==='cancelled') {agent.attention=[];change('idle','cancelled');}
      else change(agent.attention.length?'waiting-human':input.outcome==='completed'?'done':input.outcome==='failed'?'failed':'idle','turn_ended');
      break;
    case 'agent.cancel':
    case 'agent.recovered':
      closeTools();
      if (agent.turn!==null) activity('turn.end',null,{reason:input.kind==='agent.recovered'?'process_restart':'cancelled',synthetic:true});
      agent.turn=null;agent.attention=[];activity(input.kind);change('idle',input.reason ?? 'cancelled');break;
    default: break;
  }
  // A bounded transport window; state and sequence always cover the full journal.
  next.events=next.events.slice(-256);
  return next;
}

export function hudSnapshot(state, now, stalledAfterMs=30000) {
  return {v:1,seq:state.seq,now,stalledAfterMs,eventsFromSeq:state.events[0]?.seq ?? state.seq,
    agents:Object.values(state.agents).map(a=>({id:a.id,label:a.label,role:a.role,parentId:a.parentId,ticketId:a.ticketId,
      state:a.state,since:a.since,stalled:a.state==='running' && Date.parse(now)-Date.parse(a.lastActivity)>stalledAfterMs,
      lastEvent:a.lastEvent ? {kind:a.lastEvent.kind,at:a.lastEvent.at,tool:a.lastEvent.tool} : null})),
    events:structuredClone(state.events)};
}

export class HudProjection {
  constructor(store, {now=()=>new Date().toISOString()}={}) {
    this.store=store;this.now=now;this.runs=new Map();this.seen=new Map();
    for (const run of store.listRuns()) {
      const state=this.load(run.id);
      for (const agent of Object.values(state.agents)) if (agent.turn!==null || Object.keys(agent.tools).length)
        this.accept(run.id,{kind:'agent.recovered',agentId:agent.id,at:now(),reason:'process_restart'});
      for(const binding of store.getAgents(run.id)) this.register(binding);
    }
  }
  load(runId) {
    if (this.runs.has(runId)) return this.runs.get(runId);
    let state=emptyHud();const seen=new Set();
    for (const frame of this.store.eventsByKind(runId,'hud_frame')) {
      state=reduceHud(state,frame.payload.input);
      if(frame.payload.sourceKey)seen.add(frame.payload.sourceKey);
    }
    this.runs.set(runId,state);this.seen.set(runId,seen);return state;
  }
  accept(runId, input, sourceKey=null) {
    const state=this.load(runId);
    if(sourceKey && this.seen.get(runId).has(sourceKey))return;
    const next=reduceHud(state,input);
    if(next.seq===state.seq)return;
    this.store.appendEvent({runId,stepId:'hud',kind:'hud_frame',payload:{input,sourceKey,seq:next.seq}});
    this.runs.set(runId,next);if(sourceKey)this.seen.get(runId).add(sourceKey);
  }
  register(binding) {
    const relation=this.store.eventsByKind(binding.runId,'agent_relation').find(e=>e.payload.childId===binding.id);
    if(relation)binding={...binding,parentId:relation.payload.parentId,role:'worker'};
    const old=this.load(binding.runId).agents[binding.id];
    if(old && old.parentId===(binding.parentId??null) && old.role===(binding.role??'worker'))return;
    this.accept(binding.runId,{kind:'agent.register',agentId:binding.id,role:binding.role??'worker',parentId:binding.parentId??null,
      ticketId:this.store.getRun(binding.runId)?.ticketId??null,at:this.now()});
  }
  observe(binding, event) {
    const data=event.data??{},at=Number.isFinite(event.time)?new Date(event.time).toISOString():this.now();
    let input;
    if(event.type==='turn/start')input={kind:'turn.start',turn:data.turn};
    if(event.type==='turn/end')input={kind:'turn.end',turn:data.turn,outcome:data.reason?.kind==='completed'?'completed':['error','timeout','max-tokens'].includes(data.reason?.kind)?'failed':data.reason?.kind==='aborted'?'cancelled':'idle'};
    if(event.type==='tool/call')input={kind:'tool.start',callId:data.callId,tool:safeTool(data.name)};
    if(event.type==='tool/result') {
      let pending=false;
      for(const block of data.message?.content??[]) if(block.type==='text' && typeof block.text==='string' && block.text.length<65536) {
        try {if(JSON.parse(block.text)?.pending===true)pending=true;}catch{}
      }
      input={kind:'tool.end',callId:data.message?.toolCallId??data.toolCallId??data.callId,pending};
    }
    if(event.type==='approval/asked')input={kind:'attention.raised',attentionId:`approval:${data.id}`};
    if(event.type==='approval/decided')input={kind:'attention.resolved',attentionId:`approval:${data.id}`};
    if(event.type==='user/message'&&data.source?.kind==='user-question-reply')input={kind:'attention.resolved',attentionId:data.source.callId};
    if(event.type==='tool/ptc-dispatch' && data.name==='ask_user_question' && !data.isError) {
      for(const block of data.content??[]) if(block.type==='text' && typeof block.text==='string' && block.text.length<65536) {
        try {if(JSON.parse(block.text)?.pending===true)input={kind:'attention.raised',attentionId:data.subCallId};}catch{}
      }
    }
    if(!input)return;
    this.register(binding);
    this.accept(binding.runId,{...input,agentId:binding.id,at},Number.isSafeInteger(event.seq)?`${binding.id}:${event.seq}`:null);
  }
  snapshot(runId) { return hudSnapshot(this.load(runId),this.now()); }
}
