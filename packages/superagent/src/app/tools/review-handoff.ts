import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { key } from '../../core/index.ts'
import { messageId } from '../delivery.ts'

/** Check for a sole native relay and a sole tool in an open master turn without pending input. */
export function soleRelayForTool(agent: Agent, execution: ToolRunContext, toolName: string) {
  if (execution.agent !== agent || execution.parent || execution.signal.aborted ||
    agent.inbox.nextTurn.length || agent.inbox.nextStep.length) return
  const history = agent.session.snapshotEvents()
  const start = history.findLastIndex(event => event.type === 'turn/start')
  if (start < 0) return
  const events = history.slice(start + 1)
  if (events.some(event => event.type === 'turn/end')) return
  const assistant = events.findLast(event => event.type === 'assistant/message')
  const calls = assistant?.data.message.content.filter(block => block.type === 'tool-call')
  if (calls?.length !== 1 || calls[0]?.id !== execution.callId || calls[0].name !== toolName) return
  const requests = events.filter(event => event.type === 'user/message').filter(event => {
    // runtime-context is contributed by the loop plugin and is absent from the standalone LLM registry types.
    const source: {kind: string; form?: string} = event.data.source
    return source.kind !== 'runtime-context' || source.form !== 'snapshot'
  })
  const request = requests[0]?.data
  if (requests.length === 1 && request?.source.kind === 'dsh-superagent' && request.source.form === 'relay') return request
}

/** A rejected report can leave the master turn only when this execution owns its sole outstanding request. */
export function concludeSoleRejectedReview(agent: Agent, execution: ToolRunContext, relayId: string) {
  if (soleRelayForTool(agent, execution, 'orchestrator_collab_finish')?.id === messageId(key(relayId))) execution.concludeTurn()
}
