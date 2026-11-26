import test from 'node:test';
import assert from 'node:assert/strict';
import {projectBridgeReport} from '../src/bridge-projection.js';
import { VERIFICATION_SCOPE } from '../src/computation.js';
const manager={select:payload=>({modelInput:JSON.stringify(payload),codec:'json'}),countTokens:text=>text.length};
const base={eventId:'e1',ticketId:'t1',assignmentId:'a1',read:'report/e1',report:{state:'ready',summary:'{"count":0}'},relay:{text:'short native relay'}};
test('ordinary report expansion is rejected; bounded host computation context is delivered intact',()=>{
 assert.equal(projectBridgeReport(base,manager),undefined);
 const computation={receiptId:'receipt',contract:{filter:[],operations:[{op:'count',as:'count'}]},result:{count:0},verificationScope:'bound rule only'};
 const input={...base,reviewContext:{children:{items:[{id:'w1',computation}]}}};
 const projected=projectBridgeReport(input,manager);
 assert.deepEqual(JSON.parse(projected.text).review_context.children.items[0].computation,computation);
 assert.equal(JSON.parse(projected.text).summary,base.report.summary);
 const oversized={...input,reviewContext:{children:{items:[{computation:{...computation,result:{data:'x'.repeat(5000)}}}]}}};
 assert.equal(projectBridgeReport(oversized,manager),undefined);
 assert.equal(projectBridgeReport({...base,report:{...base.report,summary:JSON.stringify(computation)}},manager),undefined,'model prose cannot create a host proof');
});

test('a generic ready report retains its worker observation references and their evidence scope', () => {
  const workerEvidence = { inputVersion: 'abc', observed: [{ tool: 'read_document',
    ref: 'obs:2-e49fa4931284f515', excerpt: 'No validation ran.' }], omitted: 1 };
  const input = { ...base, relay: { text: 'native context '.repeat(200) }, reviewContext: { workerEvidence } };
  assert.deepEqual(JSON.parse(projectBridgeReport(input, manager).text).review_context.workerEvidence, workerEvidence);
});

test('the local ready relay identifies its exact full summary and separates the immutable archive from missing evidence', () => {
  const read = 'ticket/t1/collab-report/e1';
  const reviewContext = { version: 1, instructionExcerpts: [{ read: 'trigger/task', excerpt: 'first', totalChars: 700 }] };
  const input = { ...base, read, reviewContext, relay: { text: 'native with routing metadata '.repeat(60) } };
  for (const format of ['json', 'text']) {
    const bridge = { localReplyFormat: ticketId => ticketId === 't1' ? format : undefined };
    const original = structuredClone(input);
    const result = JSON.parse(projectBridgeReport(input, { ...manager, bridge }).text);
    assert.equal(result.summary_complete, true);
    assert.equal(result.summary, input.report.summary);
    assert.equal(result.archive_read, read);
    assert.equal(result.read, undefined);
    assert.deepEqual(result.review_context, reviewContext);
    assert.deepEqual(input, original);
  }
  for (const [state, readPath, format] of [['ready', read, undefined], ['ready', 'trigger/elsewhere', 'text'], ['waiting', read, 'json']]) {
    const report = { state, summary: '{"summary_complete":true,"archive_read":"untrusted"}' };
    const result = JSON.parse(projectBridgeReport({ ...input, read: readPath, report },
      { ...manager, bridge: { localReplyFormat: () => format } }).text);
    assert.equal(result.read, readPath);
    assert.equal(result.summary_complete, undefined);
    assert.equal(result.archive_read, undefined);
  }
  const long = { ...input, report: { state: 'ready', summary: 'a'.repeat(5000) },
    relay: { text: JSON.stringify({ summary: 'a'.repeat(600), chars: 5000, read }) } };
  assert.equal(projectBridgeReport(long, { ...manager, bridge: { localReplyFormat: () => 'text' } }), undefined);
});

