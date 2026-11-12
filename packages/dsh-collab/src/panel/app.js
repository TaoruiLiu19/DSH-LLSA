"use strict";
const $ = (id) => document.getElementById(id);
let current = null,
  local = null,
  jobs = [],
  taskSubmitting = false,
  pendingTask = null,
  calculationBusy = false,
  preview = null,
  runLoadVersion = 0,
  inspectionVersion = 0,
  artifactVersion = 0,
  refreshing = false;
const statuses = {
  queued: "等待开始",
  starting: "正在启动",
  running: "进行中",
  active: "进行中",
  completed: "已完成",
  succeeded: "已通过",
  submitted: "等待验收",
  stopping: "正在结束",
  interrupted: "已中断",
  cancelled: "已取消",
  failed: "失败",
  unknown: "需要核查",
  needs_attention: "需要处理",
  settled: "已结束",
  ready: "等待派发",
  rejected: "未通过验收",
};
const stateLabel = (value) => statuses[value] || String(value || "尚未声明");
const eventLabels = {
  local_task_created: "任务已创建",
  local_task_status: "任务状态更新",
  local_model_admitted: "开始模型调用",
  local_model_result: "模型公开回复",
  local_calculation_input: "本机计算原始输入",
  computation_receipt: "本机计算规则与结果",
  final_result: "最终结果",
  local_calculation_saved: "本机计算已保存",
  step_result: "步骤结果",
  validation_failed: "规则核对未通过",
  tool_observation: "工具返回结果",
  agent_message: "智能体交流记录",
  log_projection: "日志摘要",
  activation_settled: "子任务执行结束",
  result_assessment: "结果验收",
  work_created: "子任务已创建",
  work_started: "子任务已开始",
  run_paused: "派发状态变更",
};
const roleLabels = {
  root: "主智能体",
  coordinator: "协调",
  researcher: "研究",
  reviewer: "复核",
  implementer: "执行",
  tester: "测试",
  worker: "子智能体",
};
const activeJob = (job) =>
  !!job && ["queued", "starting", "running", "stopping"].includes(job.status);
const show = (id, value) => {
  $(id).textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
};
const pick = (x, ...keys) => {
  for (const key of keys)
    if (x && x[key] !== undefined && x[key] !== null) return x[key];
  return "";
};
const errors = {
  LOCAL_UNAVAILABLE: "本机任务功能暂不可用，仍可查看历史。",
  NOT_FOUND: "记录不存在或尚未保存。",
  TASK_BUSY: "已有任务正在执行，请等待完成或先结束。",
  REQUEST_LIMIT: "本次任务已达到调用上限，请查看已保存的结果。",
  TASK_TIMEOUT: "任务已达到时间上限，请查看已保存的结果。",
  BUDGET_LIMIT: "任务已达到用量上限。",
  API_AUTH_ERROR: "模型认证未通过，请在 Harness 设置中检查 API 配置。",
  PREVIEW_EXPIRED: "预览已过期，请重新预览后再保存。",
  INVALID_PREVIEW: "预览已失效，请重新预览。",
  IDEMPOTENCY_CONFLICT:
    "同一请求编号的内容发生变化，请核对任务状态后重新提交。",
  INPUT_TOO_LARGE: "输入超过允许的大小，请减少内容。",
  INVALID_INPUT: "输入不符合要求，请检查数据和所选规则。",
  UNSUPPORTED_NUMBER:
    "数据含不支持精度的数字，请使用整数或把精确标识写成字符串。",
  INVALID_FIELD_TYPE: "字段类型不符合规则，请检查数字、字符串和布尔值。",
  MISSING_FIELD: "部分记录缺少所选字段，请检查数据。",
  INTERNAL_ERROR: "请求未完成，请查看任务状态后再试。",
};
Object.assign(errors, {
  LOCAL_WORKSPACE_UNAVAILABLE: "本机任务功能暂不可用，仍可查看历史。",
  USER_INTERRUPTED: "已按你的请求结束任务，请查看保存的结果。",
  PREVIOUS_PROCESS_ENDED: "上次进程在任务结束前退出，请核对历史后处理。",
  CLEANUP_UNCONFIRMED: "任务清理尚未确认，请核对状态后处理。",
  TASK_FAILED: "任务未能完成，请查看已保存的步骤。",
  TASK_NOT_FOUND: "本机任务不存在。",
  API_RATE_LIMIT: "模型服务限制了请求频率，请查看当前任务后稍后再试。",
  WORKSPACE_CLOSED: "本机任务服务已关闭，请检查启动窗口。",
  UNSAFE_RESULT: "精确结果超过安全整数范围，请拆分计算或采用其他数值方案。",
  TOO_MANY_PREVIEWS: "待确认预览过多，请稍后再试。",
  FORBIDDEN: "该原件不属于所选任务，无法读取。",
});
const errorText = (error) =>
  errors[error.code]
    ? errors[error.code] + "（" + error.code + "）"
    : error.code
      ? "请求未完成（" +
        error.code +
        "）。" +
        (error.message && error.message !== error.code ? error.message : "")
      : error.message || "请求失败";
