/** Local source feeds the unchanged Engine admission/assignment path; replies stay in SQLite. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { key, liveTicket, threadKey, type AssessmentOutcome, type Candidate, type Ticket, type Trigger } from '../core/index.ts'
import type { Store } from './store.ts'
import type { SourceKind } from '../sources/kind.ts'
import { MAX_LOCAL_WORKSPACE_FILE_BYTES, stageLocalArtifact, validateArtifactPaths, type LocalArtifactReceipt } from './local-artifacts.ts'

export const WEB_CONSULTATION_PROTOCOL = 1
export const MAX_LOCAL_WORKSPACE_BYTES = 512 * 1024
export const MAX_LOCAL_TASK_BODY_BYTES = 6 * MAX_LOCAL_WORKSPACE_BYTES + 160 * 1024
const MAX_BROWSER_ADVICE_BYTES = 4096
const LocalRequestId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{7,99}$/)
const LocalPrompt = z.string().trim().min(1).max(20000)
const ArtifactPaths = z.array(z.string()).min(1).max(12).refine(validateArtifactPaths, 'Use unique relative workspace file paths')
const WorkspaceFiles = z.array(z.object({
  path: z.string(),
  text: z.string().refine(text => text.isWellFormed() && !text.includes('\0') &&
    Buffer.byteLength(text) <= MAX_LOCAL_WORKSPACE_FILE_BYTES, 'Use UTF-8 text up to 180 KiB per file'),
}).strict()).min(1).max(12).refine(files => validateArtifactPaths(files.map(file => file.path)),
  'Use unique relative workspace file paths').refine(files => files.reduce((bytes, file) => bytes + Buffer.byteLength(file.text), 0) <=
    MAX_LOCAL_WORKSPACE_BYTES, 'Use up to 512 KiB of workspace files in total')
type WorkspaceFiles = z.infer<typeof WorkspaceFiles>

const ArtifactContract = z.object({ files: ArtifactPaths, inputs: ArtifactPaths.optional() }).strict().refine(({ files, inputs }) => {
  const paths = [...files, ...(inputs ?? [])].map(path => path.toLowerCase()).sort()
  return paths.every((path, index) => index === 0 || (path !== paths[index - 1] &&
    !paths.slice(0, index).some(parent => path.startsWith(parent + '/'))))
}, 'Workspace input and output paths must be separate')

export function localArtifactContract(trigger: Trigger | undefined) {
  if (!trigger || trigger.source !== 'local' || trigger.actor.source !== 'local' || trigger.actor.id !== 'owner' ||
      !trigger.human || trigger.addressed !== 'direct') return undefined
  const contract = ArtifactContract.safeParse(trigger.meta.artifactContract)
  return contract.success ? contract.data : undefined
}

export const LocalTaskSchema = z.object({
  requestId: LocalRequestId,
  prompt: LocalPrompt,
  outputFormat: z.enum(['text', 'json']).default('text'),
  artifactFiles: ArtifactPaths.optional(),
  artifactInputs: ArtifactPaths.optional(),
  workspaceFiles: WorkspaceFiles.optional(),
  directRoute: z.literal(true).optional(),
  webConsultationEnabled: z.literal(true).optional(),
  browserAdvice: z.string().trim().min(1).refine(
    text => text.isWellFormed() && Buffer.byteLength(text) <= MAX_BROWSER_ADVICE_BYTES,
    'Expected well-formed Markdown of at most 4096 UTF-8 bytes',
  ).optional(),
}).strict().refine(input => input.browserAdvice === undefined || input.webConsultationEnabled === true,
  { path: ['browserAdvice'], message: 'Browser advice requires web consultation opt-in' })
  .refine(input => input.artifactFiles ? input.outputFormat === 'text' &&
    ArtifactContract.safeParse({ files: input.artifactFiles, inputs: input.artifactInputs }).success : input.artifactInputs === undefined,
  { path: ['artifactFiles'], message: 'Workspace files require text delivery and separate input and output paths' })
  .refine(input => !input.workspaceFiles || !!input.artifactFiles && input.workspaceFiles.every(file =>
    input.artifactFiles?.includes(file.path) || input.artifactInputs?.includes(file.path)),
  { path: ['workspaceFiles'], message: 'Declare every uploaded path in artifactFiles or artifactInputs' })

export type LocalTaskInput = z.input<typeof LocalTaskSchema>
export class LocalTaskConflict extends Error {}
export class LocalTaskWebUnavailable extends Error {}
const LocalAppendSchema = z.object({ requestId: LocalRequestId, prompt: LocalPrompt,
  afterReplyId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/).optional(),
}).strict()
export type LocalAppendInput = z.input<typeof LocalAppendSchema>

const appendId = (ticketId: string, requestId: string) => `local-append-${key(ticketId, requestId)}`

/** Only the dedicated local action uses this marker. Text and ordinary follow-ups never disable the coordinator path. */
export function localAppendTarget(trigger: Trigger): string | undefined {
  const { localAppend, requestId } = trigger.meta
  if (trigger.source === 'local' && trigger.actor.source === 'local' && trigger.actor.id === 'owner' &&
      trigger.human && trigger.addressed === 'direct' && typeof localAppend === 'string' &&
      typeof requestId === 'string' && trigger.id === appendId(localAppend, requestId)) return localAppend
}