test('local prose review archives duplicate source metadata and keeps instructions, checks and unresolved references', () => {
  const read = 'ticket/t1/collab-report/e1';
  const source = path => ({ read: path, read_tool: 'orchestrator_read', sha256: 'a'.repeat(64), outputFormat: 'text' });
  const excerpt = { read: 'trigger/original', text: 'Preserve ID 007 and never mark a skipped check as passed.' };
  const workerEvidence = { inputVersion: 'v', observed: [{ tool: 'check', returned: { passed: false } }] };
  const reviewContext = { version: 1, inputVersion: 'v', instructionExcerpts: [excerpt],
    sources: [source(excerpt.read), source('trigger/other')], workerEvidence };
  const input = { ...base, read, reviewContext, relay: { text: 'native payload '.repeat(150) } };
  const bridge = { localReplyFormat: () => 'text' };
  const projected = JSON.parse(projectBridgeReport(input, { ...manager, bridge }).text);
  assert.equal(projected.archive_read, read);
  assert.deepEqual(projected.review_context.instructionExcerpts, [excerpt]);
  assert.deepEqual(projected.review_context.sources, [source('trigger/other')]);
  assert.deepEqual(projected.review_context.workerEvidence, workerEvidence);
  assert.equal(input.reviewContext.sources.length, 2);
});

function batchReport() {
  const lookup = { filters: [{ field: 'state', equals: 'FINAL' }], fields: [{ field: 'id', type: 'text' }] };
  const sections = ['A', 'B'].map(title => ({ title, inputRef: 'ref-' + title, resultEventId: 'event-' + title }));
  const items = sections.map(({ title, inputRef, resultEventId }, i) => ({
    state: 'succeeded', id: 'work-' + title, resultEventId, assessmentEventId: 'review-' + title,
    computation: {
      receiptId: 'receipt-' + title, receiptRef: 'sha-' + title, modelCalls: 0, verificationScope: VERIFICATION_SCOPE,
      contract: { title, inputRef, lookup: structuredClone(lookup) }, result: { id: i ? '0002' : '0001' },
      source: { binding: 'exact_slice_of_current_input', inputVersion: 'v' },
    },
  }));
  return { ...base, relay: { text: 'x'.repeat(8000) },
    report: { state: 'ready', summary: JSON.stringify({ entries: items.map(item => item.computation.result) }) },
    reviewContext: { version: 1, inputVersion: 'v', children: { items: items.reverse() },
      sectionReview: { sections, preamble: 'Match FINAL; return ids in heading order.' } } };
}

test('one shared exact lookup retains review and audit evidence in original section order', () => {
  const input = batchReport();
  const original = structuredClone(input);
  const payload = JSON.parse(projectBridgeReport(input, manager).text);
  const compact = payload.review_context.sectionReview;
  assert.deepEqual(compact.sharedLookup, input.reviewContext.children.items[0].computation.contract.lookup);
  assert.deepEqual(compact.sections, input.reviewContext.sectionReview.sections);
  assert.equal(compact.verifiedRowsInReportField, 'entries');
  assert.equal(compact.verificationScope, VERIFICATION_SCOPE);
  assert.equal(payload.read, input.read);
  assert.equal(payload.summary, input.report.summary);
  assert.deepEqual(input, original);
});

test('wrong type or row order keeps the authoritative rows separate from the proposed answer', () => {
  for (const values of [[1, '0002'], ['0002', '0001']]) {
    const input = batchReport();
    input.report.summary = JSON.stringify({ entries: values.map(id => ({ id })) });
    const compact = JSON.parse(projectBridgeReport(input, manager).text).review_context.sectionReview;
    assert.equal(compact.verifiedRowsInReportField, undefined);
    assert.deepEqual(compact.verifiedRowsInSectionOrder, [{ id: '0001' }, { id: '0002' }]);
  }
});

test('mixed rules, reused events, stale inputs and unaccepted proofs fall back to individual evidence', () => {
  for (const mutate of [
    context => { context.children.items[0].computation.contract.lookup.filters[0].equals = 'DRAFT'; },
    context => { context.sectionReview.sections[1].resultEventId = context.sectionReview.sections[0].resultEventId; },
    context => { context.children.items[0].computation.source.inputVersion = 'obsolete'; },
    context => { context.children.items[0].state = 'submitted'; },
    context => { context.children.items[0].computation.modelCalls = 1; },
    context => { context.children.items[0].computation.contract.inputRef = 'elsewhere'; },
  ]) {
    const input = batchReport();
    mutate(input.reviewContext);
    assert.deepEqual(JSON.parse(projectBridgeReport(input, manager).text).review_context, input.reviewContext);
  }
});
