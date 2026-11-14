/** Integrates with native Ticket/Assignment authority; does not create a parallel ticket scheduler. */
export function connectSuperagent(manager, bridge) {
  if (bridge.compatibility().apiVersion < 2 || typeof bridge.registerLifecycle !== 'function') return {dispose(){},assertSession(){},sync(){}};
  const store=manager.store;
  const masterId=bridge.snapshot().masterSessionId,oldPolicy=manager.toolPolicies.get(masterId);
  manager.setToolPolicy(masterId,['collab_status','collab_history','collab_read_evidence']);
  const bindWorker=(ticket,sessionId)=>{
    const assignment=ticket.assignments.at(-1);
    if (!assignment || ticket.ended) throw new Error('Superagent ticket has no live assignment');
    const binding = manager.bindRoot(sessionId,{runId:`super-${ticket.id}-${assignment.id}`,ticketId:ticket.id,assignmentId:assignment.id,title:ticket.title,
      assignmentTitle:ticket.execution?.name || ticket.title,...bridge.displayTitles?.(ticket.id)});
    if (typeof bridge.inputSnapshot === 'function') manager.syncNativeInput(binding.runId, bridge.inputSnapshot(ticket.id, assignment.id));
    // Persist visualization-only topology, without granting the coordinator child-tool authority.
    const coordinatorId=bridge.snapshot().masterSessionId;
    if(coordinatorId&&coordinatorId!==sessionId&&!store.eventsByKind(binding.runId,'agent_relation').some(e=>e.payload.parentId===coordinatorId&&e.payload.childId===sessionId)) {
      store.appendEvent({runId:binding.runId,stepId:'native-coordination',kind:'agent_relation',payload:{parentId:coordinatorId,childId:sessionId,provenance:'host_superagent_lifecycle'}});
      manager.hud.register(binding);
    }
    return binding;
  };
  const release=bridge.registerLifecycle({bindWorker,reviewState(ticket){
    const assignment=ticket.assignments.at(-1);const items=assignment?store.getWorkItems(`super-${ticket.id}-${assignment.id}`):[];
    return {assignmentId:assignment?.id??null,items:items.map(x=>{
      const computation=manager.computationReview(x.runId,x.id);
      return {id:x.id,state:x.state,resultEventId:x.resultEventId??null,stepId:x.resultEventId?store.getEvent(x.resultEventId)?.stepId??null:null,assessmentEventId:x.verificationEventId??null,...(computation?{computation}:{})};
    }),scope:'coordinator_assessment'};
  },beforeReady(ticket){
    const row=bridge.snapshot(ticket.id).tickets[0];if(!row)throw new Error('Unknown Superagent ticket');
    const binding=bindWorker(ticket,row.workerSessionId),items=store.getWorkItems(binding.runId);
    const unresolved=items.filter(item=>item.state!=='succeeded'&&!items.some(next=>next.retryOf===item.id&&next.state==='succeeded'));
    const stale = unresolved.filter(item => !manager.isCurrentInput(item));
    if (stale.length) throw new Error(`Inputs changed. Do not accept obsolete results or create unrelated replacements. Retry each listed work item with collab_delegate using retryOf and a current objective, then accept the new result: ${JSON.stringify(stale.map(item => ({ retryOf: item.id })))}`);
    if(unresolved.length)throw new Error(`Accept all delegated child results before reporting ready: ${unresolved.map(x=>x.id).join(', ')}`);
  }});
  function assertSession(sessionId){
    const b=manager.binding(sessionId);if(!b)return;
    const run=store.getRun(b.runId);if(run?.source!=='superagent'||run.id.startsWith('super-master-'))return;
    const current=bridge.snapshot(run.ticketId).tickets[0];
    if(!current||current.ticket.ended||current.assignmentId!==run.assignmentId)throw new Error('Superagent assignment ended or replaced; stale work is blocked');
    bindWorker(current.ticket, current.workerSessionId);
    if (b.parentId) {
      const item = store.getWorkItems(b.runId).find(item => item.childId === sessionId);
      if (!item || !manager.isCurrentInput(item)) throw new Error('Task input changed; this child must be retried with the current version');
    }
  }
  function sync(){
    const batch=bridge.readLifecycle(Number(store.sourceCursor('superagent-lifecycle')??0),200);
    for(const event of batch.events){
      const p=event.payload,ticket=p.ticket,ticketId=ticket?.id??p.ticketId;
      const assignmentId=p.event?.data?.assignmentId??ticket?.assignments?.at(-1)?.id??p.assignmentId;
      const master=bridge.snapshot().masterSessionId;
      const runId=ticketId&&assignmentId?`super-${ticketId}-${assignmentId}`:`super-master-${master}`;
      if(!store.getRun(runId))store.createRun({id:runId,source:'superagent',ticketId:ticketId??null,assignmentId:assignmentId??null,title:ticket?.title??'Superagent lifecycle',rootSessionId:ticketId?`worker-${ticketId}`:master});
      store.importSourceEvent({source:'superagent-lifecycle',sourceEventId:event.id,cursor:String(event.seq),event:{id:`source-${event.id}`,runId,stepId:event.id,attemptId:assignmentId??'root',kind:p.kind==='coordinator_review'?'superagent_review':'superagent_domain',payload:p}});
      const live = ticketId && bridge.snapshot(ticketId).tickets[0];
      if (live && !live.ticket.ended && live.assignmentId) bindWorker(live.ticket, live.workerSessionId);
      if(ticket?.ended){
        manager.pause(runId,true,'superagent_ticket_ended');
        for(const item of store.getWorkItems(runId).filter(x=>['ready','starting','running'].includes(x.state))) {
          const stop = item.csvWorkflow ? manager.interruptCsvWorkItem(runId,item.id) : manager.interrupt(runId,item.childId);
          void stop.catch(error=>{manager.lastError=error.message;});
        }
      }
    }
  }
  async function beforeRequest(sessionId,signal){
    assertSession(sessionId);const b=manager.binding(sessionId),run=b&&store.getRun(b.runId);
    if(!b||b.parentId||run?.source!=='superagent'||run.id.startsWith('super-master-'))return;
    const items=store.getWorkItems(b.runId);
    // A submitted prerequisite needs a parent assessment before dependent work can start.
    // Waiting for its queued dependants here would prevent that assessment forever.
    if(items.some(x=>x.state==='submitted'))return;
    const pending=items.filter(x=>['starting','running'].includes(x.state)
      || x.state==='ready'&&x.dependsOn.every(id=>items.find(prior=>prior.id===id)?.state==='succeeded'))
      .map(x=>manager.settlements.get(x.childId ?? x.attemptId)).filter(Boolean);
    if(pending.length){
      if(signal?.aborted)throw new Error('Superagent request cancelled');
      let abort;const cancelled=new Promise((_,reject)=>{abort=()=>reject(new Error('Superagent request cancelled'));signal?.addEventListener('abort',abort,{once:true});});
      try{await Promise.race([Promise.all(pending),cancelled]);}finally{signal?.removeEventListener('abort',abort);}
    }
    assertSession(sessionId);
  }
  return {dispose(){release();if(oldPolicy)manager.toolPolicies.set(masterId,oldPolicy);else manager.toolPolicies.delete(masterId);},assertSession,beforeRequest,sync};
}
