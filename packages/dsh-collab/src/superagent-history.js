/** Resolve native coordinator reads to the authorized ticket run, never to an arbitrary run ID. */
export function historyScope(manager,sessionId,{ticketId,assignmentId,eventId,stepId}={}){
 const binding=manager.binding(sessionId);if(!binding)throw Error('No managed history session');
 const bridge=manager.bridge,snapshot=bridge?.snapshot();
 const event=eventId?manager.store.getEvent(eventId):null;
 if(eventId&&!event)throw Error('Unknown history event');
 const eventRun=event?manager.store.getRun(event.runId):null;
 if(snapshot?.masterSessionId!==sessionId){
   const own=manager.store.getRun(binding.runId);
   if((ticketId&&ticketId!==own?.ticketId)||(assignmentId&&assignmentId!==own?.assignmentId)||(event&&event.runId!==binding.runId))throw Error('History is outside this session');
   return {runId:binding.runId,stepId:stepId??event?.stepId};
 }
 if(!ticketId&&(!event||event.runId===binding.runId))return {runId:binding.runId,stepId:stepId??event?.stepId};
 const target=ticketId??eventRun?.ticketId,row=snapshot.tickets.find(x=>x.ticket.id===target);
 if(!row)throw Error('Unknown native ticket');
 const assignment=assignmentId??eventRun?.assignmentId??row.assignmentId;
 if(!row.ticket.assignments.some(x=>x.id===assignment))throw Error('Unknown native assignment');
 const runId=`super-${target}-${assignment}`;
 if(event&&event.runId!==runId)throw Error('History event does not belong to this ticket assignment');
 if(!manager.store.getRun(runId))throw Error('Native task history unavailable');
 return {runId,stepId:stepId??event?.stepId};
}
