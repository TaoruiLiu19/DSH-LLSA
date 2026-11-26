import { isDeepStrictEqual } from 'node:util'
import type { CollabBridge } from './collab-bridge.ts'
import { localArtifactReceipts, readLocalArtifactBytes, type LocalArtifactReceipt } from './local-artifacts.ts'

type ArtifactPort = Pick<CollabBridge, 'localArtifactWorkspace' | 'localArtifactEvidence' | 'issuedLocalArtifactEvidence'>
type Workspace = NonNullable<ReturnType<ArtifactPort['localArtifactWorkspace']>>
type Output = { path: string; status: 'missing' } |
  (LocalArtifactReceipt & { status: 'delivered' | 'draft' })

export class LocalArtifactDownloadError extends Error {
  constructor(readonly status: 404 | 409, message: string) { super(message) }
}

export class LocalArtifactDownload {
  constructor(readonly path: string, readonly content: Buffer, readonly disposition: 'delivered' | 'draft') {}
}

function workspaceReceipts(bridge: ArtifactPort, ticketId: string, workspace: Workspace) {
  try {
    const snapshot = bridge.localArtifactEvidence(ticketId)
    const issued = snapshot.passed ? bridge.issuedLocalArtifactEvidence(ticketId) : undefined
    const issuedReplyId = issued && isDeepStrictEqual(snapshot, issued.evidence) ? issued.replyId : undefined
    return { files: snapshot.files, issuedReplyId }
  } catch {
    // A missing, unsafe or unreadable sibling must not hide saved output that can still be downloaded as a draft.
    const files = workspace.files.flatMap(path => {
      try { return localArtifactReceipts(workspace.directory, [path]) } catch { return [] }
    })
    return { files, issuedReplyId: undefined }
  }
}

export function localArtifactDownloadView(bridge: ArtifactPort, ticketId: string) {
  const workspace = bridge.localArtifactWorkspace(ticketId)
  if (!workspace) return
  const { files, issuedReplyId } = workspaceReceipts(bridge, ticketId, workspace)
  const outputs = workspace.files.map((path): Output => {
    const file = files.find(item => item.path === path)
    return file ? { ...file, status: issuedReplyId ? 'delivered' : 'draft' } : { path, status: 'missing' }
  })
  return { artifactWorkspace: { directory: workspace.directory, files: workspace.files, outputs }, issuedReplyId }
}

export function downloadLocalArtifact(bridge: ArtifactPort, ticketId: string, path: string, allowDraft: boolean, sha256?: string) {
  const workspace = bridge.localArtifactWorkspace(ticketId)
  if (!workspace?.files.includes(path)) throw new LocalArtifactDownloadError(404, 'Output file not found')
  let file: ReturnType<typeof readLocalArtifactBytes>
  try { file = readLocalArtifactBytes(workspace.directory, path) } catch { /* Unsafe and inaccessible files are never served. */ }
  if (!file) throw new LocalArtifactDownloadError(404, 'Output file not found')
  if (sha256 !== undefined && sha256 !== file.sha256)
    throw new LocalArtifactDownloadError(409, 'The saved file has changed. Refresh the task before downloading.')
  const { files, issuedReplyId } = workspaceReceipts(bridge, ticketId, workspace)
  const sameBytes = files.some(candidate => candidate.path === path && candidate.sha256 === file.sha256)
  if (!sameBytes) throw new LocalArtifactDownloadError(409, 'The saved file has changed. Refresh the task before downloading.')
  if (!issuedReplyId && !allowDraft) throw new LocalArtifactDownloadError(409, 'This version has not been delivered.')
  return new LocalArtifactDownload(path, file.content, issuedReplyId ? 'delivered' : 'draft')
}