async function api(path, body) {
  let response;
  try {
    response = await fetch(
      "/collab/api" + path,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
  } catch {
    throw new Error(
      "无法连接本机服务。请检查启动窗口；同一提交重试会沿用请求编号。",
    );
  }
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error("本机服务未返回可读取的结果，请刷新任务状态。");
  }
  if (!response.ok) {
    const error = new Error(
      typeof value.error === "string"
        ? value.error
        : value.error?.message || "请求失败",
    );
    error.code =
      typeof value.error === "string" ? value.error : value.error?.code;
    error.status = response.status;
    throw error;
  }
  return value;
}
function notice(text) {
  show("notice", text);
}
function button(text, action, className) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  if (className) b.className = className;
  b.addEventListener("click", async () => {
    if (b.disabled) return;
    b.disabled = true;
    try {
      await action();
    } catch (error) {
      notice(errorText(error));
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
function empty(container, text) {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  container.append(p);
}
function table(container, heads, rows) {
  container.replaceChildren();
  if (!rows.length) {
    empty(container, "暂无已记录内容");
    return;
  }
  const t = document.createElement("table"),
    tr = document.createElement("tr");
  for (const head of heads) {
    const th = document.createElement("th");
    th.textContent = head;
    tr.append(th);
  }
  t.append(tr);
  for (const row of rows) {
    const line = document.createElement("tr");
    for (const value of row) {
      const cell = document.createElement("td");
      if (value instanceof Node) cell.append(value);
      else
        cell.textContent =
          typeof value === "object"
            ? JSON.stringify(value)
            : String(value ?? "");
      line.append(cell);
    }
    t.append(line);
  }
  container.append(t);
}
function taskControls() {
  const allowed = local?.available === true;
  $("start-task").disabled =
    !allowed || taskSubmitting || !$("task-prompt").value.trim();
  $("preview-calculation").disabled =
    local?.calculationAvailable !== true ||
    calculationBusy ||
    !$("calculation-rows").value.trim();
  $("calculation-field").disabled =
    $("calculation-operation").value === "count";
  $("save-calculation").disabled =
    calculationBusy || !preview || Date.parse(preview.expiresAt) <= Date.now();
}
async function loadStatus() {
  const value = await api("/status");
  show("status", value);
  show("connection", "已连接 · " + String(value.version || "本机插件"));
  try {
    show("protocols", await api("/protocols"));
  } catch (error) {
    show("protocols", errorText(error));
  }
}
async function loadLocal() {
  try {
    local = await api("/local");
    jobs = Array.isArray(local.jobs) ? local.jobs : [];
    show(
      "local-info",
      local.available === true
        ? "本机单用户模式。任务与计算记录保存到本机。"
        : "任务发起暂不可用，可以继续查看历史。",
    );
    show(
      "model-info",
      local.model?.model
        ? "当前模型：" +
            local.model.model +
            "。使用 Harness 已保存的配置，是否可调用以实际结果为准。"
        : "模型配置请在 Harness 设置中检查。",
    );
    show(
      "task-limits",
      "本次最多 " +
        String(local.limits?.maxGenerationRequests ?? "未声明") +
        " 次模型调用，每次输出最多 " +
        String(local.limits?.maxOutputTokens ?? "未声明") +
        " token；父子智能体共用上限。",
    );
  } catch (error) {
    local = null;
    jobs = [];
    show(
      "local-info",
      "当前服务仅能查看历史。本机任务功能尚未启用或连接暂不可用。",
    );
    show("task-limits", errorText(error));
  }
  taskControls();
  renderCurrentJob();
}
function currentJob() {
  return jobs.find((job) => job.runId === current);
}
function renderCurrentJob() {
  const job = currentJob();
  $("interrupt-task").disabled = !activeJob(job) || job.status === "stopping";
  if (job) {
    let text = stateLabel(job.status);
    if (Number.isSafeInteger(job.modelCalls))
      text += " · 已调用模型 " + job.modelCalls + " 次";
    if (job.prompt) text += "\n" + job.prompt;
    if (job.error)
      text +=
        "\n" +
        errorText(
          typeof job.error === "string"
            ? { code: job.error, message: job.error }
            : job.error,
        );
    if (["cancelled", "interrupted"].includes(job.status))
      text += "\n请核对已保存的步骤和结果；不会自动重新执行。";
    if (job.recoveryNotice) text += "\n" + job.recoveryNotice;
    if (job.result !== undefined) {
      text +=
        "\n\n公开结果（" +
        (job.resultProvenance === "host_verified_fields"
          ? "仅绑定规则内的字段已由宿主核对"
          : "模型声明，未由宿主核验") +
        "）：\n" +
        (typeof job.result === "string"
          ? job.result
          : typeof job.result.summary === "string"
            ? job.result.summary
            : JSON.stringify(job.result, null, 2));
    }
    show("job-summary", text);
  } else if (current)
    show("job-summary", "已保存的任务记录。详细结果请查看时间线。");
}
async function loadRuns() {
  const list = await api("/runs");
  const rows = Array.isArray(list) ? list : list.runs || [];
  const target = $("runs");
  target.replaceChildren();
  if (!rows.length)
    empty(
      target,
      "还没有任务。右侧可开始智能体任务，或先用本机计算保存一个结果。",
    );
  for (const run of rows) {
    const id = pick(run, "runId", "run_id", "id"),
      job = jobs.find((item) => item.runId === id);
    target.append(
      button(
        String(pick(run, "title", "name") || id) +
          " · " +
          (job
            ? stateLabel(job.status)
            : run.paused
              ? "已暂停新派发"
              : stateLabel(pick(run, "status", "state") || "已保存")),
        () => selectRun(id),
        "run" + (current === id ? " selected" : ""),
      ),
    );
  }
}
async function selectRun(id) {
  current = id;
  LeanLinkFlow.render({run:{id},agents:[],events:[]});
  inspectionVersion++;
  clearArtifacts();
  notice("");
  show("run-title", "任务详情");
  show("run-data", "正在读取…");
  show("chinese", "请选择时间线事件，或按步骤查询当时结果。");
  show("raw", "");
  for (const key of ["agents", "work-items", "timeline", "usage-summary"])
    $(key).replaceChildren();
  $("inspect").disabled = false;
  renderCurrentJob();
  await Promise.all([loadRun(), loadRuns()]);
}
function renderUsage(usage) {
  show("usage", usage || { status: "unknown" });
  const target = $("usage-summary");
  target.replaceChildren();
  const known = (value, key) => {
    if (!Number.isSafeInteger(value) || value < 0) return "未知";
    const incomplete =
      key && (usage?.missingFields?.[key] ?? usage?.unknownCalls ?? 0) > 0;
    return incomplete
      ? value > 0
        ? "已知 ≥ " + value
        : "未知"
      : String(value);
  };
  for (const [label, key] of [
    ["模型调用", "calls"],
    ["输入 token", "inputTokens"],
    ["输出 token", "outputTokens"],
  ]) {
    const box = document.createElement("div");
    box.className = "stat";
    const heading = document.createElement("span"),
      number = document.createElement("strong");
    heading.textContent = label;
    number.textContent = known(usage?.[key], key === "calls" ? null : key);
    box.append(heading, number);
    target.append(box);
  }
  const synthetic = usage?.usage?.some(
    (call) =>
      call.measurement === "synthetic_fixture" ||
      call.provider === "collab-test",
  );
  show(
    "usage-note",
    synthetic
      ? "包含脚本模拟用量，不是实际模型推理或账单证据。"
      : usage?.unknownCalls > 0
        ? "部分调用用量未知；明细中的合计仅包含已知值，不代表完整消耗。"
        : "供应商回传用量与本地估算分别保存。token 数不等于账单金额；本机直接计算不调用模型。",
  );
}
async function loadRun() {
  if (!current) return;
  const id = current,
    version = ++runLoadVersion;
  try {
    const data = await api("/runs/" + encodeURIComponent(id));
    if (id !== current || version !== runLoadVersion) return;
    // The local status endpoint lists the newest 50 jobs. Older selected tasks
    // still have their own read-only endpoint and immutable creation record.
    if (local?.available === true && !currentJob()) {
      const jobId = data.events?.find(
        (event) => event.kind === "local_task_created",
      )?.payload?.job?.id;
      if (jobId) {
        try {
          const job = await api("/local/tasks/" + encodeURIComponent(jobId));
          if (job.runId === id)
            jobs = [job, ...jobs.filter((item) => item.id !== job.id)];
        } catch (error) {
          if (id === current) notice(errorText(error));
        }
      }
    }
    if (id !== current || version !== runLoadVersion) return;
    show("run-title", data.run?.title || "任务详情");
    show("run-data", data.run || {});
    renderUsage(data.usage);
    LeanLinkFlow.render(data);
    renderCurrentJob();
    const items = data.workItems || [],
      agents = data.agents || [];
    const uncertain =
      items.some((item) => item.state === "unknown") ||
      ["unknown", "needs_attention"].includes(currentJob()?.status);
    show(
      "recovery-notice",
      uncertain
        ? "这项任务需要人工核查。请先查看已完成的工具与历史结果；不要直接重复提交可能已有外部效果的操作。恢复派发不会自动重新执行状态不明的任务。"
        : "",
    );
    const hasWork = items.some((item) =>
      ["ready", "starting", "running", "stopping"].includes(item.state),
    );
    $("pause").disabled = !hasWork || data.run?.paused === true;
    $("resume").disabled = data.run?.paused !== true;
    table(
      $("agents"),
      ["角色", "智能体", "状态", "操作"],
      agents.map((agent) => {
        const aid = pick(agent, "agentId", "agent_id", "id"),
          item = items.find((work) => work.childId === aid);
        let control = "—";
        if (
          agent.parentId &&
          item &&
          ["starting", "running"].includes(item.state)
        ) {
          control = button("中断子任务", async () => {
            await api("/runs/" + encodeURIComponent(id) + "/interrupt", {
              agentId: aid,
            });
            if (current === id) {
              notice("已请求中断子任务，请查看后续状态。");
              await loadRun();
            }
          });
        }
        return [
          roleLabels[agent.role] || pick(agent, "role"),
          pick(agent, "name", "agentId", "agent_id", "id"),
          stateLabel(pick(agent, "state", "status", "lifecycle_state")),
          control,
        ];
      }),
    );
    table(
      $("work-items"),
      ["子任务", "状态", "依赖"],
      items.map((work) => [
        pick(work, "title", "objective", "workItemId", "work_item_id", "id"),
        stateLabel(pick(work, "state", "status")),
        pick(work, "dependsOn", "dependencies", "depends_on"),
      ]),
    );
    const target = $("timeline");
    target.replaceChildren();
    for (const event of data.events || []) {
      const step = pick(event, "stepId", "step_id"),
        seq = pick(event, "runSeq", "run_seq", "seq"),
        attempt = pick(event, "attemptId", "attempt_id");
      const kind = pick(event, "kind", "type");
      target.append(
        button(
          String(seq) +
            " · " +
            (eventLabels[kind] || String(kind)) +
            " · " +
            String(step || pick(event, "id", "event_id")),
          async () => {
            if (current !== id) return;
            $("step-id").value = step;
            $("attempt-id").value = attempt;
            $("as-of").value = seq;
            await inspect();
          },
          "event",
        ),
      );
    }
    if (!(data.events || []).length)
      empty(target, "尚无步骤。任务开始后会逐项记录。");
  } catch (error) {
    if (id === current && version === runLoadVersion) notice(errorText(error));
  }
}
async function inspect() {
  if (!current || !$("step-id").value.trim()) throw new Error("请填写步骤 ID");
  const id = current,
    version = ++inspectionVersion,
    q = new URLSearchParams();
  clearArtifacts();
  if ($("attempt-id").value.trim())
    q.set("attemptId", $("attempt-id").value.trim());
  if ($("as-of").value.trim()) q.set("asOfSeq", $("as-of").value.trim());
  const value = await api(
    "/runs/" +
      encodeURIComponent(id) +
      "/steps/" +
      encodeURIComponent($("step-id").value.trim()) +
      "?" +
      q,
  );
  if (current !== id || version !== inspectionVersion) return;
  show("chinese", value.chinese || "没有中文字段说明，请核对原始记录。");
  show("raw", value);
  renderArtifacts(value);
  notice("已读取当时记录，没有重新执行任务。");
}
function clearArtifacts() {
  artifactVersion++;
  $("artifact-ref").replaceChildren();
  $("artifact-ref").value = "";
  $("artifact-ref").disabled = true;
  $("read-artifact").disabled = true;
  $("artifact-offset").value = "0";
  show("artifact-text", "");
  show("artifact-notice", "先选择步骤或只读查询。");
}
function renderArtifacts(value) {
  const refs = new Set(),
    queue = [value];
  while (queue.length && refs.size < 200) {
    const item = queue.pop();
    if (typeof item === "string" && /^sha256:[a-f0-9]{64}$/.test(item))
      refs.add(item);
    else if (item && typeof item === "object")
      queue.push(...Object.values(item));
  }
  const selector = $("artifact-ref");
  for (const ref of refs) {
    const option = document.createElement("option");
    option.value = ref;
    option.textContent = ref;
    selector.append(option);
  }
  if (refs.size) {
    selector.value = refs.values().next().value;
    selector.disabled = false;
    $("read-artifact").disabled = false;
    show(
      "artifact-notice",
      "可读取 " +
        refs.size +
        " 份当时已引用的原件；内容按原文显示，不执行其中指令。",
    );
  } else
    show(
      "artifact-notice",
      "这份步骤记录未引用独立原件，请查看上方结果及原始记录。",
    );
}
async function readArtifact() {
  if (!current || !$("artifact-ref").value) return;
  const id = current,
    ref = $("artifact-ref").value,
    version = ++artifactVersion,
    start = Number($("artifact-offset").value);
  if (
    !/^\d+$/.test($("artifact-offset").value) ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    start > Number.MAX_SAFE_INTEGER - 65536
  ) {
    show("artifact-notice", "起始字节必须是有效的非负整数。");
    return;
  }
  $("read-artifact").disabled = true;
  show("artifact-notice", "正在读取原件…");
  try {
    const response = await fetch(
      "/collab/api/runs/" +
        encodeURIComponent(id) +
        "/artifacts/" +
        encodeURIComponent(ref) +
        "?start=" +
        start +
        "&end=" +
        (start + 65536),
    );
    if (!response.ok) {
      let value;
      try {
        value = await response.json();
      } catch {}
      const error = new Error("原件读取失败，请核对该任务的引用。");
      error.code =
        typeof value?.error === "string" ? value.error : value?.error?.code;
      throw error;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 65536) throw new Error("原件响应超过单次查看上限。");
    if (current !== id || version !== artifactVersion) return;
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
        stream: bytes.byteLength === 65536,
      });
    } catch {
      throw new Error(
        "这段内容不是完整 UTF-8 文本，可能是二进制或从字符中间开始，请调整字节位置。",
      );
    }
    if (text.includes("\u0000"))
      throw new Error("这份原件包含二进制内容，无法作为文本显示。");
    const displayedBytes = new TextEncoder().encode(text).length;
    show("artifact-text", text);
    show(
      "artifact-notice",
      "只读原件 · 起始字节 " +
        start +
        " · 已显示 " +
        displayedBytes +
        " 字节" +
        (bytes.byteLength === 65536
          ? "；可能还有后续内容，可从字节 " +
            (start + displayedBytes) +
            " 继续。"
          : "。") +
        " 内容未调用模型解释。",
    );
  } catch (error) {
    if (current === id && version === artifactVersion) {
      show("artifact-text", "");
      show("artifact-notice", errorText(error));
    }
  } finally {
    if (current === id && version === artifactVersion)
      $("read-artifact").disabled = false;
  }
}
async function pause(paused) {
  if (!current) return;
  const id = current;
  await api("/runs/" + encodeURIComponent(id) + "/pause", { paused });
  if (current === id) {
    notice(
      paused
        ? "已暂停新派发；正在进行的操作继续执行。"
        : "已继续派发可启动的任务；状态不明的任务不会自动重跑。",
    );
    await loadRun();
  }
}
async function startTask() {
  if (taskSubmitting || local?.available !== true) return;
  const prompt = $("task-prompt").value.trim();
  if (!prompt) return;
  const limit = local.limits?.maxInputBytes ?? 49152;
  if (new TextEncoder().encode(prompt).length > limit) {
    show("task-notice", "任务内容过长，请减少内容后再提交。");
    return;
  }
  if (!pendingTask || pendingTask.prompt !== prompt)
    pendingTask = { prompt, requestId: crypto.randomUUID() };
  taskSubmitting = true;
  taskControls();
  show("task-notice", "正在提交；请勿重复点击。");
  try {
    const value = await api("/local/tasks", pendingTask);
    pendingTask = null;
    $("task-prompt").value = "";
    jobs = [value, ...jobs.filter((job) => job.id !== value.id)];
    show(
      "task-notice",
      "任务已创建。模型调用会产生 API 用量，过程保存在下方。",
    );
    await selectRun(value.runId);
    await loadLocal();
  } catch (error) {
    show("task-notice", errorText(error));
  } finally {
    taskSubmitting = false;
    taskControls();
  }
}
async function interruptTask() {
  const job = currentJob();
  if (!activeJob(job) || job.status === "stopping") return;
  const id = job.id;
  $("interrupt-task").disabled = true;
  try {
    await api("/local/tasks/" + encodeURIComponent(id) + "/interrupt", {});
    notice("已请求结束当前任务；请核对已完成步骤，外部效果不会撤销。");
    await loadLocal();
    await loadRun();
  } catch (error) {
    notice(errorText(error));
    renderCurrentJob();
  }
}
function invalidatePreview() {
  preview = null;
  $("calculation-result").hidden = true;
  show("calculation-notice", "");
  taskControls();
}
function calculationInput() {
  const rowsJSON = $("calculation-rows").value.trim();
  let rows;
  try {
    rows = JSON.parse(rowsJSON);
  } catch {
    throw new Error("数据不是有效 JSON，请检查引号、逗号和方括号。");
  }
  if (
    !Array.isArray(rows) ||
    !rows.every((row) => row && typeof row === "object" && !Array.isArray(row))
  )
    throw new Error("数据必须是 JSON 对象数组。");
  const input = { rowsJSON, operation: $("calculation-operation").value };
  if (input.operation === "sum") {
    input.field = $("calculation-field").value.trim();
    if (!input.field) throw new Error("请填写求和字段。");
  }
  const field = $("filter-field").value.trim();
  if (field) {
    const valueJSON = $("filter-value").value.trim();
    let value;
    try {
      value = JSON.parse(valueJSON);
    } catch {
      throw new Error('筛选值需写成 JSON，例如 true、80 或 "完成"。');
    }
    if (value !== null && typeof value === "object")
      throw new Error("筛选值只能是字符串、数字、布尔值或 null。");
    input.filter = { field, op: $("filter-op").value, valueJSON };
  }
  if ($("calculation-unit").value.trim())
    input.unit = $("calculation-unit").value.trim();
  if (
    new TextEncoder().encode(JSON.stringify(input)).length >
    (local?.limits?.maxInputBytes ?? 49152)
  )
    throw new Error("数据过大，请减少记录后再预览。");
  return input;
}
function readableRule(rule) {
  if (typeof rule === "string") return rule;
  if (!rule || typeof rule !== "object") return "请核对原始预览。";
  const ops = {
      eq: "等于",
      ne: "不等于",
      lt: "小于",
      lte: "小于或等于",
      gt: "大于",
      gte: "大于或等于",
    },
    filters = Array.isArray(rule.filter) ? rule.filter : [];
  const condition = filters.length
    ? "筛选 " +
      filters
        .map(
          (item) =>
            item.field +
            " " +
            (ops[item.op] || item.op) +
            " " +
            JSON.stringify(item.value),
        )
        .join("，且 ")
    : "不筛选，使用全部记录";
  return (
    condition +
    "；" +
    (rule.operation === "sum" ? "对 " + rule.field + " 求和" : "统计记录条数") +
    "；单位：" +
    (rule.unit || "原始单位") +
    "；" +
    (rule.precision || "安全整数") +
    "；" +
    (rule.nullPolicy || "拒绝空数值") +
    "。"
  );
}
function showCalculationPreview(value) {
  show("calculation-rule", readableRule(value.ruleSummary));
  const result = value.result,
    primary =
      result && typeof result === "object"
        ? (result.total ?? result.matchedRows ?? JSON.stringify(result))
        : result;
  show(
    "calculation-preview",
    "结果：" +
      String(primary) +
      "\n匹配记录：" +
      value.matchedRows +
      " / " +
      value.inputRows +
      "\n模型调用：" +
      value.modelCalls +
      " 次",
  );
  show("calculation-raw", value);
}
async function previewCalculation() {
  if (calculationBusy || local?.calculationAvailable !== true) return;
  let input;
  try {
    input = calculationInput();
  } catch (error) {
    show("calculation-notice", errorText(error));
    return;
  }
  calculationBusy = true;
  preview = null;
  const fingerprint = JSON.stringify(input);
  taskControls();
  $("calculation-result").hidden = true;
  show("calculation-notice", "正在本机核对规则与数值…");
  try {
    const value = await api("/local/calculations/preview", input);
    let unchanged = false;
    try {
      unchanged = JSON.stringify(calculationInput()) === fingerprint;
    } catch {}
    if (!unchanged) {
      show("calculation-notice", "输入已改变，请重新预览。");
      return;
    }
    preview = { ...value, fingerprint, requestId: crypto.randomUUID() };
    showCalculationPreview(value);
    $("calculation-result").hidden = false;
    show(
      "calculation-notice",
      "预览未保存，也没有调用模型。确认规则和结果后再保存。",
    );
  } catch (error) {
    show("calculation-notice", errorText(error));
  } finally {
    calculationBusy = false;
    taskControls();
  }
}
async function saveCalculation() {
  if (calculationBusy || !preview) return;
  let unchanged = false;
  try {
    unchanged = JSON.stringify(calculationInput()) === preview.fingerprint;
  } catch {}
  if (!unchanged || Date.parse(preview.expiresAt) <= Date.now()) {
    invalidatePreview();
    show("calculation-notice", "输入已改变或预览已过期，请重新预览。");
    return;
  }
  calculationBusy = true;
  taskControls();
  try {
    const saved = await api("/local/calculations/commit", {
      previewId: preview.previewId,
      requestId: preview.requestId,
    });
    preview = null;
    show(
      "calculation-notice",
      "结果已保存，可在时间线中回看；模型调用为 0 次。",
    );
    await selectRun(saved.runId);
  } catch (error) {
    show("calculation-notice", errorText(error));
  } finally {
    calculationBusy = false;
    taskControls();
  }
}
async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  try {
    const results = await Promise.allSettled([loadStatus(), loadLocal()]);
    if (results[0].status === "rejected") {
      show("connection", "连接暂不可用");
      notice(errorText(results[0].reason));
    }
    await Promise.all([loadRuns(), loadRun()]);
  } catch (error) {
    notice(errorText(error));
  } finally {
    refreshing = false;
  }
}
$("task-prompt").addEventListener("input", taskControls);
$("start-task").addEventListener("click", startTask);
$("interrupt-task").addEventListener("click", interruptTask);
$("preview-calculation").addEventListener("click", previewCalculation);
$("save-calculation").addEventListener("click", saveCalculation);
for (const id of [
  "calculation-rows",
  "calculation-operation",
  "calculation-field",
  "filter-field",
  "filter-op",
  "filter-value",
  "calculation-unit",
])
  for (const event of ["input", "change"])
    $(id).addEventListener(event, invalidatePreview);
