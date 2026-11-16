/** Local source feeds the unchanged Engine admission/assignment path; replies stay in SQLite. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import type { Store } from './store.ts'
import type { SourceKind } from '../sources/kind.ts'

export const WEB_CONSULTATION_PROTOCOL = 1
const MAX_BROWSER_ADVICE_BYTES = 4096

export const LocalTaskSchema = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{7,99}$/),
  prompt: z.string().trim().min(1).max(20000),
  outputFormat: z.enum(['text', 'json']).default('text'),
  webConsultationEnabled: z.literal(true).optional(),
  browserAdvice: z.string().trim().min(1).refine(
    text => text.isWellFormed() && Buffer.byteLength(text) <= MAX_BROWSER_ADVICE_BYTES,
    'Expected well-formed Markdown of at most 4096 UTF-8 bytes',
  ).optional(),
}).strict().refine(input => input.browserAdvice === undefined || input.webConsultationEnabled === true,
  { path: ['browserAdvice'], message: 'Browser advice requires web consultation opt-in' })

export type LocalTaskInput = z.input<typeof LocalTaskSchema>
export class LocalTaskConflict extends Error {}
export class LocalTaskWebUnavailable extends Error {}

interface BrowserAdvice {
  readonly schema: 1
  readonly kind: 'browser_advice'
  readonly trust: 'unverified'
  readonly text: string
}

export function browserAdviceOf(trigger: Trigger): BrowserAdvice | undefined {
  if (trigger.source !== 'local' || trigger.meta.webConsultationEnabled !== true) return undefined
  const advice = trigger.meta.browserAdvice as Partial<BrowserAdvice> | undefined
  if (advice?.schema !== 1 || advice.kind !== 'browser_advice' || advice.trust !== 'unverified' ||
      typeof advice.text !== 'string') return undefined
  return advice as BrowserAdvice
}

export function browserAdviceReference(trigger: Trigger) {
  if (!browserAdviceOf(trigger)) return undefined
  return { read: `trigger/${trigger.id}/browser-advice`, trust: 'unverified' as const }
}
export function installLocalSource(store: Store): SourceKind {
  store.db.exec('CREATE TABLE IF NOT EXISTS collab_local_replies(id TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const settings = store.settings()
  const model={provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off'}
  if (!settings.sources.local) store.saveSettings({ ...settings, eval:{...settings.eval,model:settings.eval.model??model},executor:{...settings.executor,model:settings.executor.model??model},sources: { ...settings.sources, local: { enabled: true, config: {} } },
    policy: { ...settings.policy, sources: { ...settings.policy.sources, local: { allowed: [{ id: 'owner', name: 'Local user' }] } } } })
  return { kind: 'local', title: { zh: '本机任务', en: 'Local tasks' }, description: { zh: '仅处理本机提交的内容', en: 'User-provided content only' },
    schema: z.object({}).strict(), fields: [], health: [],
    channel: { link: () => ({ url: '', label: { zh: '本机记录', en: 'Local record' } }),
      async send(_host, message) { store.db.prepare('INSERT OR IGNORE INTO collab_local_replies VALUES (?,?)').run(message.id, JSON.stringify(message)); return 'sent' } } }
}
export function localTrigger(input: unknown, store: Pick<Store, 'triggers'>, webCollaboration = false): Trigger {
  const { requestId, prompt, outputFormat, webConsultationEnabled, browserAdvice } = LocalTaskSchema.parse(input)
  if (webConsultationEnabled && !webCollaboration) throw new LocalTaskWebUnavailable('Web collaboration is disabled on this host')
  const id = `local-${key(requestId)}`
  const prior = store.triggers.get(id)
  if (prior) {
    if (prior.text !== prompt || (prior.meta.outputFormat ?? 'text') !== outputFormat ||
      (prior.meta.webConsultationEnabled === true) !== (webConsultationEnabled === true) ||
      browserAdviceOf(prior)?.text !== browserAdvice) {
      throw new LocalTaskConflict('Local requestId reused with different content')
    }
    return prior
  }
  const advice: BrowserAdvice | undefined = browserAdvice === undefined ? undefined :
    { schema: 1, kind: 'browser_advice', trust: 'unverified', text: browserAdvice }
  return { id, source: 'local', threads: [{ source: 'local', id: requestId }], actor: { source: 'local', id: 'owner' },
    human: true, addressed: 'direct', at: new Date().toISOString(), text: prompt,
    channel: { source: 'local', thread: requestId, address: { requestId } },
    meta: { requestId, outputFormat, ...(webConsultationEnabled ? { webConsultationEnabled } : {}),
      ...(advice ? { browserAdvice: advice } : {}) } }
}
