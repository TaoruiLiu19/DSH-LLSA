/** Local source feeds the unchanged Engine admission/assignment path; replies stay in SQLite. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import type { Store } from './store.ts'
import type { SourceKind } from '../sources/kind.ts'

export const LocalTaskSchema = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{7,99}$/), prompt: z.string().trim().min(1).max(20000), outputFormat:z.enum(['text','json']).default('text') }).strict()
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
export function localTrigger(input: unknown, store: Store): Trigger {
  const { requestId, prompt, outputFormat } = LocalTaskSchema.parse(input), id = `local-${key(requestId)}`
  const prior = store.triggers.get(id)
  if (prior) { if (prior.text !== prompt || (prior.meta.outputFormat??'text')!==outputFormat) throw new Error('Local requestId reused with different content'); return prior }
  return { id, source: 'local', threads: [{ source: 'local', id: requestId }], actor: { source: 'local', id: 'owner' },
    human: true, addressed: 'direct', at: new Date().toISOString(), text: prompt,
    channel: { source: 'local', thread: requestId, address: { requestId } }, meta: { requestId, outputFormat } }
}
