/** Keep ordinary reports smaller; bounded host proof can replace costly follow-up reads. */
export function projectBridgeReport(input, manager) {
  const payload={report_id:input.eventId,ticketId:input.ticketId,assignmentId:input.assignmentId,state:input.report.state,
    summary:input.report.summary,read:input.read};
  for(const key of ['question','answers']) if(input.report[key]!==undefined) payload[key]=input.report[key];
  if(input.reviewContext)payload.review_context=input.reviewContext;
  const selected=manager.select(payload,manager.backend?.modelProfile?.(manager.bridge?.snapshot().masterSessionId)??'unverified','generic');
  const proofs=input.reviewContext?.children?.items?.map(item=>item.computation).filter(proof=>proof?.contract&&proof?.result)??[];
  const boundedProof=proofs.length>0&&Buffer.byteLength(JSON.stringify(proofs))<=4096;
  // This is additional verified context, not equivalent-data compression. Its net cost is benchmarked.
  if(!boundedProof&&(!manager.countTokens||manager.countTokens(selected.modelInput)>=manager.countTokens(input.relay.text))) return undefined;
  return {text:selected.modelInput,codec:selected.codec,version:String(selected.version??1)};
}
