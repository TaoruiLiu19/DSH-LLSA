import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const filename = 'index.html';
const sourceFile = '资料/清单.txt';
const sourceText = '\uFEFF用户提供的库存清单\r\n001\r\n';
const starter = '<main>保留的已有内容</main>\r\n';
const scopedOutputLimit = 8192;
const coordinatorOutputLimit = 16384;
const repairPhase = 3;
const budgetPhase = 4;
const defectiveContents = '<main>phase-3<form><button>Preview</button></form></main>';
const repair = 'In index.html, give the Preview button type="button" so it does not submit its form. Preserve the rest of the artifact.';
const contents = phase => phase === repairPhase
  ? defectiveContents.replace('<button>', '<button type="button">')
  : `<main>phase-${phase}</main>`;
const marker = phase => `release delivery phase-${phase}`;

function userMessages(body) {
  return (body.messages ?? []).filter(message => message.role === 'user')
    .flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content ?? [])
      .filter(block => block.type === 'text').map(block => block.text));
}

function messages(body) {
  return userMessages(body)
    .flatMap(text => text.split('\n')).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function latestToolResult(body) {
  const result = (body.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : [])
    .findLast(block => block.type === 'tool_result');
  if (!result) return;
  const content = typeof result.content === 'string' ? result.content
    : (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join(' ');
  return content.slice(0, 500);
}

function stream(res, model, action) {
  const tool = action.name !== undefined;
  const block = tool
    ? { type: 'tool_use', id: `tool_${randomUUID()}`, name: action.name, input: {} }
    : { type: 'text', text: '' };
  const delta = tool ? { type: 'input_json_delta', partial_json: JSON.stringify(action.args) }
    : { type: 'text_delta', text: action.text };
  const usage = { input_tokens: action.inputTokens ?? 50, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const events = [
    { type: 'message_start', message: { id: `msg_${randomUUID()}`, model, type: 'message', role: 'assistant', content: [], usage } },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_delta', index: 0, delta },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

export async function openDeliveryFixture() {
  const key = `sk-release-smoke-${randomUUID()}`;
  const reviews = new Map(), routed = new Set();
  const requests = [];
  let phase = 0, step = 0, intakeReads = 0, failure, quietInjected = false, rejectedReportId;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/anthropic/v1/messages') {
      res.writeHead(404).end();
      return;
    }
    try {
      assert.equal(req.headers['x-api-key'] === key || req.headers.authorization === `Bearer ${key}`, true,
        'Unexpected authorization at the isolated provider');
      assert.ok(requests.length < 40, 'Clean release delivery exceeded the probe’s request limit');
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        assert.ok(Buffer.byteLength(raw) <= 1_000_000, 'Unexpectedly large provider request');
      }
      const body = JSON.parse(raw), tools = new Set((body.tools ?? []).map(tool => tool.name));
      const cards = messages(body), current = phase;
      const candidate = cards.find(card => card?.trigger_id && !card.report_id && !card.ticket &&
        typeof card.text === 'string' && card.text.includes(marker(current)) && !routed.has(card.trigger_id));
      let action, role;
      if (tools.has('orchestrator_collab_finish')) {
        role = 'coordinator';
        assert.equal(body.max_tokens, coordinatorOutputLimit, 'Native coordinator provider request did not carry the bounded default output limit');
        const ready = cards.findLast(card => card?.state === 'ready' && card.report_id && !reviews.has(card.report_id));
        if (ready) {
          const evidence = ready.review_context?.readyEvidence;
          assert.ok(evidence, `Phase ${current} ready report did not carry host evidence`);
          const accepted = current !== repairPhase || Boolean(rejectedReportId);
          if (!accepted) rejectedReportId = ready.report_id;
          reviews.set(ready.report_id, { phase: current, evidence, accepted });
          action = { name: 'orchestrator_collab_finish', args: {
            report_id: ready.report_id, accepted,
            reason: accepted ? 'The scoped file has a current host receipt and meets the task.' : repair,
            ...(accepted ? { use_report: true } : {}),
          } };
        } else if (candidate) {
          assert.ok(current === 1 || current === budgetPhase, 'Serial follow-up attempted to create an additional ticket');
          routed.add(candidate.trigger_id);
          action = { name: 'orchestrator_route', args: { decisions: [{
            trigger_id: candidate.trigger_id, kind: 'accept', title: 'Clean release delivery fixture',
            acknowledgement: 'I will prepare and verify the scoped file.', worktree_name: 'clean-release-delivery',
          }] } };
        } else if (current === budgetPhase) throw new Error('The budget failure unexpectedly woke the coordinator');
      } else if (tools.has('orchestrator_report')) {
        role = 'worker';
        assert.ok(current >= 1 && current <= budgetPhase, 'Unexpected worker phase');
        assert.ok(tools.has('artifact_write') && tools.has('artifact_check'), 'Clean release lacks its scoped artifact tools');
        assert.equal(body.max_tokens, scopedOutputLimit, 'Scoped worker provider request did not carry the bounded default output limit');
        if (current === 1 && intakeReads === 0) {
          assert.ok(userMessages(body).every(text => !text.includes('用户提供的库存清单')), 'Uploaded input was preloaded into model messages');
          intakeReads++;
          action = { name: 'artifact_read', args: { path: sourceFile } };
        } else if (current === 1 && intakeReads === 1) {
          assert.equal(JSON.parse(latestToolResult(body)).content, sourceText, 'Read-only upload was not staged byte-for-byte');
          intakeReads++;
          action = { name: 'artifact_read', args: { path: filename } };
        } else if (current === 2 && !quietInjected) {
          quietInjected = true;
          action = { text: 'I am waiting for file reads before revising the artifact.' };
        } else if (step === 0) {
          if (current === 1) assert.equal(JSON.parse(latestToolResult(body)).content, starter, 'Editable upload was not staged before dispatch');
          action = { name: 'artifact_write', args: {
            path: filename, content: current === repairPhase ? defectiveContents : contents(current),
          }, ...(current === budgetPhase ? { inputTokens: 299_000 } : {}) };
        } else if (step === 2 && current === repairPhase) {
          assert.ok(rejectedReportId && userMessages(body).some(message =>
            message.includes(`Review feedback for ${rejectedReportId}.`) && message.includes(repair)),
          'The scoped worker was not given the targeted coordinator repair');
          action = { name: 'artifact_write', args: { path: filename, content: contents(current) } };
        } else if (step === 1 || (step === 3 && current === repairPhase)) {
          action = { name: 'artifact_check', args: { submit_for_review: true } };
        }
        else throw new Error(`Artifact delivery did not stop the worker after its phase ${current} check (${latestToolResult(body) ?? 'no tool result'})`);
        if (action.name && action.name !== 'artifact_read') step++;
      }
      action ??= { text: 'The release smoke fixture is waiting for a local report.' };
      assert.ok(!action.name || tools.has(action.name), 'Smoke fixture attempted an unavailable tool');
      requests.push({ phase: current, action: action.name, role, outputCap: body.max_tokens });
      stream(res, body.model, action);
    } catch (error) {
      failure ??= error;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Release smoke fixture rejected a request' } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/anthropic`, key, reviews, requests, routed,
    begin(value) { phase = value; step = 0; },
    assertHealthy() { if (failure) throw failure; },
    get quietInjected() { return quietInjected; },
    async close() {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}

export async function smokeDelivery(origin, headers, state, fixture) {
  const api = '/orchestrator/api/local/tasks';
  const request = async (path, body) => {
    const res = await fetch(origin + path, {
      method: body ? 'POST' : 'GET', headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200, path);
    return res.json();
  };
  const seen = new Set(), inputVersions = new Set(), accepted = [];
  const sandbox = await realpath(state);
  let ticketId, precedingReply, masterSessionId, rejected;
  for (let phase = 1; phase <= 3; phase++) {
    fixture.begin(phase);
    const prompt = `For ${marker(phase)}, write ${contents(phase)} in ${filename} and deliver the verified file.`;
    const requestId = `release-smoke-${randomUUID()}`;
    const submission = await request(phase === 1 ? api : `${api}/${encodeURIComponent(ticketId)}/followups`, {
      requestId, prompt, ...(phase === 1 ? {
        artifactFiles: [filename], artifactInputs: [sourceFile],
        workspaceFiles: [{ path: filename, text: starter }, { path: sourceFile, text: sourceText }],
      } : { afterReplyId: precedingReply }),
    });
    assert.ok(submission.triggerId, 'The normal local task API did not register an input');
    let reply, taskRow, ticket, latest;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      fixture.assertHealthy();
      const snapshot = await request(api);
      assert.ok(snapshot.masterSessionId, 'No native coordinator session reported by the local API');
      if (masterSessionId) assert.equal(snapshot.masterSessionId, masterSessionId, 'Serial follow-up changed the coordinator');
      masterSessionId = snapshot.masterSessionId;
      latest = snapshot.tickets.find(row => row.ticket.id === ticketId)?.ticket;
      reply = snapshot.replies.find(row => row.status === 'sent' && row.kind === 'reply' && !seen.has(row.id));
      if (reply) {
        if (ticketId) assert.equal(reply.ticketId, ticketId, 'Serial follow-up switched tickets');
        taskRow = snapshot.tickets.find(row => row.ticket.id === reply.ticketId);
        ticket = taskRow?.ticket;
        if (taskRow?.issuedReplyId !== reply.id) { reply = undefined; await delay(200); continue; }
        assert.equal(snapshot.replies.filter(row =>
          row.status === 'sent' && row.kind === 'reply' && row.ticketId === reply.ticketId).length, phase,
        'One artifact revision must produce exactly one reply to the owner');
        break;
      }
      await delay(200);
    }
    assert.ok(reply && ticket, `No sent local artifact receipt for release phase ${phase} (${JSON.stringify({
      actions: fixture.requests.filter(row => row.phase === phase).map(row => row.action ?? 'text'),
      outcomes: latest?.assignments?.map(assignment => assignment.report?.state ?? assignment.state),
      undelivered: latest?.undelivered?.length, ended: latest?.ended?.outcome,
    })})`);
    ticketId = reply.ticketId;
    precedingReply = reply.id;
    seen.add(reply.id);
    const file = await realpath(join(ticket.execution.directory, filename));
    const inside = relative(sandbox, file);
    assert.ok(inside && !isAbsolute(inside) && inside !== '..' && !/^[.][.][\\/]/.test(inside),
      'Artifact escaped the isolated release worktree');
    const bytes = await readFile(file);
    assert.equal(bytes.toString('utf8'), contents(phase));
    assert.equal(await readFile(join(ticket.execution.directory, sourceFile), 'utf8'), sourceText);
    const reviews = [...fixture.reviews].filter(([, row]) => row.phase === phase);
    assert.deepEqual(reviews.map(([, row]) => row.accepted), phase === repairPhase ? [false, true] : [true]);
    const [reportId, { evidence }] = reviews.at(-1);
    assert.ok(evidence.inputVersion && !inputVersions.has(evidence.inputVersion), 'A new revision reused the previous review input');
    inputVersions.add(evidence.inputVersion);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.equal(evidence.data.verificationScope, 'local_workspace_integrity');
    assert.deepEqual(evidence.data.files, [{ path: filename, bytes: bytes.length, sha256 }]);
    assert.deepEqual(taskRow.artifactWorkspace.outputs, [{ path: filename, bytes: bytes.length, sha256, status: 'delivered' }]);
    await assertDownload(origin, headers, ticketId, filename, 'delivered', bytes, sha256);
    assert.equal(evidence.data.artifactSha256, createHash('sha256').update(JSON.stringify(evidence.data.files)).digest('hex'));
    accepted.push({ reportId, replyId: reply.id });
    if (phase === repairPhase) {
      const [rejectedId, { evidence: rejectedEvidence }] = reviews[0];
      const defectiveHash = createHash('sha256').update(defectiveContents).digest('hex');
      assert.notEqual(rejectedId, reportId, 'The repaired artifact must submit a new report');
      assert.equal(rejectedEvidence.inputVersion, evidence.inputVersion, 'A repair must stay within the owner input version');
      assert.deepEqual(rejectedEvidence.data.files, [{
        path: filename, bytes: Buffer.byteLength(defectiveContents), sha256: defectiveHash,
      }]);
      assert.notEqual(rejectedEvidence.data.artifactSha256, evidence.data.artifactSha256,
        'The repaired artifact must have a different manifest receipt');
      rejected = { rejectedId, acceptedId: reportId };
    }
  }
  assert.equal(fixture.reviews.size, 4);
  assert.equal(fixture.routed.size, 1);
  assert.equal(fixture.quietInjected, true, 'The simulated quiet worker recovery did not run');
  for (const name of ['artifact_write', 'artifact_check', 'orchestrator_collab_finish']) {
    assert.deepEqual(fixture.requests.filter(row => row.action === name).map(row => row.phase), [1, 2, 3, 3]);
  }
  const db = new DatabaseSync(join(state, 'plugin', 'superagent', 'orchestrator.sqlite'), { readOnly: true });
  try {
    const receipt = db.prepare(`SELECT link.reply_id, review.value FROM collab_bridge_local_replies link
      JOIN collab_bridge_reviews review USING (report_id) WHERE link.report_id=?`);
    for (const { reportId, replyId } of accepted) {
      const stored = receipt.get(reportId);
      assert.equal(stored?.reply_id, replyId, 'Sent reply is not bound to its native review');
      assert.equal(JSON.parse(stored.value).accepted, true, 'Native coordinator acceptance was not persisted');
    }
    const recordedReview = db.prepare('SELECT value FROM collab_bridge_reviews WHERE report_id=?');
    const negative = JSON.parse(recordedReview.get(rejected.rejectedId).value);
    const positive = JSON.parse(recordedReview.get(rejected.acceptedId).value);
    assert.equal(negative.accepted, false);
    assert.equal(negative.reason, repair);
    assert.equal(negative.assignmentId, positive.assignmentId, 'The repair changed native assignment');
    assert.equal(receipt.get(rejected.rejectedId), undefined, 'The rejected version was sent to the owner');
  } finally { db.close(); }
  const accounting = new DatabaseSync(join(state, 'plugin', 'collab', 'collaboration.sqlite'), { readOnly: true });
  try {
    const worker = accounting.prepare('SELECT data FROM requests WHERE instr(run_id, ?) = 1 ORDER BY rowid')
      .all(`super-${ticketId}-`);
    const coordinator = accounting.prepare('SELECT data FROM requests WHERE run_id=? ORDER BY rowid')
      .all(`super-master-${masterSessionId}`);
    for (const [role, rows] of Object.entries({ worker, coordinator })) {
      const calls = fixture.requests.filter(row => row.role === role);
      assert.equal(rows.length, calls.length, `A ${role} provider request has no matching admission record`);
      for (const [index, row] of rows.entries()) {
        const { requestLimits, tokenAdmission } = JSON.parse(row.data);
        assert.equal(requestLimits.requestedMaxOutputTokens, calls[index].outputCap);
        assert.equal(requestLimits.reservationMaxOutputTokens, calls[index].outputCap);
        if (role === 'coordinator') {
          assert.equal(tokenAdmission?.scope, 'coordinator_turn',
            `Coordinator phase ${calls[index].phase} ${calls[index].action ?? 'turn'} fell back to cumulative run admission`);
          assert.ok(Number.isSafeInteger(tokenAdmission.turn) && Number.isSafeInteger(tokenAdmission.startSeq));
        }
      }
    }
  } finally { accounting.close(); }
  console.log('PASS: three scoped revisions through the standard local API, with sent and file hash receipts');
  console.log('PASS: editable and read-only uploads are available at the first native execution, and final downloads match disk bytes');
  console.log('PASS: native negative review, targeted same-assignment repair and distinct accepted artifact delivered once');
  console.log(`PASS: scoped worker provider and admission both capped at ${scopedOutputLimit} output tokens`);
  console.log(`PASS: native coordinator provider and per-turn admission both capped at ${coordinatorOutputLimit} output tokens`);
  await smokeBudgetRecovery(origin, headers, request, fixture);
}

async function assertDownload(origin, headers, ticketId, path, status, content, sha256) {
  const query = new URLSearchParams({ path, sha256, ...(status === 'draft' ? { draft: '1' } : {}) });
  const response = await fetch(origin + '/orchestrator/api/local/tasks/' + encodeURIComponent(ticketId) + '/artifacts?' + query,
    { headers, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, 'Expected an authenticated artifact download');
  assert.equal(response.headers.get('x-llsa-artifact-status'), status);
  assert.match(response.headers.get('content-disposition'), /^attachment\b/i);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
}

async function smokeBudgetRecovery(origin, headers, request, fixture) {
  const api = '/orchestrator/api/local/tasks';
  fixture.begin(budgetPhase);
  const submission = await request(api, {
    requestId: 'release-smoke-budget-' + randomUUID(), directRoute: true, artifactFiles: [filename],
    prompt: `For ${marker(budgetPhase)}, write ${contents(budgetPhase)} to ${filename} and hand in the verified file.`,
  });
  const rowForTask = async () => (await request(api)).tickets.find(({ ticket }) => ticket.origin.triggerIds.includes(submission.triggerId));
  const wait = async predicate => {
    const deadline = Date.now() + 25_000;
    do {
      fixture.assertHealthy();
      const row = await rowForTask();
      if (row && predicate(row)) return row;
      await delay(200);
    } while (Date.now() < deadline);
    throw new Error('Timed out waiting for the budget recovery fixture');
  };
  const blocked = await wait(row => row.artifactRecovery?.kind === 'token_budget');
  const ticketId = blocked.ticket.id;
  const assignmentId = blocked.artifactRecovery.assignmentId;
  assert.equal(blocked.artifactRecovery.canRetry, true);
  assert.equal(blocked.issuedReplyId, undefined, 'Unreviewed work acquired an issued reply');
  const draft = blocked.artifactWorkspace.outputs.find(output => output.path === filename);
  assert.equal(draft.status, 'draft');
  const bytes = Buffer.from(contents(budgetPhase));
  await assertDownload(origin, headers, ticketId, filename, 'draft', bytes, draft.sha256);
  const premature = await fetch(origin + api + '/' + encodeURIComponent(ticketId) + '/artifacts?' + new URLSearchParams({ path: filename }),
    { headers, signal: AbortSignal.timeout(5000) });
  assert.equal(premature.status, 409, 'Unreviewed bytes were download-ready as a final file');
  await premature.body?.cancel();
  const retry = '/orchestrator/api/tickets/' + encodeURIComponent(ticketId) + '/retry?' + new URLSearchParams({ assignmentId });
  await request(retry, {});
  const delivered = await wait(row => Boolean(row.issuedReplyId));
  assert.equal(delivered.ticket.execution.directory, blocked.ticket.execution.directory);
  assert.notEqual(delivered.ticket.assignments.at(-1).id, assignmentId);
  assert.deepEqual(delivered.artifactWorkspace.outputs, [{ ...draft, status: 'delivered' }]);
  await assertDownload(origin, headers, ticketId, filename, 'delivered', bytes, draft.sha256);
  assert.deepEqual(fixture.requests.filter(row => row.phase === budgetPhase).map(row => row.action),
    ['artifact_write', 'artifact_check', 'orchestrator_collab_finish']);
  console.log('PASS: budget stop retains a labelled draft, spends no coordinator call, and owner retry delivers in the same workspace');
}
