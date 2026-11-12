<#
.SYNOPSIS
Starts DeepSeek Harness Web with the Task Reuse workflow tools.
.DESCRIPTION
Without -Workspace, creates a local demo with synthetic examples and a separate Harness home.
With -Workspace, opens an existing directory using the normal Harness Web profile.
.EXAMPLE
.\Start-TaskReuse.ps1
.EXAMPLE
.\Start-TaskReuse.ps1 -Workspace 'E:\My data' -Port 3100 -NoOpen
.EXAMPLE
$patch = .\Start-TaskReuse.ps1 -Workspace 'E:\My data' -PatchOnly
#>
[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()][string]$Workspace,
    [ValidateRange(1, 65535)][int]$Port = 3098,
    [ValidateNotNullOrEmpty()][string]$DshEntry,
    [switch]$NoOpen,
    [switch]$PatchOnly
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$demo = -not $PSBoundParameters.ContainsKey('Workspace')
$state = Join-Path $PSScriptRoot '.demo'
$sibling = Join-Path (Split-Path -Parent $PSScriptRoot) 'DeepSeek-Harness'
$engine = Join-Path $PSScriptRoot 'plugins\task-reuse\task_reuse.py'
$python = Get-Command python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $python) {
    throw 'Install Python 3.10 or later and make python available on PATH.'
}
& $python.Source -B -c 'import sys; raise SystemExit(sys.version_info < (3, 10))'
if ($LASTEXITCODE -ne 0) {
    throw 'Task Reuse requires Python 3.10 or later. Check which python is available on PATH.'
}

if (-not $PatchOnly) {
    $siblingEntry = -not $PSBoundParameters.ContainsKey('DshEntry')
    if ($siblingEntry) {
        $DshEntry = Join-Path $sibling 'runtime\node_modules\@deepseek-ai\dsh\lib\bin.js'
    }
    if (-not (Test-Path -LiteralPath $DshEntry -PathType Leaf)) {
        throw "DeepSeek Harness entry was not found at '$DshEntry'. Install the sibling DeepSeek-Harness runtime or pass -DshEntry <path to lib\bin.js>."
    }
    $DshEntry = (Resolve-Path -LiteralPath $DshEntry).ProviderPath
    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) {
        throw 'Install a Node.js version supported by your DeepSeek Harness runtime and make node available on PATH. Harness 0.2.2-rc.1 requires Node.js 24.9 or later.'
    }
}

if ($demo) {
    $Workspace = Join-Path $state 'harness'
    New-Item -ItemType Directory -Path $Workspace -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'examples') -File | Where-Object {
        $_.Extension -in '.csv', '.json'
    } | ForEach-Object {
        $destination = Join-Path $Workspace $_.Name
        if (-not [IO.File]::Exists($destination)) {
            try {
                [IO.File]::Copy($_.FullName, $destination, $false)
            } catch [IO.IOException] {
                if (-not [IO.File]::Exists($destination)) { throw }
            }
        }
    }
}
if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
    throw "Workspace '$Workspace' is not an existing directory. Pass -Workspace <directory> or omit it for the demo."
}
$Workspace = (Resolve-Path -LiteralPath $Workspace).ProviderPath

$patchDirectory = Join-Path $state 'launcher-patches'
New-Item -ItemType Directory -Path $patchDirectory -Force | Out-Null
$patch = Join-Path $patchDirectory ('workflows-{0}.patch.yml' -f [Guid]::NewGuid().ToString('N'))
$patchResult = & $python.Source -B $engine --workspace $Workspace dsh-patch --workflows --output $patch
if ($LASTEXITCODE -ne 0) {
    throw "Task Reuse could not generate the workflow overlay for '$Workspace'. $($patchResult -join ' ')"
}
if ($PatchOnly) {
    Write-Output $patch
    return
}

$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $node.Source
$start.WorkingDirectory = $Workspace
$start.UseShellExecute = $false
$arguments = @($DshEntry, '--profile', 'web', '--patch', $patch, '--host', '127.0.0.1', '--port', [string]$Port)
if ($NoOpen) { $arguments += '--no-open' }
# Paths are resolved Windows files, so none contain quotes or end in a separator.
$start.Arguments = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
if ($demo) {
    $start.EnvironmentVariables['DSH_HOME'] = Join-Path $state 'harness-profile'
} elseif ($siblingEntry -and [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
    $existingHome = Join-Path $sibling 'home'
    if (Test-Path -LiteralPath (Join-Path $existingHome 'profiles\web\package.json') -PathType Leaf) {
        $start.EnvironmentVariables['DSH_HOME'] = $existingHome
    }
}

$process = $null
try {
    Write-Host "Task Reuse workspace: $Workspace"
    if ($demo) {
        Write-Host 'Open the local Harness URL and try the ordered CSV workflow in workflow.csv.'
    }
    $process = [System.Diagnostics.Process]::Start($start)
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "DeepSeek Harness exited with code $($process.ExitCode). See its diagnostic above. If port $Port is in use, pass another -Port."
    }
} finally {
    if ($null -ne $process) { $process.Dispose() }
    Remove-Item -LiteralPath $patch -ErrorAction SilentlyContinue
}
