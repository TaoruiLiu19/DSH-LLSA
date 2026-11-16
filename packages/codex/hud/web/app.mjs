import { createView, foldSnapshot, stepLifecycle } from '/shared/model.js';
import { drawField, ringGeometry } from '/shared/render.js';
import { agentForest } from './tree.mjs';

const $ = id => document.getElementById(id);
const session = $('session');
const canvas = $('field-canvas');
const context = canvas.getContext('2d');
const fieldEmpty = $('field-empty');
const floatSession = $('float-session');
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeStyle: 'medium', hourCycle: 'h23' });
const stateNames = new Map([
  ['idle', '空闲'], ['running', '运行中'], ['waiting-human', '待人工确认'],
  ['done', '已完成'], ['failed', '失败'], ['stalled', '停顿'],
]);
const eventNames = new Map([
  ['agent.register', '智能体加入'], ['agent.recovered', '恢复记录'], ['agent.cancel', '已取消'],
  ['turn.start', '开始工作'], ['turn.end', '结束工作'], ['tool.start', '开始使用工具'], ['tool.end', '工具返回'],
  ['attention.raised', '需要人工确认'], ['attention.resolved', '人工确认解除'], ['state.changed', '状态变更'],
]);
const emptyTree = '尚无智能体记录';
const emptyHistory = '尚无事件';

let selected = '';
let listSignature = '';
let snapshotSignature = '';
let view = createView({ now: performance.now(), locale: 'zh' });
let request;
let timer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function atTime(input) {
  const at = Date.parse(input);
  return Number.isFinite(at) ? timeFormat.format(at) : '时间未知';
}

function agentLabel(agent) {
  return agent.label || (agent.parentId === null ? '主智能体' : '智能体');
}

function stateOf(agent) {
  if (agent.stalled === true && agent.state === 'running') return 'stalled';
  return stateNames.has(agent.state) ? agent.state : 'unknown';
}

function treeBranch(nodes, level = 0) {
  const list = element('ul', level === 0 ? 'agent-tree' : '');
  for (const { agent, children, parentKnown } of nodes) {
    const branch = element('li');
    const item = element('div', 'agent');
    item.title = agent.id;
    const name = element('div', 'agent-name');
    const description = !parentKnown ? '父级未报告' : agent.parentId === null ? '主智能体' : agent.lastEvent?.tool || '子智能体';
    name.append(element('strong', '', agentLabel(agent)), element('small', '', description));
    const state = stateOf(agent);
    const badge = element('span', 'state');
    const dot = element('i');
    dot.setAttribute('aria-hidden', 'true');
    badge.dataset.tone = state;
    badge.append(dot, stateNames.get(state) ?? '未知');
    item.append(name, badge);
    branch.append(item);
    if (children.length) branch.append(treeBranch(children, level + 1));
    list.append(branch);
  }
  return list;
}

function eventList(events, labels) {
  const list = element('ol', 'event-list');
  for (const event of [...events].sort((a, b) => b.seq - a.seq)) {
    const row = element('li');
    row.dataset.seq = event.seq;
    const time = element('time', '', atTime(event.at));
    time.dateTime = event.at;
    time.title = event.at;
    const actor = element('span', 'event-agent', labels.get(event.agentId) ?? '智能体');
    actor.title = event.agentId;
    const description = element('span', 'event-description', eventNames.get(event.kind) ?? event.kind);
    if (event.kind === 'state.changed' && event.to) description.append(` · ${stateNames.get(event.to) ?? '未知'}`);
    if (event.tool) description.append(' · ', element('code', '', event.tool));
    if (event.synthetic === true) description.append(' · ', element('small', 'muted', '推导'));
    row.append(time, actor, description);
    list.append(row);
  }
  return list;
}

function connection(tone, text) {
  $('connection').dataset.tone = tone;
  if ($('connection-text').textContent !== text) $('connection-text').textContent = text;
}

function setSelection(id) {
  if (selected === id) return;
  selected = id;
  snapshotSignature = '';
  view = createView({ sessionId: id || null, locale: 'zh', now: performance.now() });
  renderSnapshot(null);
}

function renderRuns(runs) {
  const signature = JSON.stringify(runs);
  if (signature !== listSignature) {
    listSignature = signature;
    const options = runs.map(run => {
      const option = element('option', '', `${run.label || `Codex ${run.runId.slice(-8)}`} · ${atTime(run.lastActivityAt)}`);
      option.value = run.runId;
      return option;
    });
    if (!options.length) options.push(element('option', '', '暂无会话'));
    session.replaceChildren(...options);
    session.disabled = runs.length === 0;
  }
  if (!runs.some(run => run.runId === selected)) setSelection(runs[0]?.runId ?? '');
  session.value = selected;
  floatSession.textContent = session.selectedOptions[0]?.textContent ?? '';
}

