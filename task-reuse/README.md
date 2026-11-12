# Task Reuse

Task Reuse 为 DeepSeek Harness 提供本地 CSV 工作流。首次任务可一次提交筛选、去重和计数步骤。常用流程预览、确认一次后，可以在下一批文件上按名称运行。需要按文本分类时，重复内容可以共用一次判断并在本地回填。

当前版本面向 Windows PowerShell 和 DeepSeek Harness 本地会话，已验证 `0.2.2-rc.1`。执行器使用 Python 3.10+ 标准库，支持 UTF-8 或带 BOM 的 UTF-8 逗号分隔 CSV。去重键比较时忽略首尾空白和大小写，保留行的字段内容照原样输出。选「按时间保留最新」时使用 ISO 8601 时间。

## 一键启动

在本目录打开 PowerShell，运行下面的命令。启动器会把合成样例放在 `.demo\harness`，用独立的演示 profile 启动本地 Harness Web。打开启动时给出的链接，按需配置模型。

```powershell
.\Start-TaskReuse.ps1
```

用自己的目录时加 `-Workspace 'E:\我的数据'`。可用 `-Port` 换端口、`-DshEntry` 指定另一个 Harness 的 `lib\bin.js`，或用 `-PatchOnly` 只准备并返回 overlay 路径，交给已有的 Harness 启动命令。默认查找同级的 `DeepSeek-Harness` 安装。

在 DSH-LLSA 仓库里，先按仓库首页安装依赖，然后从仓库根目录运行以下命令。

```powershell
.\task-reuse\Start-TaskReuse.ps1 -DshEntry '.\node_modules\@deepseek-ai\dsh\lib\bin.js'
```

## 预览、保存和复用

在演示会话里依次发送这三条。

1. 「预览 `workflow.csv`。筛选状态为已报名的记录，按邮箱和报名时间保留最新一条，最后按地区计数。」
2. 「确认执行预览，并把这三步保存为 `attendance-report`。」产物应为北区 1、南区 2。
3. 「用 `attendance-report` 处理 `workflow-next.csv`。」新产物应为东区 2、南区 1。保存的流程可在新的 Harness 会话里继续使用。

`mcp__task_reuse__run_csv_pipeline` 支持 1–8 个有序步骤，包括等值筛选、去重和终步分组计数。路径单独提交时，返回列名和总行数。预览返回 `plan_id` 和逐步行数。确认时会重新核对源文件版本，源文件变化就要求重新预览。可用 `list_workflows=true` 查看已保存名称及步骤类型。流程名使用小写字母、数字和连字符，同名流程发生变化时请使用新名称。

若列名变化，回执会指出失败步骤、缺少的列及可用列名。确定新列的含义后，可以用新字段预览这份文件。

### 对重复文本分类

先筛选 `workflow.csv` 中状态为已取消的记录，再用产物的 `output_ref` 调用 `mcp__task_reuse__review_csv`。选择 `取消原因` 列，允许标签为 `时间` 和 `交通`。工具只把选中列的不同文本值和对应 ID 返回给模型。同一文本共用标签，所以分类须只依赖这一列。工具会估计收发字节，重复过少或候选过多时返回 `not_applicable`。

应用标签时提供 `review_id` 和每个 ID 的标签。执行器核对候选覆盖率、标签范围、原文件版本与原行内容，再把标签展开到各行。

## 离线运行组合流程

启动演示后，可以另开一个 PowerShell 直接运行下列命令。也可先运行 `.\Start-TaskReuse.ps1 -PatchOnly` 准备样例。例子用附带的 JSON 步骤预览并保存流程，然后在另一批文件上运行。

```powershell
$tool = '.\plugins\task-reuse\task_reuse.py'
$demo = '.\.demo\harness'
$plan = python $tool --workspace $demo workflow plan workflow.csv --steps-file workflow-steps.json | ConvertFrom-Json
$plan.steps
python $tool --workspace $demo workflow apply $plan.plan_id --save-as attendance-report
python $tool --workspace $demo workflow list
python $tool --workspace $demo workflow run attendance-report --input workflow-next.csv
```

CLI 与 Harness 共享工作区内保存的流程。在会话里已经保存的流程，可直接用最后一条命令执行。CLI 全程在本机运行，模型调用为零。运行回执提供 `output_path`，可在文件管理器中打开。

## 单步去重与表头映射

在本仓库根目录运行。样例中的人名和邮箱均为虚构数据。

```powershell
$tool = '.\plugins\task-reuse\task_reuse.py'
$demo = Join-Path (Get-Location).Path '.demo'
New-Item -ItemType Directory -Force -Path $demo | Out-Null
Copy-Item -Path '.\examples\*.csv' -Destination $demo

python $tool --workspace $demo inspect first.csv
python $tool --workspace $demo preview first.csv --key 邮箱 --time-column 报名时间
```

样例中，小林时间较晚的记录排在文件前面。上面的预览会询问采用哪一种策略。下面明确选择按时间保留最新、执行并保存规则。`first.csv` 的 3 行变成 2 行，保留「小林（更新）」。

