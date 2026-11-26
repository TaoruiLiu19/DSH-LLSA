import { LOCAL_PANEL_SCRIPT } from './local-panel-client.ts'
import { LOCAL_PANEL_STYLE } from './local-panel-style.ts'

export const LOCAL_PANEL = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>本机任务 · DSH LLSA</title>
<style>${LOCAL_PANEL_STYLE}</style>
</head>
<body>
<header class="top"><div class="top-inner">
  <span class="brand">DSH LLSA</span>
  <nav aria-label="相关页面"><a href="/collab">协作记录与用量</a><a href="/">Harness</a></nav>
</div></header>
<main class="layout">
  <h1>本机任务</h1>
  <p class="lead">提交需求与文件，在同一工单查看结果或继续修订。</p>
  <div class="columns">
    <section class="card" aria-labelledby="form-title">
      <div class="card-heading">
        <h2 id="form-title">新工单</h2>
        <button id="new-task" type="button" class="subtle" hidden>返回新工单</button>
      </div>
      <div id="new-only">
        <fieldset>
          <legend>想收到什么</legend>
          <div class="modes">
            <button id="mode-text" type="button" aria-pressed="true">文字答复</button>
            <button id="mode-files" type="button" aria-pressed="false">文件交付</button>
          </div>
        </fieldset>
      </div>
      <label id="prompt-label" class="field-label" for="prompt">任务要求</label>
      <textarea id="prompt" maxlength="20000" placeholder="说明目标、希望收到的结果和验收条件。"></textarea>
      <div id="file-fields" class="file-fields" hidden>
        <label class="field-label" for="artifact-files">新建文件</label>
        <input id="artifact-files" type="text" maxlength="1600" placeholder="例如 index.html, styles.css" aria-describedby="output-help">
        <small id="output-help">多个相对路径用逗号或换行分隔。只修改已有文件时可留空。</small>
        <label class="field-label" for="file-picker">已有文件</label>
        <input id="file-picker" type="file" multiple aria-describedby="file-help">
        <small id="file-help">最多 12 个 UTF-8 文件，单个 180 KiB，总计 512 KiB。添加后可改工作区路径，或标为可修改文件。</small>
        <ul id="uploads" class="uploads" aria-label="已添加的文件"></ul>
      </div>
      <div id="text-fields" class="options">
        <label class="check"><input id="json-output" type="checkbox">使用 JSON 作为最终答复</label>
      </div>
      <div class="actions"><button id="submit" class="primary" type="button">创建工单</button></div>
      <p class="muted">提交时使用已配置的模型，可能产生模型费用。</p>
      <p id="notice" role="status"></p>
      <p id="error" role="alert"></p>
    </section>
    <section class="card" aria-labelledby="tasks-title">
      <div class="card-heading"><h2 id="tasks-title">工单与成品</h2><button id="refresh" class="subtle" type="button">刷新</button></div>
      <div id="tasks"><p class="empty">正在读取工单…</p></div>
      <details id="replies" hidden><summary>其他消息</summary><ul id="reply-list" class="reply-list"></ul></details>
      <p id="task-error" role="alert"></p>
    </section>
  </div>
</main>
<script>${LOCAL_PANEL_SCRIPT}</script>
</body></html>`
