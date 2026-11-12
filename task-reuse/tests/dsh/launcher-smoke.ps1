[CmdletBinding()]
param([string]$DshEntry)

$ErrorActionPreference = 'Stop'

function Assert-Condition($Condition, $Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-WorkflowPatch($Path, $Workspace) {
    Assert-Condition (Test-Path -LiteralPath $Path -PathType Leaf) 'The launcher did not return a usable overlay.'
    $overlay = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    $config = @($overlay)[0].insert[0].config
    Assert-Condition ($config.serverName -ceq 'task_reuse' -and $config.transport -ceq 'stdio') 'Incorrect MCP registration.'
    Assert-Condition ($config.args[-1] -ceq '--dsh-workflows') 'The overlay did not select the workflow tools.'
    Assert-Condition ($config.env.TASK_REUSE_WORKSPACE -ceq $Workspace) 'The overlay resolved a different workspace.'
}

$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath
if (-not $DshEntry) {
    $DshEntry = Join-Path (Split-Path -Parent $project) 'DeepSeek-Harness\runtime\node_modules\@deepseek-ai\dsh\lib\bin.js'
}
$DshEntry = (Resolve-Path -LiteralPath $DshEntry).ProviderPath
$testRoot = Join-Path $PSScriptRoot ('launcher smoke ' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$priorHome = $env:DSH_HOME
try {
    Copy-Item -LiteralPath (Join-Path $project 'Start-TaskReuse.ps1') -Destination $testRoot
    Copy-Item -LiteralPath (Join-Path $project 'plugins') -Destination $testRoot -Recurse
    Copy-Item -LiteralPath (Join-Path $project 'examples') -Destination $testRoot -Recurse
    $launcher = Join-Path $testRoot 'Start-TaskReuse.ps1'
    $demo = Join-Path $testRoot '.demo\harness'
    $demoPatch = & $launcher -PatchOnly
    Assert-WorkflowPatch $demoPatch $demo
    foreach ($example in (Get-ChildItem -LiteralPath (Join-Path $project 'examples') -File)) {
        if ($example.Extension -in '.csv', '.json') {
            $staged = Join-Path $demo $example.Name
            Assert-Condition ((Get-FileHash -LiteralPath $staged).Hash -eq (Get-FileHash -LiteralPath $example.FullName).Hash) "Demo copy mismatch for $($example.Name)."
        }
    }

    $edited = Join-Path $demo 'workflow.csv'
    Set-Content -LiteralPath $edited -Value 'local test edit'
    $missing = Join-Path $demo 'first.csv'
    Remove-Item -LiteralPath $missing
    $repeatPatch = & $launcher -PatchOnly
    Assert-WorkflowPatch $repeatPatch $demo
    Assert-Condition ((Get-Content -LiteralPath $edited) -ceq 'local test edit') 'A repeat launch replaced a local file.'
    Assert-Condition (Test-Path -LiteralPath $missing -PathType Leaf) 'A repeat launch did not restore the missing sample.'
    Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $testRoot '.demo\harness-profile'))) 'PatchOnly booted a Harness profile.'

    $workspace = Join-Path $testRoot 'explicit workspace'
    New-Item -ItemType Directory -Path $workspace | Out-Null
    $patch = & $launcher -Workspace $workspace -PatchOnly
    Assert-WorkflowPatch $patch $workspace
    Assert-Condition (@(Get-ChildItem -LiteralPath $workspace -Force).Count -eq 0) 'An explicit workspace received launcher files.'
    Assert-Condition ($env:DSH_HOME -ceq $priorHome) 'The launcher changed the caller Harness home.'

    $env:DSH_HOME = Join-Path $testRoot 'test-profile'
    $composed = & node $DshEntry --profile headless --patch $patch --dump-config
    Assert-Condition ($LASTEXITCODE -eq 0) 'The installed Harness could not compose the launcher overlay.'
    Assert-Condition (($composed -join "`n") -match 'mcp-task-reuse') 'The composed Harness profile lacks the MCP plugin.'
    Write-Output 'Task Reuse launcher smoke passed.'
} finally {
    $env:DSH_HOME = $priorHome
    $target = (Resolve-Path -LiteralPath $testRoot).ProviderPath
    if ((Split-Path -Parent $target) -ceq $PSScriptRoot -and (Split-Path -Leaf $target) -cmatch '^launcher smoke [0-9a-f]{32}$') {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}
