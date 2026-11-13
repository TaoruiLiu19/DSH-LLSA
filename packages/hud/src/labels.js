/**
 * Display labels — the 13-case rule of `contracts/fixtures/hud-labels.json`.
 *
 * The orchestrator produces `agents[].label` itself, but the degraded source has
 * to name an agent from what DSH gives it (a run title, a role), and a label
 * must never leak a path, a URL, an address or a code identifier into the UI.
 * Ported verbatim from `packages/dsh-collab/src/hud-label.js` (same MIT-licensed
 * repository) so both sides answer the contract fixture identically.
 */

/** Strip everything that is not display text, then cap at 12 code points. */
export function cleanLabel(value) {
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

/**
 * The one label rule: the assignment title, else the thread title, else the
 * role, else 「智能体」.
 *
 * @param input.assignmentTitle - the run's own title, preferred.
 * @param input.threadTitle - the conversation title, the fallback.
 * @param input.role - the agent's role, the last resort.
 */
export function hudLabel({ assignmentTitle, threadTitle, role } = {}) {
  const title = [assignmentTitle, threadTitle].find(value => typeof value === 'string' && value.trim());
  return cleanLabel(title) || cleanLabel(role) || '智能体';
}
