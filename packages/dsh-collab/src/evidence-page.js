/** Byte-addressed pages must not split a UTF-8 code point and silently change task data. */
export function readEvidencePage(manager, runId, ref, start, bytes) {
  const result = manager.readArtifact(runId, ref, { start, end: start + bytes + 3 });
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
