import { z } from 'zod'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CollabBridge } from '../collab-bridge.ts'
import { readLocalArtifact, writeLocalArtifact } from '../local-artifacts.ts'
import { tool } from './tool.ts'

type ArtifactBridge = Pick<CollabBridge, 'localArtifactWorkspace' | 'localArtifactEvidence' | 'submitLocalArtifact' | 'pendingLocalReview'>

export function localArtifactTools(bridge: ArtifactBridge | undefined, ticketId: string) {
  const contract = bridge?.localArtifactWorkspace?.(ticketId)
  if (!bridge || !contract) return []
  const pathSchema = z.enum([...contract.files, ...contract.inputs])
  const outputPath = z.enum(contract.files)
  const workspace = (execution: ToolRunContext | undefined) => {
    const scope = execution && bridge.localArtifactWorkspace(ticketId, execution)
    if (!scope) throw new Error('Workspace tools require the current authorized worker assignment')
    return scope
  }
  const content = z.string().max(20 * 1024)
  const anchor = z.string().min(1).max(8000)
  return [
    tool({ name: 'artifact_list', description: 'List the declared output and read-only input paths for this ticket workspace.',
      schema: z.object({}).strict(), execute: async (_args, _signal, execution) => {
        const { files, inputs } = workspace(execution)
        const evidence = bridge.localArtifactEvidence(ticketId, execution)
        return { editable: files, inputs, files: [...evidence.files, ...evidence.inputs] }
      } }),
    tool({ name: 'artifact_read', description: 'Read one bounded page of a declared workspace text file. Use next_offset for further pages.',
      schema: z.object({ path: pathSchema, offset: z.number().int().min(0).optional() }).strict(),
      execute: async ({ path, offset }, _signal, execution) => readLocalArtifact(workspace(execution).directory, path, offset) }),
    tool({ name: 'artifact_write', description: 'Update a declared output file. Use replace, append, one exact unique splice, or an atomic list of ordered exact splices. Inputs are read-only.',
      schema: z.object({ path: outputPath, content: content.optional(), mode: z.enum(['replace', 'append', 'splice']).optional(),
        anchor: anchor.optional(), splices: z.array(z.object({ anchor, content }).strict()).min(1).max(6).optional() }).strict(),
      execute: async ({ path, content, mode, anchor, splices }, _signal, execution) => {
        const { directory } = workspace(execution)
        if (bridge.pendingLocalReview(ticketId)) throw new Error('Wait for review before editing a submitted artifact')
        if (splices && (content !== undefined || mode || anchor)) throw new Error('Choose a single edit or a list of splices')
        if (!splices && content === undefined) throw new Error('An edit needs content or a list of splices')
        const edit = splices ? { splices } : { content: content!, ...(mode ? { mode } : {}), ...(anchor ? { anchor } : {}) }
        return { written: true, ...writeLocalArtifact(directory, path, edit) }
      } }),
    tool({ name: 'artifact_check', description: 'Verify the declared files exist and hash the current bytes. This checks file integrity. Include a concise summary of the behavior you checked. Set submit_for_review=true to hand in this exact revision and end your work turn.',
      schema: z.object({ submit_for_review: z.boolean().optional(), summary: z.string().trim().min(1).max(2000).optional() }).strict(),
      execute: async ({ submit_for_review, summary }, _signal, execution) => {
        const scope = workspace(execution)
        const evidence = bridge.localArtifactEvidence(ticketId, execution)
        if (!evidence.passed || !submit_for_review || !execution) return evidence
        const description = summary ?? `Prepared the workspace files for review: ${scope.files.join(', ')}.`
        const { reportId } = bridge.submitLocalArtifact(execution, ticketId, description)
        return { ...evidence, ready_submitted: true, report_id: reportId }
      } }),
  ]
}