function renderSnapshot(snapshot) {
  const { agents, events, seq, eventsFromSeq } = snapshot ?? { agents: [], events: [] };
  const signature = JSON.stringify([seq, eventsFromSeq, agents, events]);
  if (signature === snapshotSignature) return;
  snapshotSignature = signature;
  canvas.hidden = !snapshot || agents.length === 0 || context === null;
  fieldEmpty.hidden = !canvas.hidden;
  fieldEmpty.textContent = selected ? '等待此会话的活动记录' : '运行一次 Codex 任务后，会话将显示在这里。';
  $('float').disabled = canvas.hidden;
  const count = $('agent-count');
  count.hidden = agents.length === 0;
  count.textContent = agents.length;
  const groups = new Map();
  for (const agent of agents) {
    const state = stateOf(agent);
    groups.set(state, (groups.get(state) ?? 0) + 1);
  }
  $('summary').textContent = [...groups].map(([state, total]) => `${total} ${stateNames.get(state) ?? '未知'}`).join(' · ');
  $('tree').replaceChildren(agents.length ? treeBranch(agentForest(agents)) : element('p', 'muted', emptyTree));
  const labels = new Map(events.filter(event => event.label).map(event => [event.agentId, event.label]));
  for (const agent of agents) labels.set(agent.id, agentLabel(agent));
  const history = $('history');
  const previous = history.querySelector('.event-list');
  const previousTop = previous?.scrollTop ?? 0;
  const anchor = previousTop > 0 && [...previous.children].find(row => row.offsetTop + row.offsetHeight > previousTop);
  const anchorOffset = anchor ? previousTop - anchor.offsetTop : 0;
  const next = events.length ? eventList(events, labels) : element('p', 'empty-row muted', emptyHistory);
  history.replaceChildren(next);
  if (anchor && events.length) {
    const matchingRow = [...next.children].find(row => row.dataset.seq === anchor.dataset.seq);
    next.scrollTop = matchingRow ? matchingRow.offsetTop + anchorOffset : previousTop;
  }
  $('history-window').textContent = events.length ? `${events.length} 条${eventsFromSeq > 1 ? '近期事件' : ''}` : '';
}

async function read(path, signal) {
  const response = await fetch(path, { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('HUD unavailable');
  return response.json();
}

async function refresh() {
  clearTimeout(timer);
  request?.abort();
  const controller = new AbortController();
  request = controller;
  try {
    const { runs } = await read('/api/runs', controller.signal);
    if (controller.signal.aborted) return;
    renderRuns(runs);
    const runId = selected;
    const snapshot = runId ? await read(`/api/snapshot?runId=${encodeURIComponent(runId)}`, controller.signal) : null;
    if (controller.signal.aborted) return;
    if (snapshot?.v === 1) {
      const agents = snapshot.agents.map(agent => agent.parentId === null ? { ...agent, role: 'root' } : agent);
      foldSnapshot(view, { ...snapshot, agents }, performance.now(), { sessionId: runId, source: 'codex' });
    }
    renderSnapshot(snapshot?.v === 1 ? snapshot : null);
    if (snapshot && snapshot.v !== 1) connection('unknown', '快照版本未知');
    else if (snapshot) connection('running', '本机已连接');
    else connection('unknown', '等待本机活动');
  } catch {
    if (!controller.signal.aborted) connection('unknown', view.seq > 0 ? '离线 · 上次快照' : '本机 HUD 离线');
  } finally {
    if (!controller.signal.aborted) timer = setTimeout(refresh, 1200);
  }
}

session.addEventListener('change', () => {
  setSelection(session.value);
  void refresh();
});

let drawingWindow = window;
let frameId = 0;
let lastFrame = -Infinity;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function frame() {
  const now = performance.now();
  if (context && !canvas.hidden && now - lastFrame >= (reducedMotion ? 180 : 30)) {
    lastFrame = now;
    const { clientWidth, clientHeight } = canvas;
    const ratio = Math.min(drawingWindow.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(clientWidth * ratio));
    const height = Math.max(1, Math.round(clientHeight * ratio));
    const size = Math.max(1, Math.min(clientWidth, clientHeight) * 0.96);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
    context.setTransform(ratio, 0, 0, ratio, (width - size * ratio) / 2, (height - size * ratio) / 2);
    stepLifecycle(view, now);
    drawField(context, view, ringGeometry(size), now);
  }
  frameId = drawingWindow.requestAnimationFrame(frame);
}

function drawIn(target) {
  drawingWindow.cancelAnimationFrame(frameId);
  drawingWindow = target;
  frameId = target.requestAnimationFrame(frame);
}

const pictureInPicture = window.documentPictureInPicture;
const float = $('float');
if (pictureInPicture?.requestWindow) {
  float.hidden = false;
  float.addEventListener('click', async () => {
    if (pictureInPicture.window) {
      pictureInPicture.window.close();
      return;
    }
    $('float-error').hidden = true;
    try {
      const floatingWindow = await pictureInPicture.requestWindow({ width: 390, height: 380 });
      const content = $('floating-content');
      const stage = $('field-stage');
      const notice = $('float-notice');
      const style = floatingWindow.document.createElement('link');
      style.rel = 'stylesheet';
      style.href = new URL('/hud.css', location.href).href;
      floatingWindow.document.documentElement.lang = 'zh-CN';
      floatingWindow.document.title = document.title;
      floatingWindow.document.head.append(style);
      floatingWindow.document.body.className = 'pip';
      floatingWindow.document.body.append(content);
      floatSession.hidden = false;
      notice.hidden = false;
      float.textContent = '结束置顶';
      drawIn(floatingWindow);
      floatingWindow.addEventListener('pagehide', () => {
        stage.prepend(content);
        floatSession.hidden = true;
        notice.hidden = true;
        float.textContent = '置顶画布';
        drawIn(window);
      }, { once: true });
    } catch {
      $('float-error').hidden = false;
    }
  });
}

window.addEventListener('pageshow', () => {
  drawIn(window);
  void refresh();
});
window.addEventListener('pagehide', () => {
  request?.abort();
  clearTimeout(timer);
  drawingWindow.cancelAnimationFrame(frameId);
});
