/** Index exact Markdown level-two sections. Other text stays in the original source. */
export function extractSections(text, limit = 12) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024 || limit < 1) return [];
  const sections = [];
  let cursor = 0, active = null, fence = null;
  function finish(end) {
    if (!active || sections.length >= limit) return;
    const raw = text.slice(active.start, end);
    if (!text.slice(active.body, end).trim()) return;
    sections.push({ title: active.title, raw, startByte: Buffer.byteLength(text.slice(0, active.start)),
      endByte: Buffer.byteLength(text.slice(0, end)) });
  }
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)) {
    const line = match[0].replace(/[\r\n]+$/u, '');
    const marker = /^ {0,3}([~]{3,}|\x60{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker) {
      fence = marker[1];
    } else if (/^ {0,3}#{1,2}(?:[ \t]|$)/u.test(line)) {
      finish(cursor);
      const heading = /^ {0,3}##[ \t]+(.+?)\s*$/u.exec(line);
      const title = heading?.[1].replace(/[ \t]+#+$/u, '').trim();
      active = title ? { title: Array.from(title).slice(0, 72).join(''), start: cursor, body: cursor + match[0].length } : null;
      if (sections.length >= limit) break;
    }
    cursor += match[0].length;
  }
  finish(cursor);
  return sections;
}

/** Return the exact preceding text only when the indexed sections cover the entire suffix. */
export function extractSectionPreamble(text, sections) {
  if (sections.length < 2 || !text.isWellFormed()) return null;
  const endByte = sections[0].startByte;
  const maxBytes = 2048;
  if (endByte === 0 || endByte > maxBytes) return null;
  let cursor = endByte;
  for (const section of sections) {
    if (section.startByte !== cursor) return null;
    cursor = section.endByte;
  }
  const source = Buffer.from(text, 'utf8');
  if (cursor !== source.length) return null;
  const preamble = source.subarray(0, endByte).toString('utf8');
  return preamble.trim() && Buffer.byteLength(JSON.stringify(preamble)) <= maxBytes ? preamble : null;
}
