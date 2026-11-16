import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { prepareNativeTask, MAX_ADVICE_BYTES } from '../src/native-handoff.js'
import * as evidenceTools from '../src/task-evidence.js'

const script = readFileSync(new URL('../src/panel.js', import.meta.url), 'utf8')

function openPanel(webConsultationProtocol = 0, taskEvidenceProtocol = 0) {
  const elements = new Map()
  const el = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: false, textContent: '', replaceChildren() {}, append() {},
    })
    return elements.get(id)
  }
  el('web').checked = true
  el('multi').checked = true
  el('prompt').value = '核对工单 A 的编号 007'
  el('context').value = '只核对前导零'
  const advice = Promise.withResolvers()
  const submitted = []
  runInNewContext(script.replace(/^import .*\r?\n/gm, ''), {
    prepareNativeTask, MAX_ADVICE_BYTES, TextEncoder, TextDecoder, ...evidenceTools,
    document: { getElementById: el, createElement: () => ({}) },
    navigator: { clipboard: { writeText: async () => {} } },
    crypto: { randomUUID }, setInterval() {},
    async fetch(path, request) {
      if (path === '/web-collab/api/status') return Response.json({ jobs: [], advisorAvailable: true })
      if (path === '/web-collab/api/advice') return advice.promise
      if (path === '/orchestrator/api/local/tasks' && request.method === 'GET') return Response.json({ tickets: [], webConsultationProtocol, taskEvidenceProtocol })
      if (path === '/web-collab/api/child-consultations') return Response.json({ pending: [] })
      submitted.push({ path, body: JSON.parse(request.body) })
      return Response.json({ triggerId: 'fixture-trigger' })
    },
  })
  const edit = (id, value) => { el(id).value = value; el(id).oninput() }
  const submit = () => el('task-form').onsubmit({ preventDefault() {} })
  return { el, edit, submit, advice, submitted }
}

test('drops a late reply if the task changed while its consultation excerpt stayed the same', async () => {
  const { el, edit, submit, advice, submitted } = openPanel()
  const consultation = el('consult').onclick()
  edit('prompt', '核对工单 B 的编号 042')
  advice.resolve(Response.json({ advice: '工单 A 的编号是 007' }))
  await consultation
  assert.equal(el('advice').value, '')
  assert.match(el('notice').textContent, /内容已变化/)
  await submit()
  assert.equal(submitted.length, 0)
})

test('blocks accepted advice after edits and submits new manual advice for the new draft', async () => {
  const { el, edit, submit, advice, submitted } = openPanel()
  const consultation = el('consult').onclick()
  advice.resolve(Response.json({ advice: '工单 A 的编号是 007' }))
  await consultation
  assert.equal(el('advice').value, '工单 A 的编号是 007')
  edit('prompt', '核对工单 B 的编号 042')
  await submit()
  assert.match(el('error').textContent, /已变化/)
  assert.equal(submitted.length, 0)
  edit('advice', '')
  await el('copy').onclick()
  edit('advice', '工单 B 的编号是 042')
  await submit()
  assert.equal(submitted[0].path, '/orchestrator/api/local/tasks')
  assert.match(submitted[0].body.prompt, /^核对工单 B/)
  assert.match(submitted[0].body.prompt, /工单 B 的编号是 042/)
  assert.doesNotMatch(submitted[0].body.prompt, /工单 A/)
})

test('manually pasted replies after copying keep the copied task identity', async () => {
  const { el, edit, submit, submitted } = openPanel()
  await el('copy').onclick()
  edit('prompt', '核对工单 B 的编号 042')
  edit('advice', '工单 A 的编号是 007')
  await submit()
  assert.match(el('error').textContent, /已变化/)
  assert.equal(submitted.length, 0)
})

test('hybrid tasks can opt in to child consultation without initial web advice', async () => {
  const { el, submit, submitted } = openPanel(1)
  await new Promise(setImmediate)
  assert.equal(el('advice').required, false)
  await submit()
  assert.equal(submitted[0].path, '/orchestrator/api/local/tasks')
  assert.equal(submitted[0].body.webConsultationEnabled, true)
  assert.equal(submitted[0].body.browserAdvice, undefined)
  assert.equal(submitted[0].body.prompt, '核对工单 A 的编号 007')
})

test('passes exact evidence files separately to a compatible native installation', async () => {
  const { el, submit, submitted } = openPanel(1, 1)
  await new Promise(setImmediate)
  const bytes = new TextEncoder().encode('记录\r\n')
  el('evidence').files = [{ name: 'source.log', size: bytes.length, arrayBuffer: async () => bytes.buffer }]
  el('evidence').onchange()
  await submit()
  assert.equal(submitted[0].body.prompt, '核对工单 A 的编号 007')
  assert.deepEqual(submitted[0].body.evidence, [{ label: 'source.log', text: '记录\r\n' }])
})