export function localAppendTrigger(ticketId: string, input: unknown, store: Pick<Store, 'tickets' | 'threads' | 'triggers'>,
  isCurrentIssuedReply?: (ticket: Ticket, replyId: string) => boolean): Trigger {
  const { requestId, prompt, afterReplyId } = LocalAppendSchema.parse(input)
  const ticket = store.tickets.get(ticketId)
  const original = ticket && store.triggers.get(ticket.origin.triggerId)
  const channel = original?.channel
  const thread = original?.threads[0]
  if (!ticket || ticket.origin.triggerIds.length !== 1 || !original || original.source !== 'local' ||
      original.actor.source !== 'local' || original.actor.id !== 'owner' || !original.human || original.addressed !== 'direct' ||
      !thread || thread.source !== 'local' || original.threads.length !== 1 || channel?.source !== 'local' ||
      channel.thread !== thread.id || original.meta.requestId !== thread.id || channel.address.requestId !== thread.id ||
      original.id !== `local-${key(thread.id)}`) throw new LocalTaskConflict('The ticket is not a local owner task')
  const id = appendId(ticketId, requestId)
  const prior = store.triggers.get(id)
  if (prior) {
    if (prior.text !== prompt || localAppendTarget(prior) !== ticketId || prior.meta.localAppendAfterReplyId !== afterReplyId) {
      throw new LocalTaskConflict('Local follow-up requestId reused with different content')
    }
    return prior
  }
  const subscription = store.threads.get(threadKey(thread))
  const completed = ticket.ended?.outcome === 'completed' && ticket.ended.by === 'executor'
  if ((!liveTicket(ticket) && !completed) ||
      subscription?.subscriptions.length !== 1 || subscription.subscriptions[0] !== ticketId ||
      subscription.context?.includes(ticketId)) throw new LocalTaskConflict('The ticket cannot receive an exclusive local follow-up')
  if (afterReplyId !== undefined) {
    // The predecessor can be consumed only once, including while a paused Engine has not resumed the ticket yet.
    const consumed = ticket.inputs.some(input => {
      if (input.kind !== 'trigger') return false
      const accepted = store.triggers.get(input.triggerId)
      return accepted && localAppendTarget(accepted) === ticketId && accepted.meta.localAppendAfterReplyId === afterReplyId
    })
    if (!completed || consumed || !isCurrentIssuedReply?.(ticket, afterReplyId)) {
      throw new LocalTaskConflict('Serial follow-up requires the current issued reply of a completed task')
    }
  }
  return { id, source: 'local', threads: [thread], actor: original.actor, human: true, addressed: 'direct',
    at: new Date().toISOString(), text: prompt, channel,
    meta: { requestId, localAppend: ticketId, outputFormat: original.meta.outputFormat ?? 'text',
      ...(afterReplyId !== undefined ? { localAppendAfterReplyId: afterReplyId } : {}) } }
}

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
  store.db.exec('CREATE TABLE IF NOT EXISTS local_workspace_staging(trigger_id TEXT PRIMARY KEY, ticket_id TEXT, content TEXT)')
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
  return localTaskSubmission(input, store, webCollaboration).trigger
}

