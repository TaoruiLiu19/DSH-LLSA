import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const maxPaths = 12
export const MAX_LOCAL_WORKSPACE_FILE_BYTES = 180 * 1024
const maxEditBytes = 20 * 1024
const pageCharacters = 8000
const maxSplices = 6
const noFollow = constants.O_NOFOLLOW ?? 0
const windowsDevice = /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$/iu

export interface LocalArtifactReceipt { path: string; bytes: number; sha256: string }
interface ArtifactSplice { anchor: string; content: string }
export type LocalArtifactMutation = string | { content: string; mode?: 'replace' | 'append' | 'splice'; anchor?: string } |
  { splices: readonly ArtifactSplice[] }

function safePath(path: string): boolean {
  return typeof path === 'string' && path.length <= 180 && path === path.normalize('NFC') && path.split('/').every(part =>
    /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_. -]*$/u.test(part) && !/[. ]$/u.test(part) && !windowsDevice.test(part.split('.')[0]!.trimEnd()))
}

export function validateArtifactPaths(paths: readonly string[]): boolean {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > maxPaths) return false
  const distinct = new Set<string>()
  for (const path of paths) {
    if (!safePath(path)) return false
    distinct.add(path.toLowerCase())
  }
  return distinct.size === paths.length && [...distinct].every(path =>
    ![...distinct].some(other => other.startsWith(`${path}/`)))
}

