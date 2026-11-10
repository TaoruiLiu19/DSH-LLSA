/** Preserve a report's complete semantic fields; retain legacy text when a projection would cost more. */
export function projectBridgeReport(input, manager) {
  const payload={report_id:input.eventId,ticketId:input.ticketId,assignmentId:input.assignmentId,state:input.report.state,
    summary:input.report.summary,read:input.read};
  for(const key of ['question','answers']) if(input.report[key]!==undefined) payload[key]=input.report[key];
  if(input.reviewContext)payload.review_context=input.reviewContext;
  const selected=manager.select(payload,manager.backend?.modelProfile?.(manager.bridge?.snapshot().masterSessionId)??'unverified','generic');
  if(!manager.countTokens||manager.countTokens(selected.modelInput)>=manager.countTokens(input.relay.text)) return undefined;
  return {text:selected.modelInput,codec:selected.codec,version:String(selected.version??1)};
}