function workspaceManifest(files: WorkspaceFiles): LocalArtifactReceipt[] {
  return files.map(({ path, text }) => ({ path, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

export function localTaskSubmission(input: unknown, store: Pick<Store, 'triggers'>, webCollaboration: boolean) {
  const { requestId, prompt, outputFormat, directRoute, webConsultationEnabled, browserAdvice,
    artifactFiles, artifactInputs, workspaceFiles } = LocalTaskSchema.parse(input)
  const contract = artifactFiles ? { files: artifactFiles, ...(artifactInputs ? { inputs: artifactInputs } : {}) } : undefined
  const manifest = workspaceFiles && workspaceManifest(workspaceFiles)
  if (webConsultationEnabled && !webCollaboration) throw new LocalTaskWebUnavailable('Web collaboration is disabled on this host')
  const id = `local-${key(requestId)}`
  const prior = store.triggers.get(id)
  if (prior) {
    if (prior.text !== prompt || (prior.meta.outputFormat ?? 'text') !== outputFormat ||
      (prior.meta.directRoute === true) !== (directRoute === true) ||
      (prior.meta.webConsultationEnabled === true) !== (webConsultationEnabled === true) ||
      browserAdviceOf(prior)?.text !== browserAdvice || !isDeepStrictEqual(localArtifactContract(prior), contract) ||
      !isDeepStrictEqual(prior.meta.workspaceManifest, manifest)) {
      throw new LocalTaskConflict('Local requestId reused with different content')
    }
    return { trigger: prior, reused: true }
  }
  const advice: BrowserAdvice | undefined = browserAdvice === undefined ? undefined :
    { schema: 1, kind: 'browser_advice', trust: 'unverified', text: browserAdvice }
  const trigger: Trigger = { id, source: 'local', threads: [{ source: 'local', id: requestId }], actor: { source: 'local', id: 'owner' },
    human: true, addressed: 'direct', at: new Date().toISOString(), text: prompt,
    channel: { source: 'local', thread: requestId, address: { requestId } },
    meta: { requestId, outputFormat, ...(webConsultationEnabled ? { webConsultationEnabled } : {}),
      ...(directRoute ? { directRoute } : {}),
      ...(contract ? { artifactContract: contract } : {}),
      ...(manifest ? { workspaceManifest: manifest } : {}),
      ...(advice ? { browserAdvice: advice } : {}) } }
  return { trigger, reused: false, workspaceFiles }
}

/** The authenticated submission stores these bytes in the same transaction as admission. */
export function queueLocalWorkspaceFiles(store: Pick<Store, 'db'>, triggerId: string, files: WorkspaceFiles): void {
  store.db.prepare('INSERT INTO local_workspace_staging(trigger_id, content) VALUES (?,?)').run(triggerId, JSON.stringify(files))
}

/** Materialize owner-supplied files before the worker Session is created. Keep only the ticket binding afterwards. */
export function stageLocalWorkspaceFiles(store: Pick<Store, 'db'>, trigger: Trigger, ticketId: string, directory: string): void {
  if (!localArtifactContract(trigger) || trigger.meta.workspaceManifest === undefined) return
  const row = store.db.prepare('SELECT ticket_id, content FROM local_workspace_staging WHERE trigger_id=?').get(trigger.id)
  if (!row || (row.ticket_id && row.ticket_id !== ticketId)) throw new Error('Uploaded files are unavailable for this workspace')
  if (row.content === null) return
  const files = WorkspaceFiles.parse(JSON.parse(String(row.content)))
  if (!isDeepStrictEqual(trigger.meta.workspaceManifest, workspaceManifest(files))) throw new Error('Uploaded files no longer match the submitted task')
  if (!row.ticket_id) store.db.prepare('UPDATE local_workspace_staging SET ticket_id=? WHERE trigger_id=?').run(ticketId, trigger.id)
  for (const { path, text } of files) stageLocalArtifact(directory, path, text)
  store.db.prepare('UPDATE local_workspace_staging SET content=NULL WHERE trigger_id=?').run(trigger.id)
}

/** The API opt-in declares a new local task. The Engine has already applied the admission gate to this candidate. */
export function localDirectOutcome(candidate: Candidate): Extract<AssessmentOutcome, { kind: 'accept' }> | undefined {
  if (candidate.strength !== 'explicit' || candidate.triggers.length !== 1 || candidate.tickets.length) return undefined
  const [trigger] = candidate.triggers
  if (!trigger || trigger.source !== 'local' || trigger.meta.directRoute !== true || !trigger.human ||
      trigger.actor.source !== 'local' || trigger.actor.id !== 'owner' || trigger.addressed !== 'direct') return undefined
  const requestId = trigger.meta.requestId
  if (typeof requestId !== 'string' || trigger.id !== `local-${key(requestId)}` || trigger.threads.length !== 1 ||
      candidate.thread.ref.source !== 'local' || candidate.thread.ref.id !== requestId ||
      trigger.channel?.source !== 'local' || trigger.channel.thread !== requestId ||
      trigger.channel.address.requestId !== requestId) return undefined
  const title = Array.from(trigger.text.split(/\r?\n/u, 1)[0]!.trim()).slice(0, 80).join('') || 'Local task'
  return { kind: 'accept', title, scope: title, name: 'local-task', acknowledgement: 'Local task accepted.',
    reason: 'Explicit new task submitted through the authenticated local endpoint',
    audit: { route: 'local-direct' } }
}
