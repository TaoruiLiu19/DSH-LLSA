/** Deterministic display-only short names; never send a title to a model to shorten it. */
function clean(value) {
  if (typeof value !== 'string') return '';
  const text = value.normalize('NFKC')
    .replace(/```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)/g, ' ')
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>]+/gi, ' ')
    .replace(/[\w.+-]+@[\w.-]+\.[\p{L}]{2,}/gu, ' ')
    .replace(/["'](?:[A-Za-z]:[\\/]|\/|\\\\|\.\.?[\\/]|~\/)[^"'\r\n]*["']/g, ' ')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\.{0,2}\/|~\/)[^\s<>"']+/g, ' ')
    .replace(/\b[\w.-]+(?:[\\/][\w.-]+)+\b/g, ' ')
    .replace(/[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/gu, ' ')
    // Discard code-like clauses rather than expose their identifiers as display text.
    .replace(/(?:\b(?:const|let|var|return|import|function|class|def)\b|[{};=]|=>)[^\r\n]*/g, ' ')
    .replace(/\b[A-Za-z_$][\w.$]*\([^)]*\)/g, ' ')
    .replace(/(?<![\p{L}\p{N}])\p{N}+(?![\p{L}\p{N}])/gu, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, 12).join('').trim();
}

export function hudLabel({assignmentTitle, threadTitle, role} = {}) {
  const title = [assignmentTitle, threadTitle].find(value => typeof value === 'string' && value.trim());
  return clean(title) || clean(role) || '智能体';
}
