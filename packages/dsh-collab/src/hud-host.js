import { randomUUID } from 'node:crypto';
// PTC questions enter the durable view only after the sub-call returns.
const foreground = new WeakMap();
function requests(hud) {
  if(!foreground.has(hud)) foreground.set(hud,new Map());
  return foreground.get(hud);
}

/** Read the host's public structured view at its committed session cursor. */
export function syncHostQuestions(ctx, hud, binding, session, at, event) {
  const view = ctx.sessionProjections.snapshot(session, ['userQuestions']).values.userQuestions;
  if(!view) return;
  const active=new Map(view.active.map(question=>[question.callId,question]));
  const resultId=event?.type==='tool/result' ? event.data?.message?.toolCallId
    : event?.type==='tool/ptc-dispatch' ? event.data?.subCallId : null;
  for(const [key,request] of requests(hud)) {
    if(request.binding.id!==binding.id || request.binding.runId!==binding.runId) continue;
    if(hud.load(binding.runId).agents[binding.id]?.cancelled) {requests(hud).delete(key);continue;}
    if(request.settled) active.delete(request.callId);
    else if(!active.has(request.callId)) active.set(request.callId,{callId:request.callId});
    if(!request.waiting && resultId===request.callId) {
      requests(hud).delete(key);
      if(!request.settled && !view.active.some(q=>q.callId===request.callId)) active.delete(request.callId);
    }
  }
  hud.syncQuestions(binding,{active:[...active.values()]},at);
}

/** Observe structured requests before the UI answerer, without changing its answer or error. */
export function installBlockingAttention(ctx, manager, isClosed) {
  return ctx.on('user-questions/request', async (request, next) => {
    const binding = request.agent && manager.binding(request.agent.id);
    if (!binding || isClosed()) return next();
    const callId=request.wait?.callId;
    const attentionId = callId ? `question:${callId}` : `foreground:${randomUUID()}`;
    const record={binding,callId,waiting:true,settled:false};
    if(callId) requests(manager.hud).set(record,record);
    const emit = kind => {
      if (!isClosed()) manager.hud.accept(binding.runId, {
        kind, attentionId, agentId:binding.id, at:new Date().toISOString(),
      });
    };
    emit('attention.raised');
    let continued=false;
    try { return await next(); }
    catch(error) {
      continued=!!callId && ['ASK_TIMED_OUT','NO_PROVIDER'].includes(error?.code ?? request.signal?.reason?.code);
      throw error;
    } finally {
      record.waiting=false;record.settled=!continued;
      if(!continued) emit('attention.resolved');
    }
  }, {prepend:true, global:true});
}
