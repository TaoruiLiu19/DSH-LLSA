import { isDeepStrictEqual } from 'node:util';
import { VERIFICATION_SCOPE } from './computation.js';

// Only a current, fully accepted one-to-one batch can share a rule in the review message.
// The durable report and individual evidence references remain the source for audit reads.
function sharedLookupReview(context, summary) {
  const sections = context?.sectionReview?.sections;
  const items = context?.children?.items;
  if (!Array.isArray(sections) || sections.length < 2 || !Array.isArray(items) ||
      items.length !== sections.length || context.version !== 1 || !context.inputVersion) return;

  const byEvent = new Map(items.map(item => [item.resultEventId, item]));
  if (byEvent.size !== sections.length || new Set(sections.map(section => section.resultEventId)).size !== sections.length) return;
  const results = [];
  let rule;
  for (const section of sections) {
    const item = byEvent.get(section.resultEventId);
    const proof = item?.computation;
    if (!section.resultEventId || !section.inputRef || item?.state !== 'succeeded' || item.discarded ||
        !item.assessmentEventId || !proof?.contract?.lookup || proof.modelCalls !== 0 ||
        proof.verificationScope !== VERIFICATION_SCOPE || !proof.receiptId || !proof.receiptRef ||
        proof.source?.binding !== 'exact_slice_of_current_input' || proof.source.inputVersion !== context.inputVersion ||
        proof.contract.inputRef !== section.inputRef || proof.contract.title !== section.title ||
        !proof.result || typeof proof.result !== 'object' || Array.isArray(proof.result)) return;
    rule ??= proof.contract.lookup;
    if (!isDeepStrictEqual(proof.contract.lookup, rule)) return;
    results.push(proof.result);
  }

  // Point into the proposed answer only when every host value, type and row position matches.
  // Keep the verified rows themselves if the report uses another shape or contains an error.
  let reportObject;
  try { reportObject = JSON.parse(summary); } catch { /* Free text has no addressable JSON field. */ }
  const fields = reportObject && typeof reportObject === 'object' && !Array.isArray(reportObject)
    ? Object.keys(reportObject).filter(key => isDeepStrictEqual(reportObject[key], results)) : [];
  const { items: _items, ...children } = context.children;
  return {
    ...context,
    children: { ...children, acceptedSections: items.length },
    sectionReview: {
      ...context.sectionReview, sharedLookup: rule, verificationScope: VERIFICATION_SCOPE,
      ...(fields.length === 1 ? { verifiedRowsInReportField: fields[0] } : { verifiedRowsInSectionOrder: results }),
    },
  };
}

/** The instruction already points to the same source. Leave its full metadata in the immutable report. */
function compactLocalSources(context) {
  if (context?.version !== 1 || typeof context.inputVersion !== 'string' ||
      !Array.isArray(context.sources) || !Array.isArray(context.instructionExcerpts)) return context;
  const instructionPaths = new Set(context.instructionExcerpts.map(item => item?.read));
  const sources = context.sources.filter(source => !(typeof source?.read === 'string' &&
    source.read.startsWith('trigger/') && source.read_tool === 'orchestrator_read' &&
    source.outputFormat === 'text' && instructionPaths.has(source.read)));
  if (sources.length === context.sources.length) return context;
  const { sources: _archived, ...rest } = context;
  return sources.length ? { ...rest, sources } : rest;
}

/** Select the shorter review relay while preserving the task, review decision and audit pointers. */
export function projectBridgeReport(input, manager) {
  // Only the host knows the destination. Worker text cannot claim a complete transport
  // or turn a source reference into an archive pointer. Completion covers the summary alone.
  const localFormat = input.report.state === 'ready' && typeof input.report.summary === 'string' &&
    input.read === 'ticket/' + input.ticketId + '/collab-report/' + input.eventId &&
    manager.bridge?.localReplyFormat?.(input.ticketId);
  const reportLocation = localFormat === 'json' || localFormat === 'text'
    ? { summary_complete: true, archive_read: input.read }
    : { read: input.read };
  const payload = {
    report_id: input.eventId, ticketId: input.ticketId, assignmentId: input.assignmentId,
    state: input.report.state, summary: input.report.summary, ...reportLocation,
  };
  for (const key of ['question', 'answers']) {
    if (input.report[key] !== undefined) payload[key] = input.report[key];
  }
  if (input.reviewContext) payload.review_context = localFormat === 'text' && !input.reviewContext.sectionReview
    ? compactLocalSources(input.reviewContext) : input.reviewContext;
  const profile = manager.backend?.modelProfile?.(manager.bridge?.snapshot().masterSessionId) ?? 'unverified';
  const selected = manager.select(payload, profile, 'generic');
  const compact = input.report.state === 'ready' && manager.countTokens &&
    sharedLookupReview(input.reviewContext, input.report.summary);
  if (compact) {
    const text = JSON.stringify({ ...payload, review_context: compact });
    const size = manager.countTokens(text);
    if (size < manager.countTokens(selected.modelInput) && size < manager.countTokens(input.relay.text)) {
      return { text, codec: 'json', version: '1' };
    }
  }

  const proofs = input.reviewContext?.children?.items?.map(item => item.computation).filter(proof => proof?.contract && proof?.result) ?? [];
  const boundedProof = proofs.length > 0 && Buffer.byteLength(JSON.stringify(proofs)) <= 4096;
  if (!boundedProof && (!manager.countTokens || manager.countTokens(selected.modelInput) >= manager.countTokens(input.relay.text))) return;
  return { text: selected.modelInput, codec: selected.codec, version: String(selected.version ?? 1) };
}
