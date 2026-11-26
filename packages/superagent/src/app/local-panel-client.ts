export const LOCAL_PANEL_SCRIPT = String.raw`
const element = id => document.getElementById(id);
const uploads = [];
const drafts = new Map();
const maxFiles = 12;
const maxFileBytes = 180 * 1024;
const maxTotalBytes = 512 * 1024;
let mode = 'text';
let target = null;
let pending = null;
let busy = false;
let loadingFiles = false;
let refreshing = false;
let lastView;
let submittedTrigger;

function line(parent, tag, text, className) {
  const child = document.createElement(tag);
  child.textContent = text;
  if (className) child.className = className;
  parent.append(child);
  return child;
}

function button(parent, label, action, className) {
  const child = line(parent, 'button', label, className);
  child.type = 'button';
  child.onclick = action;
  return child;
}

function request(path, body) {
  return fetch('/orchestrator/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-orchestrator-request': '1',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

async function responseError(response) {
  if (response.status === 401 || response.status === 403) return new Error('连接授权已失效，请通过当前 Harness 的登录链接重新打开。');
  if (response.status === 413) return new Error('提交内容过大，请减少附件或缩短任务说明。');
  const payload = await response.json().catch(() => ({}));
  const issue = payload.issues?.[0];
  return new Error(issue?.message || payload.error || '请求失败（HTTP ' + response.status + '）');
}

async function api(path, body) {
  const response = await request(path, body);
  if (!response.ok) throw await responseError(response);
  return response.json();
}

const taskPath = id => 'local/tasks/' + encodeURIComponent(id);
const formatBytes = bytes => bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1) + ' KiB';

function updateForm() {
  element('new-only').hidden = !!target;
  element('new-task').hidden = !target;
  element('file-fields').hidden = !!target || mode !== 'files';
  element('text-fields').hidden = !!target || mode !== 'text';
  element('mode-text').setAttribute('aria-pressed', String(mode === 'text'));
  element('mode-files').setAttribute('aria-pressed', String(mode === 'files'));
  element('form-title').textContent = target ? '追加要求' : '新工单';
  element('prompt-label').textContent = target ? '工单 · ' + target.title : '任务要求';
  element('submit').textContent = target ? '追加到此工单' : '创建工单';
}

function selectTicket(ticket) {
  if (busy || loadingFiles) return;
  drafts.set(target?.id, element('prompt').value);
  target = ticket;
  element('prompt').value = drafts.get(target?.id) ?? '';
  element('error').textContent = '';
  updateForm();
  element('prompt').focus();
}

function setMode(value) {
  if (busy || loadingFiles) return;
  mode = value;
  element('error').textContent = '';
  updateForm();
}

function renderUploads() {
  const list = element('uploads');
  list.replaceChildren();
  for (const upload of uploads) {
    const item = line(list, 'li', '');
    const fields = line(item, 'div', '', 'file-row');
    const path = line(fields, 'input', '');
    path.type = 'text';
    path.value = upload.path;
    path.maxLength = 180;
    path.setAttribute('aria-label', upload.name + ' 的工作区路径');
    path.oninput = () => { upload.path = path.value; };
    const remove = button(fields, '移除', () => {
      uploads.splice(uploads.indexOf(upload), 1);
      renderUploads();
    });
    remove.setAttribute('aria-label', '移除 ' + upload.name);
    const label = line(item, 'label', '', 'check');
    const editable = line(label, 'input', '');
    editable.type = 'checkbox';
    editable.checked = upload.editable;
    editable.onchange = () => { upload.editable = editable.checked; };
    line(label, 'span', '作为可修改文件（' + formatBytes(upload.bytes) + '）');
  }
}

async function addFiles() {
  const picker = element('file-picker');
  const files = [...picker.files];
  picker.value = '';
  if (busy || loadingFiles || !files.length) return;
  element('error').textContent = '';
  if (uploads.length + files.length > maxFiles ||
      uploads.reduce((total, upload) => total + upload.bytes, 0) + files.reduce((total, file) => total + file.size, 0) > maxTotalBytes) {
    element('error').textContent = '附件最多 12 个，总大小不超过 512 KiB。';
    return;
  }
  loadingFiles = true;
  element('submit').disabled = true;
  try {
    const loaded = [];
    for (const file of files) {
      if (file.size > maxFileBytes) throw new Error(file.name + ' 超过单文件 180 KiB 的上限。');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
      catch { throw new Error(file.name + ' 无法读取为 UTF-8 文本。'); }
      if (text.includes('\0')) throw new Error(file.name + ' 无法读取为 UTF-8 文本。');
      loaded.push({ path: file.name.normalize('NFC'), name: file.name, bytes: file.size, text, editable: false });
    }
    uploads.push(...loaded);
    renderUploads();
  } catch (error) { element('error').textContent = error.message; }
  finally { loadingFiles = false; element('submit').disabled = false; }
}

function artifactFields() {
  const declared = element('artifact-files').value.split(/[\r\n,，]+/).map(path => path.trim().normalize('NFC')).filter(Boolean);
  const workspaceFiles = uploads.map(upload => ({ path: upload.path.trim().normalize('NFC'), text: upload.text }));
  const artifactInputs = workspaceFiles.filter((_, index) => !uploads[index].editable).map(upload => upload.path);
  const editable = workspaceFiles.filter((_, index) => uploads[index].editable).map(upload => upload.path);
  const artifactFiles = [...new Set([...declared, ...editable])];
  if (!artifactFiles.length) throw new Error('请填入要新建的文件，或勾选已有文件的「作为可修改文件」。');
  if (artifactFiles.length > maxFiles) throw new Error('最多可以声明 12 个交付文件。');
  const validPath = path => path.length <= 180 && path.split('/').every(part =>
    /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_. -]*$/u.test(part) && !/[. ]$/u.test(part));
  if ([...artifactFiles, ...workspaceFiles.map(file => file.path)].some(path => !validPath(path))) {
    throw new Error('请填写相对路径，例如 docs/说明.md。使用 / 分隔目录。');
  }
  const paths = [...artifactFiles, ...artifactInputs].map(path => path.toLowerCase());
  if (new Set(paths).size !== paths.length || paths.some(path => paths.some(other => other.startsWith(path + '/'))) ||
      new Set(workspaceFiles.map(file => file.path.toLowerCase())).size !== workspaceFiles.length) {
    throw new Error('每个文件需要独立路径。上传的文件如果需要修改，请勾选「作为可修改文件」。');
  }
  return { artifactFiles, ...(artifactInputs.length ? { artifactInputs } : {}), ...(workspaceFiles.length ? { workspaceFiles } : {}) };
}

function statusFor(row, delivered) {
  const ticket = row.ticket;
  const state = ticket.assignments.at(-1)?.report?.state;
  if (row.artifactRecovery) return ['blocked', row.artifactRecovery.kind === 'token_budget' ? '预算已用完' : '需要处理'];
  if (ticket.attention) return ['blocked', '等待确认'];
  if (ticket.ended?.outcome === 'completed') {
    if (row.issuedReplyId || (delivered && !row.artifactWorkspace)) return ['delivered', '已交付'];
    return delivered ? ['blocked', '当前版本待确认'] : ['active', '等待送达'];
  }
  if (ticket.ended) return ['blocked', '已结束'];
  if (state === 'ready') return ['active', '等待验收'];
  if (state === 'failed' || state === 'blocked') return ['blocked', '需要处理'];
  return ['active', ticket.assignments.length ? '执行中' : '等待分配'];
}

async function download(ticketId, output) {
  const query = new URLSearchParams({ path: output.path });
  if (output.status === 'draft') query.set('draft', '1');
  if (output.sha256) query.set('sha256', output.sha256);
  const response = await request(taskPath(ticketId) + '/artifacts?' + query);
  if (response.status === 409) {
    await refresh();
    throw new Error('文件状态已更新，请查看工单中的最新版本。');
  }
  if (!response.ok) throw await responseError(response);
  const blob = await response.blob();
  const address = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = address;
  link.download = output.path.split('/').at(-1);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(address), 1000);
}

async function taskAction(action) {
  element('task-error').textContent = '';
  try { await action(); }
  catch (error) { element('task-error').textContent = error.message; }
}

function showWorkspace(box, ticketId, workspace) {
  const list = line(box, 'ul', '', 'files');
  for (const item of workspace.outputs ?? workspace.files.map(path => ({ path, status: 'missing' }))) {
    const file = line(list, 'li', '');
    const row = line(file, 'div', '', 'file-row');
    const info = line(row, 'span', item.path);
    const state = item.status === 'delivered' ? '已交付' : item.status === 'draft' ? '已保存 · 待验收' : '等待写入';
    line(info, 'span', state + (item.bytes === undefined ? '' : ' · ' + formatBytes(item.bytes)), 'file-label');
    if (item.status !== 'missing') {
      const action = button(row, item.status === 'draft' ? '下载草稿' : '下载', () => taskAction(() => download(ticketId, item)));
      action.setAttribute('aria-label', action.textContent + ' ' + item.path);
    }
  }
  const details = line(box, 'details', '');
  line(details, 'summary', '本机工作目录');
  line(details, 'code', workspace.directory);
}

function renderTicket(list, row, latestReply) {
  const ticket = row.ticket;
  const box = line(list, 'article', '', 'ticket');
  const head = line(box, 'div', '', 'ticket-info');
  line(head, 'h3', ticket.title);
  const [state, status] = statusFor(row, row.issuedReplyId || latestReply);
  line(head, 'span', status, 'status').setAttribute('data-state', state);
  const report = ticket.assignments.at(-1)?.report;
  const recovery = row.artifactRecovery;
  if (recovery?.kind === 'token_budget') {
    line(box, 'p', '当前执行已达到预算上限。已写文件保留在本机，等待验收。');
  } else if (recovery?.message) {
    line(box, 'p', recovery.message);
  } else if (ticket.attention?.question) {
    line(box, 'p', ticket.attention.question);
  } else if (ticket.ended?.outcome === 'completed' && latestReply?.text && (row.issuedReplyId || !row.artifactWorkspace)) {
    line(box, 'p', latestReply.text);
  } else if (report?.summary) {
    line(box, 'p', report.summary, 'muted');
  }
  if (row.artifactWorkspace) showWorkspace(box, ticket.id, row.artifactWorkspace);
  const actions = line(box, 'div', '', 'actions');
  if (recovery?.canRetry) {
    const retry = button(actions, '从已保存文件继续', () => taskAction(async () => {
      retry.disabled = true;
      try {
        await api('tickets/' + encodeURIComponent(ticket.id) + '/retry?' + new URLSearchParams({ assignmentId: recovery.assignmentId }), {});
        await refresh();
      } finally { retry.disabled = false; }
    }), 'primary');
    line(box, 'p', '继续会启动新一轮执行，并使用所配置模型的额度。', 'muted');
  }
  if ((!recovery && !ticket.ended) || (ticket.ended?.outcome === 'completed' && row.issuedReplyId)) {
    button(actions, '追加要求', () => selectTicket({ id: ticket.id, title: ticket.title,
      ...(ticket.ended ? { afterReplyId: row.issuedReplyId } : {}) }));
  }
  if (!ticket.ended) {
    button(actions, '停止', () => taskAction(async () => {
      await api('tickets/' + encodeURIComponent(ticket.id) + '/stop', {});
      await refresh();
    }), 'subtle');
  }
}

function renderTasks(view) {
  const list = element('tasks');
  list.replaceChildren();
  const results = new Map();
  const byId = new Map(view.replies.map(reply => [reply.id, reply]));
  for (const reply of view.replies) {
    if (reply.kind === 'reply' && reply.status === 'sent' && !results.has(reply.ticketId)) results.set(reply.ticketId, reply);
  }
  const shown = new Set();
  for (const row of view.tickets) {
    const reply = row.issuedReplyId ? byId.get(row.issuedReplyId) : results.get(row.ticket.id);
    renderTicket(list, row, reply);
    if (reply && row.ticket.ended?.outcome === 'completed' && (row.issuedReplyId || !row.artifactWorkspace)) shown.add(reply.id);
  }
  if (!view.tickets.length) line(list, 'p', '还没有工单。创建后会在这里看到进度和成品。', 'empty');
  const other = view.replies.filter(reply => !shown.has(reply.id) && reply.text);
  const messages = element('reply-list');
  messages.replaceChildren();
  for (const reply of other) line(messages, 'li', reply.text);
  element('replies').hidden = !other.length;
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const view = await api('local/tasks');
    const signature = JSON.stringify(view);
    if (signature !== lastView) {
      renderTasks(view);
      lastView = signature;
    }
    if (submittedTrigger && view.tickets.some(({ ticket }) => ticket.origin.triggerIds.includes(submittedTrigger) ||
        ticket.inputs.some(input => input.triggerId === submittedTrigger))) {
      element('notice').textContent = '已接收。可在「工单与成品」查看进度。';
      submittedTrigger = undefined;
    }
  } catch (error) { element('task-error').textContent = error.message; }
  finally { refreshing = false; }
}

async function submit() {
  if (busy || loadingFiles) return;
  const prompt = element('prompt').value.trim();
  element('error').textContent = '';
  if (!prompt) { element('error').textContent = '请先填写任务要求。'; return; }
  const path = target ? taskPath(target.id) + '/followups' : 'local/tasks';
  try {
    const fields = target ? { prompt, ...(target.afterReplyId ? { afterReplyId: target.afterReplyId } : {}) } :
      { prompt, outputFormat: mode === 'text' && element('json-output').checked ? 'json' : 'text', directRoute: true,
        ...(mode === 'files' ? artifactFields() : {}) };
    const signature = JSON.stringify(fields);
    if (!pending || pending.path !== path || pending.signature !== signature) {
      pending = { path, signature, body: { requestId: crypto.randomUUID(), ...fields } };
    }
    busy = true;
    element('submit').disabled = true;
    const response = await api(path, pending.body);
    submittedTrigger = response.triggerId;
    element('notice').textContent = '已提交，正在等待工单更新。';
    element('prompt').value = '';
    drafts.delete(target?.id);
    if (target) {
      target = null;
      element('prompt').value = drafts.get(undefined) ?? '';
      updateForm();
    } else if (mode === 'files') {
      uploads.length = 0;
      element('artifact-files').value = '';
      renderUploads();
    }
    pending = null;
    await refresh();
  } catch (error) { element('error').textContent = error.message; }
  finally { busy = false; element('submit').disabled = false; }
}

element('mode-text').onclick = () => setMode('text');
element('mode-files').onclick = () => setMode('files');
element('file-picker').onchange = addFiles;
element('submit').onclick = submit;
element('new-task').onclick = () => selectTicket(null);
element('refresh').onclick = () => { element('task-error').textContent = ''; return refresh(); };
refresh();
setInterval(refresh, 3000);
`