$("calculation-example").addEventListener("click", () => {
  $("calculation-rows").value = JSON.stringify(
    [
      { id: "001", amount: 80, active: true },
      { id: "002", amount: 91, active: true },
      { id: "003", amount: 9, active: false },
    ],
    null,
    2,
  );
  $("calculation-operation").value = "sum";
  $("calculation-field").value = "amount";
  $("filter-field").value = "active";
  $("filter-op").value = "eq";
  $("filter-value").value = "true";
  invalidatePreview();
});
$("refresh").addEventListener("click", refreshAll);
$("inspect").addEventListener("click", () =>
  inspect().catch((error) => notice(errorText(error))),
);
$("read-artifact").addEventListener("click", readArtifact);
$("artifact-ref").addEventListener("change", () => {
  artifactVersion++;
  show("artifact-text", "");
  $("read-artifact").disabled = !$("artifact-ref").value;
  show("artifact-notice", "已选择原件，点击读取查看。");
});
$("artifact-offset").addEventListener("input", () => {
  artifactVersion++;
  show("artifact-text", "");
  $("read-artifact").disabled = !$("artifact-ref").value;
});
$("pause").addEventListener("click", () =>
  pause(true).catch((error) => notice(errorText(error))),
);
$("resume").addEventListener("click", () =>
  pause(false).catch((error) => notice(errorText(error))),
);
void refreshAll();
setInterval(() => {
  if (!document.hidden) {
    taskControls();
    void refreshAll();
  }
}, 4000);

LeanLinkFlow.init();
