/** Byte-addressed pages must not split a UTF-8 code point and silently change task data. */
export function readTaskEvidence(manager, runId, attachment, args, sessionId, preferInspection = false) {
  if (args.contains) {
    if (!attachment) throw new Error('Exact line lookup requires an attached file reference.');
    return inspectAttachment(manager, runId, attachment, args.ref, args.contains, sessionId, args.start);
  }
  // A small source costs less to read once than to route through another agent.
  // Large sources stay opt-in; a reviewer can always inspect the exact original page.
  if (attachment && preferInspection && attachment.bytes > 4096 && args.mode !== 'page')
    return inspectAttachment(manager, runId, attachment, args.ref, undefined, sessionId, args.start);
  return readEvidencePage(manager, runId, args.ref, args.start, args.bytes, sessionId);
}

export function readEvidencePage(manager, runId, ref, start, bytes, sessionId = undefined) {
  const result = manager.readArtifact(runId, ref, { start, end: start + bytes + 3 }, sessionId);
  let end = Math.min(bytes, result.data.length);
  while (end < result.data.length && (result.data[end] & 0xc0) === 0x80) end++;
  const data = result.data.subarray(0, end);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { throw new Error('Invalid UTF-8 page boundary or binary artifact; use the supplied nextStart or download the original bytes.'); }
  return { ref, start, bytes: data.length, totalBytes: result.totalBytes,
    nextStart: start + data.length < result.totalBytes ? start + data.length : null,
    mediaType: result.mediaType, text };
}

/** Inspect bounded matching lines without copying an attachment into a parent's context. */
export function inspectAttachment(manager, runId, attachment, ref, contains, sessionId, start = 0) {
  if (!Number.isSafeInteger(start) || start < 0 || start > attachment.bytes) throw new Error('Invalid attachment byte cursor.');
  if (!contains) return { ref, label: attachment.label, totalBytes: attachment.bytes, bytes: 0, nextStart: null,
    introduction: attachment.introduction, hint: 'Use contains for matching lines, or mode=page with start and bytes to read exact original evidence. Delegate only if the task needs a separate check.' };
  const { data } = manager.readArtifact(runId, ref, {}, sessionId);
  const matches = [];
  let more = false, nextStart = null, lineNumber = 0;
  // The cursor is a byte offset, just like readEvidencePage. Keep original line numbers.
  let offset = 0;
  for (const match of data.toString('utf8').matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/g)) {
    const line = match[1], lineStart = offset;
    offset += Buffer.byteLength(match[0]);
    lineNumber++;
    if (lineStart < start) continue;
    const position = line.indexOf(contains);
    if (position < 0) continue;
    if (matches.length === 4) { more = true; nextStart = lineStart; break; }
    let excerptStart = Math.max(0, position - 192);
    let excerptEnd = Math.min(line.length, position + contains.length + 320);
    const lowSurrogateAt = offset => line.charCodeAt(offset) >= 0xdc00 && line.charCodeAt(offset) <= 0xdfff;
    if (excerptStart > 0 && lowSurrogateAt(excerptStart)) excerptStart--;
    if (excerptEnd < line.length && lowSurrogateAt(excerptEnd)) excerptEnd++;
    const excerpt = line.slice(excerptStart, excerptEnd);
    matches.push({ line: lineNumber, text: excerpt, start: lineStart + Buffer.byteLength(line.slice(0, excerptStart)),
      bytes: Buffer.byteLength(excerpt), clipped: excerptStart > 0 || excerptEnd < line.length });
  }
  return { ref, label: attachment.label, totalBytes: attachment.bytes, nextStart, more, matches,
    bytes: matches.reduce((sum, match) => sum + match.bytes, 0) };
}
