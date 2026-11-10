/** Passive history compatibility for Harness 0.2.1 inspect and 0.2.2 paged events. */
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
interface HistoryController {
  inspect?: (id: SessionId) => Promise<{ events: readonly SessionEvent[] }>
  events?: (request: { address:{kind:'session';sessionId:SessionId};throughSeq?:number;beforeSeq?:number;maxMessages:number }, signal:AbortSignal) => Promise<{
    cursor:number;hasMore:boolean;records:readonly {type:'event';event:SessionEvent & {seq:number}}[]
  }>
}
export async function readSessionEvents(controller:HistoryController,id:SessionId,signal:AbortSignal):Promise<readonly SessionEvent[]> {
  signal.throwIfAborted()
  if (!controller.events) {
    if (!controller.inspect) throw new Error('Session history API unavailable')
    return (await controller.inspect(id)).events
  }
  const pages:SessionEvent[][]=[];let throughSeq:number|undefined,beforeSeq:number|undefined
  for(let pageIndex=0;pageIndex<1000;pageIndex++) {
    signal.throwIfAborted()
    const page=await controller.events({address:{kind:'session',sessionId:id},throughSeq,beforeSeq,maxMessages:100},signal)
    throughSeq??=page.cursor
    const events=page.records.map(row=>row.event)
    pages.push(events)
    if(!page.hasMore)return pages.reverse().flat()
    const first=events[0]?.seq
    if(first===undefined||!Number.isSafeInteger(first)||first<0||(beforeSeq!==undefined&&first>=beforeSeq))throw new Error('Session history cursor did not advance')
    beforeSeq=first
  }
  throw new Error('Session history page limit exceeded; refusing incomplete history')
}