```powershell
$plan = python $tool --workspace $demo preview first.csv --key 邮箱 --keep latest_timestamp --time-column 报名时间 | ConvertFrom-Json
python $tool --workspace $demo apply $plan.plan_id --save-as attendance
```

下一批数据可直接复用。`next.csv` 的 4 行变成 3 行，保留「小何（更新）」。这条独立命令在断网时也可以运行，执行器的模型调用数为零。

```powershell
python $tool --workspace $demo run attendance --input next.csv
```

第三份表把 `报名时间` 改成了 `提交时间`。先查看缺失字段，再明确确认映射并保存更新后的规则。

```powershell
python $tool --workspace $demo preview renamed.csv --recipe attendance
$repair = python $tool --workspace $demo preview renamed.csv --recipe attendance --replacement 提交时间 | ConvertFrom-Json
python $tool --workspace $demo apply $repair.plan_id --save-as attendance
```

实际产物位置见 JSON 回执中的 `output_path`。命令行退出码 `2` 表示需要选择策略或确认字段映射。重新演示时，可把 `$demo` 改为 `.demo` 下的新子目录。

## Codex 兼容入口

先按上节创建演示目录，再在仓库根目录运行：

```powershell
python $tool --workspace $demo configure
codex plugin marketplace add .
codex plugin add task-reuse@task-reuse-local
```

如果通过桌面安装，在 Codex 的插件目录中选择 `task-reuse-local` 来源，然后安装 `Task Reuse`。新开一个本地会话，在提示里选择 Task Reuse，或在 CLI 中输入 `$task-reuse`。可直接试这句话：

> 把 first.csv 按邮箱去重，保留最后一条。先让我确认选哪种规则，完成后保存成 codex-attendance。

实际处理自己的文件时，用 `configure` 指向专门存放待处理 CSV 的目录，在会话里提供相对于该目录的路径。插件通过 stdio MCP 与本地执行器通信，模型从工具结果看到字段信息、虚构样例和短回执。Codex 会话本身仍会使用模型；独立 CLI 复用可全程离线。 [Codex 插件安装](https://learn.chatgpt.com/docs/developer-commands#codex-plugin)

## 可选的网页编排

用 `draft` 生成只含目标和表头的提示。若希望使用网页版模型，手动提交提示，把返回的 JSON 保存为演示目录里的 UTF-8 文件 `candidate.json`，再本地预览。

```powershell
$draft = python $tool --workspace $demo draft first.csv --goal '按邮箱去重，按报名时间保留最新一条' | ConvertFrom-Json
$draft.prompt
python $tool --workspace $demo preview first.csv --candidate candidate.json
```

候选规则示例为 `{"key":"邮箱","keep":"latest_timestamp","time_column":"报名时间"}`。预览通过并核对规则后，用 `apply` 提交返回的 `plan_id`。如果策略待确认，可回到上面的显式选择流程。CSV 的执行和验收都在本机完成。

## 本地测试

```powershell
python -B -m unittest discover -s tests -v
.\tests\dsh\launcher-smoke.ps1
node .\tests\dsh\smoke.mjs
python -B .\tests\benchmark.py --rows 10000 100000 --runs 5
```

启动器测试覆盖样例复制、用户文件保留、真实工作区路径及 Harness overlay 加载。Harness 测试在 `0.2.2-rc.1` 的实际 Agent 循环中使用本地脚本响应。用全新的筛选、去重、计数任务对照逐步提交与一次提交，最终 CSV 逐字节一致，MCP 调用由 3 次降至 1 次，脚本模型请求由 4 次降至 2 次。测试还用独立会话完成预览、确认保存和跨文件复用，对比复用参数与完整步骤参数的序列化大小，并核对相同的 CSV 产物。

混合任务测试先筛出 60 条已取消记录，再从分类回执读取 3 种原因并按预设标签回填。测试逐行核对 60 条输出。脚本报告 Harness 序列化的消息及工具定义字节，以及分类输入和标签提交的本地字节估算。计费 token 和实际模型分类准确率需用真实模型另行测量。

只跑新增的组合流程和分类用例时，可执行 `node .\tests\dsh\smoke.mjs --pipeline-only`。

加上 `--ptc` 可对照 Harness 自带的 PTC 模式。测试比较同一个 PTC 程序内的三次 MCP 调用和一次组合调用，记录内层调用与产物数，并核对四种执行路径的最终文件字节。Windows 上本机默认的 workspace-write 在启动 PTC 测试进程时触发 ACL 错误，以下命令只为合成测试子进程设定 Harness 的权限模式。

```powershell
$priorPtcPermission = $env:TASK_REUSE_PTC_PERMISSION_MODE
try {
    $env:TASK_REUSE_PTC_PERMISSION_MODE = 'danger-full-access'
    node .\tests\dsh\smoke.mjs --pipeline-only --ptc
} finally {
    $env:TASK_REUSE_PTC_PERMISSION_MODE = $priorPtcPermission
}
```

本地基准用独立 Python 去重脚本核对每份合成输入的输出字节。手写脚本是固定规则的执行速度基线，插件还会重新验证输入、检查保留行并处理已确认的字段映射。基准分别输出复用耗时和字段变化后的诊断、修复耗时。