function stats(path: string): Stats | null {
  try { return lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function workspaceRoot(directory: string): string {
  const absolute = resolve(directory)
  const entry = stats(absolute)
  if (!entry?.isDirectory() || entry.isSymbolicLink()) throw new Error('Artifact workspace must be a real directory')
  return realpathSync(absolute)
}

function sameObject(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameFile(left: Stats | null, right: Stats | null): boolean {
  if (!left || !right) return left === right
  return sameObject(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function locate(root: string, path: string, createParents = false) {
  if (!safePath(path)) throw new Error('Expected a safe relative artifact path')
  const segments = path.split('/')
  const name = segments.pop()!
  let directory = root
  for (const part of segments) {
    directory = join(directory, part)
    let entry = stats(directory)
    if (!entry && createParents) {
      try { mkdirSync(directory) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      entry = stats(directory)
    }
    if (!entry) return null
    if (!entry.isDirectory() || entry.isSymbolicLink() || relative(directory, realpathSync(directory))) {
      throw new Error('Artifact directories must stay within the workspace and cannot be links')
    }
  }
  const parent = stats(directory)
  if (!parent?.isDirectory() || parent.isSymbolicLink() || relative(directory, realpathSync(directory))) {
    throw new Error('Artifact parent is unavailable')
  }
  const target = join(directory, name)
  const file = stats(target)
  if (file && (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || relative(target, realpathSync(target)))) {
    throw new Error('Artifacts must be regular unlinked files')
  }
  return { target, parent, file }
}

function load(root: string, path: string): Buffer | null {
  const entry = locate(root, path)
  if (!entry?.file) return null
  if (entry.file.size > MAX_LOCAL_WORKSPACE_FILE_BYTES) throw new Error('Artifact exceeds the 180 KiB file limit')
  const fd = openSync(entry.target, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0))
  try {
    const opened = fstatSync(fd)
    const verified = locate(root, path)
    if (!opened.isFile() || opened.nlink !== 1 || !verified || !sameObject(entry.parent, verified.parent) ||
        !sameFile(opened, entry.file) || !sameFile(opened, verified.file)) throw new Error('Artifact changed while opening')
    const buffer = Buffer.alloc(opened.size)
    let received = 0
    while (received < buffer.length) {
      const length = readSync(fd, buffer, received, buffer.length - received, received)
      if (!length) break
      received += length
    }
    if (received !== buffer.length || !sameFile(opened, fstatSync(fd))) throw new Error('Artifact changed while reading')
    return buffer
  } finally { closeSync(fd) }
}

function receipt(path: string, content: Buffer): LocalArtifactReceipt {
  return { path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') }
}

function decodeText(bytes: Buffer): string {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch {
    throw new Error('Artifact is not UTF-8 text')
  }
  if (text.includes('\0')) throw new Error('Artifact is not UTF-8 text')
  return text
}

/** Downloads preserve the exact saved bytes, including a possible BOM and line endings. */
export function readLocalArtifactBytes(directory: string, path: string) {
  const content = load(workspaceRoot(directory), path)
  if (!content) return undefined
  return { ...receipt(path, content), content }
}

export function readLocalArtifact(directory: string, path: string, offset = 0, limit = pageCharacters) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Expected a nonnegative artifact read offset')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > pageCharacters) throw new Error('Expected a bounded artifact read size')
  const bytes = load(workspaceRoot(directory), path)
  if (!bytes) return { path, exists: false as const }
  const text = decodeText(bytes)
  if (offset > 0 && offset < text.length && /[\uDC00-\uDFFF]/u.test(text[offset]!)) throw new Error('Offset splits an artifact character')
  let end = Math.min(offset + limit, text.length)
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end]!)) end += end - offset === 1 ? 1 : -1
  return { ...receipt(path, bytes), exists: true as const, content: text.slice(offset, end), next_offset: end < text.length ? end : null }
}

function textBytes(content: unknown): number {
  if (typeof content !== 'string' || !content.isWellFormed() || content.includes('\0')) throw new Error('Artifact edits must be UTF-8 text')
  return Buffer.byteLength(content)
}

function spliceExact(previous: string, { anchor, content }: ArtifactSplice): string {
  if (typeof anchor !== 'string' || !anchor.length || anchor.length > pageCharacters || !anchor.isWellFormed() || anchor.includes('\0')) {
    throw new Error('Artifact splice requires a nonempty bounded anchor')
  }
  const start = previous.indexOf(anchor)
  if (start < 0 || previous.lastIndexOf(anchor) !== start) throw new Error('Artifact splice requires exactly one matching anchor')
  return previous.slice(0, start) + content + previous.slice(start + anchor.length)
}

function editedText(mutation: LocalArtifactMutation, previous: () => string): string {
  const edit = typeof mutation === 'string' ? { content: mutation } : mutation
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw new Error('Expected a single edit or a list of exact splices')
  if ('splices' in edit) {
    if (!Object.hasOwn(edit, 'splices') || Object.keys(edit).length !== 1 || !Array.isArray(edit.splices) ||
        edit.splices.length < 1 || edit.splices.length > maxSplices) {
      throw new Error('Expected one to six exact splices without other edit options')
    }
    let inserted = 0
    for (const item of edit.splices) {
      if (!item || !Object.hasOwn(item, 'anchor') || !Object.hasOwn(item, 'content') || Object.keys(item).length !== 2) {
        throw new Error('Expected exact splice anchor and content')
      }
      inserted += textBytes(item.content)
      if (inserted > maxEditBytes) throw new Error('Artifact edit exceeds the 20 KiB edit limit')
    }
    return edit.splices.reduce(spliceExact, previous())
  }
  const mode = edit.mode === undefined ? 'replace' : edit.mode
  if (!Object.hasOwn(edit, 'content') || !['replace', 'append', 'splice'].includes(mode) || (mode !== 'splice' && Object.hasOwn(edit, 'anchor')) ||
      Object.keys(edit).some(key => !['content', 'mode', 'anchor'].includes(key))) throw new Error('Invalid artifact edit mode or options')
  if (textBytes(edit.content) > maxEditBytes) throw new Error('Artifact edit exceeds the 20 KiB edit limit')
  if (mode === 'replace') return edit.content
  const current = previous()
  if (mode === 'append') return current + edit.content
  return spliceExact(current, { anchor: edit.anchor!, content: edit.content })
}

export function writeLocalArtifact(directory: string, path: string, mutation: LocalArtifactMutation): LocalArtifactReceipt {
  const root = workspaceRoot(directory)
  const before = locate(root, path)
  if (before?.file && before.file.size > MAX_LOCAL_WORKSPACE_FILE_BYTES) throw new Error('Artifact exceeds the 180 KiB file limit')
  const text = editedText(mutation, () => {
    const content = load(root, path)
    return content ? decodeText(content) : ''
  })
  return saveArtifact(root, path, before, text)
}

/** Staging after a partial restart may reuse identical files and cannot overwrite any existing bytes. */
export function stageLocalArtifact(directory: string, path: string, text: string): void {
  if (textBytes(text) > MAX_LOCAL_WORKSPACE_FILE_BYTES) throw new Error('Artifact exceeds the 180 KiB file limit')
  const root = workspaceRoot(directory)
  const before = locate(root, path)
  if (before?.file) {
    if (!load(root, path)?.equals(Buffer.from(text))) throw new Error('Uploaded file conflicts with an existing workspace file')
    return
  }
  saveArtifact(root, path, before, text)
}

function saveArtifact(root: string, path: string, before: ReturnType<typeof locate>, text: string): LocalArtifactReceipt {
  if (Buffer.byteLength(text) > MAX_LOCAL_WORKSPACE_FILE_BYTES) throw new Error('Artifact exceeds the 180 KiB file limit')
  const entry = locate(root, path, true)
  if (!entry || (before && !sameObject(before.parent, entry.parent)) || !sameFile(before?.file ?? null, entry.file)) {
    throw new Error('Artifact changed before writing')
  }
  const bytes = Buffer.from(text)
  const temp = join(dirname(entry.target), `.llsa-artifact-${randomUUID()}.tmp`)
  let pending = false
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600)
    pending = true
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    const current = locate(root, path)
    if (!current || !sameObject(entry.parent, current.parent) || !sameFile(entry.file, current.file)) {
      throw new Error('Artifact changed before writing')
    }
    renameSync(temp, entry.target)
    pending = false
    return receipt(path, bytes)
  } finally {
    if (pending) {
      // Leave the temporary file alone if its parent was replaced while writing.
      try {
        const parent = stats(dirname(temp))
        if (parent?.isDirectory() && !parent.isSymbolicLink() && sameObject(entry.parent, parent) &&
            !relative(dirname(temp), realpathSync(dirname(temp)))) unlinkSync(temp)
      } catch { /* Preserve the original write error. */ }
    }
  }
}

export function localArtifactReceipts(directory: string, paths: readonly string[]): LocalArtifactReceipt[] {
  if (Array.isArray(paths) && !paths.length) return []
  if (!validateArtifactPaths(paths)) throw new Error('Expected one to twelve unique relative artifact paths')
  const root = workspaceRoot(directory)
  return paths.flatMap(path => {
    const bytes = load(root, path)
    return bytes ? [receipt(path, bytes)] : []
  })
}
