import { randomUUID, createHash } from 'node:crypto';
import { freezeMessage } from '@deepseek-ai/dsh-llm';
import { parseExactJson } from './protocol.js';
import { executeComputation } from './computation.js';

const ROUTE = Object.freeze({provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off'});
const ACTIVE = new Set(['starting','running','stopping']);
const TERMINAL = new Set(['completed','failed','interrupted','needs_attention']);
const hash = text => createHash('sha256').update(text).digest('hex');
const clone = value => structuredClone(value);
const error = (status,code) => Object.assign(new Error(code),{status,code});
const exactJson = text => {
  try { return parseExactJson(text); }
  catch (failure) { throw error(400, /number|numeric|decimal|round|precision/i.test(failure.message)?'UNSUPPORTED_NUMBER':'INVALID_INPUT'); }
};
const checkKeys = (value,keys) => {
  if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(key=>!keys.includes(key)))throw error(400,'INVALID_INPUT');
};
const requestId = value => {
  if(typeof value!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._-]{7,99}$/.test(value))throw error(400,'INVALID_REQUEST_ID');
  return value;
};
const textOf = blocks => (blocks??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
const publicError = failure => {
  const status=failure?.status??failure?.failure?.status;
  if(status===401||status===403)return {code:'API_AUTH_ERROR'};
  if(status===429)return {code:'API_RATE_LIMIT'};
  if(['TOKEN_BUDGET','MONEY_BUDGET','MONEY_PRICE_MISSING','RUN_PAUSED'].includes(failure?.code))return {code:failure.code==='MONEY_PRICE_MISSING'?'MONEY_PRICE_MISSING':'BUDGET_LIMIT'};
  const code=failure?.code??failure?.message;
  return {code:/^(REQUEST_LIMIT|TASK_TIMEOUT|USER_INTERRUPTED|WORKSPACE_CLOSED|BUDGET_LIMIT|API_AUTH_ERROR|API_RATE_LIMIT)$/.test(code??'')?code:'TASK_FAILED'};
};

/** Single-user, explicit-action workspace. It never reads or stores API credentials. */
export class LocalWorkspace {
  constructor({manager,ctx,now=Date.now,maxRequests=12,maxOutputTokens=1024,taskDeadlineMs=180000,maxInputBytes=49152}={}) {
    this.manager=manager;this.ctx=ctx;this.now=now;this.jobs=new Map();this.byRun=new Map();this.requests=new Map();this.previews=new Map();this.previewCommits=new Map();
    this.limits={maxGenerationRequests:maxRequests,maxOutputTokens,taskDeadlineMs,maxInputBytes,maxConcurrentTasks:1};
    this.closing=false;this.closed=false;
    for(const run of manager.store.listRuns()) {
      const events=manager.describeRun(run.id).events;
      const created=events.find(event=>event.kind==='local_task_created');
      if(created) {
        const latest=events.filter(event=>event.kind==='local_task_status').at(-1);
        const job={...created.payload.job,...(latest?.payload.job??{}),modelCalls:events.filter(event=>event.kind==='local_model_admitted').length};
        if(!TERMINAL.has(job.status)) {job.status='needs_attention';job.error={code:'PREVIOUS_PROCESS_ENDED'};job.finishedAt=new Date(now()).toISOString();this._record(job,'local_task_status',{job:this._public(job)});}
        this._syncAgentState(job);
        this.jobs.set(job.id,job);this.byRun.set(job.runId,job);this.requests.set(created.payload.requestId,{kind:'task',hash:created.payload.inputHash,value:job.id});
      }
      for(const event of events.filter(event=>event.kind==='local_calculation_saved')) {
        this.requests.set(event.payload.requestId,{kind:'calculation',hash:event.payload.inputHash,value:event.payload.reply});
        this.previewCommits.set(event.payload.previewId,event.payload.reply);
      }
    }
  }
  _public(job) {
    return clone(Object.fromEntries(['id','runId','sessionId','status','prompt','startedAt','finishedAt','modelCalls','error','result','resultProvenance','recoveryNotice'].filter(key=>job[key]!==undefined).map(key=>[key,job[key]])));
  }
  _record(job,kind,payload) {
    if(this.closed)return null;
    const event=this.manager.store.appendEvent({runId:job.runId,stepId:'local-task',attemptId:'root',kind,payload});
    if(kind==='local_task_status')this._syncAgentState(job);
    return event;
  }
  _syncAgentState(job) {
    if(!TERMINAL.has(job.status))return;
    const binding=this.manager.binding(job.sessionId);
    if(!binding||binding.parentId||binding.runId!==job.runId)return;
    const state=job.status==='completed'?'settled':job.status==='needs_attention'?'unknown':job.status;
    if(binding.state===state&&binding.localTaskStatus===job.status)return;
    const updated=this.manager.store.saveAgent({...binding,state,localTaskStatus:job.status});this.manager.bindings.set(binding.id,updated);
  }
  _replay(id,kind,inputHash) {
    const prior=this.requests.get(id);if(!prior)return null;
    if(prior.kind!==kind||prior.hash!==inputHash)throw error(409,'IDEMPOTENCY_CONFLICT');
    return kind==='task'?this._public(this.jobs.get(prior.value)):clone(prior.value);
  }
  status() {
    return {available:!this.closing,calculationAvailable:!this.closing,model:ROUTE,scope:'provided-content',limits:this.limits,
      jobs:[...this.jobs.values()].slice(-50).reverse().map(job=>this._public(job))};
  }
  getTask(id) {const job=this.jobs.get(id);if(!job)throw error(404,'TASK_NOT_FOUND');return this._public(job);}
  async startTask(input) {
    checkKeys(input,['prompt','requestId']);if(this.closing)throw error(503,'WORKSPACE_CLOSED');
    const id=requestId(input.requestId);
    if(typeof input.prompt!=='string'||!input.prompt.trim())throw error(400,'INVALID_INPUT');
    const prompt=input.prompt.trim();if(Buffer.byteLength(prompt)>this.limits.maxInputBytes)throw error(413,'INPUT_TOO_LARGE');
    const inputHash=hash(prompt),replay=this._replay(id,'task',inputHash);if(replay)return replay;
    if([...this.jobs.values()].some(job=>!TERMINAL.has(job.status)))throw error(409,'TASK_BUSY');
    const job={id:`task-${randomUUID()}`,runId:`local-${randomUUID()}`,sessionId:`local-agent-${randomUUID()}`,status:'starting',prompt,startedAt:new Date(this.now()).toISOString(),modelCalls:0,controller:new AbortController()};
    this.manager.bindRoot(job.sessionId,{runId:job.runId,title:prompt.slice(0,70)});
    this.manager.setRunLimits(job.runId,{maxOutputTokens:this.limits.maxOutputTokens,maxRunTokens:Math.min(this.manager.maxRunTokens,60000)});
    const source=this.manager.store.putArtifact(prompt,{mediaType:'text/plain; charset=utf-8'});
    this._record(job,'local_task_created',{requestId:id,inputHash,artifactRef:source.id,job:this._public(job),scope:'provided-content',limits:this.limits});
    this.jobs.set(job.id,job);this.byRun.set(job.runId,job);this.requests.set(id,{kind:'task',hash:inputHash,value:job.id});
    job.promise=this._run(job);
    return this._public(job);
  }
  _owner(sessionId) {const binding=this.manager.binding(sessionId);return binding?this.byRun.get(binding.runId):null;}
  configureAgent(agent) {
    const job=this._owner(agent.id);if(!job||TERMINAL.has(job.status))return;
    // This product mode accepts pasted inputs and collaboration evidence, not filesystem/terminal actions.
    agent.ctx.tools.restrict({allow:[]});
    agent.ctx.systemPrompt.section({name:'local-workspace',order:10000,interpolate:false,text:
      'This is a single-user collaboration workspace for the user-provided content. Use collab tools to record public results. For exact calculations, persist the original data and bind a computation contract before delegating; prefer host completion. Review and accept completed child results explicitly. Publish a concise final result when finished. A host receipt validates only its named contract fields, not your interpretation. Do not claim that saved steps reveal private reasoning.'});
  }
  async beforeRequest(agent) {
    const job=this._owner(agent.id);if(!job)return;
    this._throwIfStopped(job);
    // Native child settlement delivers its result to the parent's inbox before resolving.
    // Waiting in the host avoids burning model calls on repeated status polling.
    if(!this.manager.binding(agent.id)?.parentId){
      const pending=this.manager.store.getWorkItems(job.runId).filter(item=>ACTIVE.has(item.state))
        .map(item=>this.manager.settlements.get(item.childId)).filter(Boolean);
      if(pending.length)await Promise.all(pending);
    }
    this._throwIfStopped(job);
  }
  /** Called synchronously before the plugin starts any downstream model stream. */
  admit(options) {
    const job=this._owner(options.sessionId);if(!job)return;
    if(TERMINAL.has(job.status)||job.controller?.signal.aborted||this.closing)throw error(409,'WORKSPACE_CLOSED');
    if(options.purpose!==undefined||options.provider!==ROUTE.provider||options.model!==ROUTE.model
      ||options.reasoningEffort!=='off'||!Number.isSafeInteger(options.maxTokens)||options.maxTokens<1||options.maxTokens>this.limits.maxOutputTokens)throw error(400,'REQUEST_OUTSIDE_LOCAL_TASK');
    if(job.modelCalls>=this.limits.maxGenerationRequests){job.failure={code:'REQUEST_LIMIT'};throw error(429,'REQUEST_LIMIT');}
    job.modelCalls++;
    this._record(job,'local_model_admitted',{sessionId:options.sessionId,index:job.modelCalls,provider:options.provider,model:options.model,maxTokens:options.maxTokens});
  }
  onAgentError(agent,failure) {
    const job=this._owner(agent?.id);if(!job||TERMINAL.has(job.status))return;
    job.failure??=publicError(failure);job.controller?.abort();void this._abortOwned(job);
  }
  async interruptTask(id) {
    const job=this.jobs.get(id);if(!job)throw error(404,'TASK_NOT_FOUND');
    if(TERMINAL.has(job.status))return this._public(job);
    job.userInterrupted=true;job.status='stopping';job.controller.abort();
    this._record(job,'local_task_status',{job:this._public(job)});await this._abortOwned(job);
    return this._public(job);
  }
  async _abortOwned(job) {
    if(job.abortPromise)return job.abortPromise;
    job.abortPromise=(async()=>{
      if(this.closed)return;
      this.manager.pause(job.runId,true,'local_task_stop');
      job.handle?.agent.cancel({kind:'user'});
      const owned=this.manager.store.getWorkItems(job.runId).filter(item=>ACTIVE.has(item.state));
      await Promise.allSettled(owned.map(item=>this.manager.interrupt(job.runId,item.childId)));
    })();
    return job.abortPromise;
  }
  _throwIfStopped(job) {if(job.controller.signal.aborted||job.failure)throw error(409,job.failure?.code??'USER_INTERRUPTED');}
  async _run(job) {
    const deadline=setTimeout(()=>{job.failure={code:'TASK_TIMEOUT'};job.controller.abort();void this._abortOwned(job);},this.limits.taskDeadlineMs);
    let finalStatus='failed';
    try {
      job.handle=await this.ctx.agents.create({sessionId:job.sessionId,meta:{cwd:process.cwd(),agentPreset:'standard'},agentOptions:{...ROUTE,maxTokens:this.limits.maxOutputTokens}});
      this._throwIfStopped(job);job.status='running';this._record(job,'local_task_status',{job:this._public(job)});
      job.handle.agent.followup(freezeMessage({id:`local-input-${randomUUID()}`,role:'user',source:{kind:'user'},content:[{type:'text',text:job.prompt}]}));
      let prior=-1,settled=false;
      for(let turn=0;turn<32;turn++) {
        await job.handle.agent.whenIdle();this._throwIfStopped(job);
        const children=this.manager.store.getWorkItems(job.runId);
        await Promise.all(children.map(item=>this.manager.settlements.get(item.childId)).filter(Boolean));this._throwIfStopped(job);
        await job.handle.agent.whenIdle();this._throwIfStopped(job);
        const sequence=this.manager.store.highWater(job.runId);
        if(sequence===prior&&!this.manager.store.getWorkItems(job.runId).some(item=>ACTIVE.has(item.state))){settled=true;break;}
        prior=sequence;
      }
      if(!settled)throw error(409,'TASK_FAILED');
      const view=this.manager.describeRun(job.runId);
      const final=view.events.findLast(event=>event.kind==='final_result'&&event.payload.actorId===job.sessionId);
      const output=textOf(job.handle.agent.session.deriveMessages().filter(message=>message.role==='assistant').at(-1)?.content);
      if(!final&&!output.trim())throw error(409,'TASK_FAILED');
      job.result=final?.payload.result??{summary:output};job.resultProvenance=final?.payload.provenance??'agent_claim';
      if(!final){const saved=this.manager.store.putArtifact(JSON.stringify(job.result),{mediaType:'application/json'});this._record(job,'local_model_result',{result:job.result,artifactRef:saved.id,provenance:'agent_claim'});}
      const unresolved=view.workItems.filter(item=>!['succeeded','rejected'].includes(item.state));
      finalStatus=unresolved.length?'needs_attention':'completed';
      if(unresolved.length)job.recoveryNotice='存在未验收、失败或中断的子任务。请先核对历史；系统不会自动重做。';
    }catch(failure){job.status='stopping';finalStatus=job.userInterrupted?'interrupted':'failed';job.error=job.userInterrupted?{code:'USER_INTERRUPTED'}:job.failure??publicError(failure);await this._abortOwned(job);}
    finally {
      clearTimeout(deadline);
      try{await job.handle?.dispose();}catch{finalStatus='needs_attention';job.error={code:'CLEANUP_UNCONFIRMED'};}
      job.status=finalStatus;
      job.finishedAt=new Date(this.now()).toISOString();this._record(job,'local_task_status',{job:this._public(job)});
    }
  }
  previewCalculation(input) {
    if(this.closing)throw error(503,'WORKSPACE_CLOSED');
    checkKeys(input,['rowsJSON','operation','field','filter','unit']);
    if(typeof input.rowsJSON!=='string'||Buffer.byteLength(input.rowsJSON)>this.limits.maxInputBytes)throw error(413,'INPUT_TOO_LARGE');
    if(!input.rowsJSON.isWellFormed())throw error(400,'INVALID_INPUT');
    if(!['sum','count'].includes(input.operation))throw error(400,'INVALID_INPUT');
    try {
      const rows=exactJson(input.rowsJSON);if(!Array.isArray(rows))throw error(400,'INVALID_INPUT');
      let filter=[];
      if(input.filter!==undefined){checkKeys(input.filter,['field','op','valueJSON']);if(typeof input.filter.valueJSON!=='string')throw error(400,'INVALID_INPUT');filter=[{field:input.filter.field,op:input.filter.op,value:exactJson(input.filter.valueJSON)}];}
      const operations=input.operation==='sum'?[{op:'sum',field:input.field,as:'total',unit:input.unit??'原始单位',filter:[]},{op:'count',as:'matchedRows',unit:'rows',filter:[]}]:[{op:'count',as:'matchedRows',unit:'rows',filter:[]}];
      const contract={version:'2',inputRef:`sha256:${hash(input.rowsJSON)}`,rowsPath:[],filter,operations,precision:'safe_integer',nullPolicy:'reject',deduplicate:false};
      const computed=executeComputation(contract,input.rowsJSON);
      for(const [id,preview]of this.previews)if(preview.expiresAt<=this.now())this.previews.delete(id);
      if(this.previews.size>=100)throw error(429,'TOO_MANY_PREVIEWS');
      const preview={id:`preview-${randomUUID()}`,expiresAt:this.now()+300000,raw:input.rowsJSON,contract,computed};this.previews.set(preview.id,preview);
      return {previewId:preview.id,expiresAt:new Date(preview.expiresAt).toISOString(),result:clone(computed.result),matchedRows:computed.selectedRows,inputRows:computed.inputRows,
        ruleSummary:{operation:input.operation,field:input.field??null,filter,unit:input.unit??'原始单位',precision:'安全整数',nullPolicy:'拒绝空数值'},modelCalls:0};
    }catch(failure){if(!failure.status)failure.status=400;throw failure;}
  }
  commitCalculation(input) {
    if(this.closing)throw error(503,'WORKSPACE_CLOSED');checkKeys(input,['previewId','requestId']);
    const id=requestId(input.requestId),inputHash=hash(JSON.stringify({previewId:input.previewId}));
    const replay=this._replay(id,'calculation',inputHash);if(replay)return replay;
    if(this.previewCommits.has(input.previewId))return clone(this.previewCommits.get(input.previewId));
    const preview=this.previews.get(input.previewId);if(!preview||preview.expiresAt<=this.now())throw error(409,'PREVIEW_EXPIRED');
    // Recompute the frozen server-side preview; request data can never replace its values.
    const computed=executeComputation(preview.contract,preview.raw);
    const runId=`calculation-${randomUUID()}`,store=this.manager.store;
    const artifact=store.putArtifact(preview.raw,{mediaType:'application/json'});
    if(artifact.id!==preview.contract.inputRef)throw error(500,'INPUT_HASH_MISMATCH');
    const events=[];
    const append=(kind,payload)=>{const event={id:randomUUID(),stepId:'calculation',attemptId:'root',kind,payload};events.push(event);return event;};
    append('local_calculation_input',{artifactRef:artifact.id,computation:preview.contract,modelCalls:0});
    const receipt=append('computation_receipt',{...computed,inputRef:artifact.id,provenance:'host_computation',scope:'explicit_contract_fields_only'});
    const resultArtifact=store.putArtifact(JSON.stringify(computed.result),{mediaType:'application/json'});
    const final=append('final_result',{result:computed.result,artifactRef:resultArtifact.id,provenance:'host_verified_fields',verification:{status:'passed',receiptId:receipt.id,contractHash:computed.contractHash,verifiedFields:Object.keys(computed.result),scope:'explicit_contract_fields_only'}});
    const reply={runId,eventId:final.id,result:clone(computed.result),modelCalls:0};
    append('local_calculation_saved',{requestId:id,inputHash,previewId:input.previewId,reply});
    store.createRunWithEvents({id:runId,ticketId:runId,assignmentId:'local-calculation',title:'本机精确计算',source:'local-calculation',kind:'host-computation',rootSessionId:null},events);
    this.requests.set(id,{kind:'calculation',hash:inputHash,value:reply});this.previewCommits.set(input.previewId,reply);this.previews.delete(input.previewId);
    return clone(reply);
  }
  async close() {
    this.closing=true;
    const jobs=[...this.jobs.values()].filter(job=>!TERMINAL.has(job.status));
    for(const job of jobs){job.failure={code:'WORKSPACE_CLOSED'};job.controller?.abort();void this._abortOwned(job);}
    let timer;
    await Promise.race([Promise.allSettled(jobs.map(job=>job.promise).filter(Boolean)),new Promise(resolve=>{timer=setTimeout(resolve,5000);})]);clearTimeout(timer);
    for(const job of jobs)if(!TERMINAL.has(job.status)){job.status='needs_attention';job.error={code:'SHUTDOWN_UNCONFIRMED'};this._record(job,'local_task_status',{job:this._public(job)});}
    this.closed=true;
  }
}
