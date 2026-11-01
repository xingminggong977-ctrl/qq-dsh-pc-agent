<#
  pc-agent 的登录自启：把 `node src/index.js` 注册成当前用户的计划任务（不需要管理员）。
  首次使用：powershell -ExecutionPolicy Bypass -File install-task.ps1 -Install
  其它动作：-Uninstall / -Status / -Run / -Stop
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'uninstall', 'status', 'run', 'stop')]
  [string]$Action = 'install',
  [string]$TaskName = 'dsh-pc-agent',
  [string]$NodePath = '',
  [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$entry = Join-Path $here 'src\index.js'
if (-not (Test-Path -LiteralPath $entry)) {
  throw "找不到入口：$entry（这个脚本要放在 pc-agent 目录里跑）"
}

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $home_ = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
  $ConfigPath = Join-Path $home_ '.dsh-qq-pc\config.json'
}

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $node) {
    throw 'PATH 里找不到 node.exe，用 -NodePath 指定完整路径'
  }
  $NodePath = $node.Source
}

# 计划任务的 Arguments 是一个字符串，路径里有空格就必须自己加引号
$argList = '"' + $entry + '"'
if (Test-Path -LiteralPath $ConfigPath) {
  $argList = $argList + ' --config "' + $ConfigPath + '"'
}

function Show-Status {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    Write-Host "任务 $TaskName 不存在（还没装）"
    return
  }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host "任务      $TaskName"
  Write-Host "状态      $($task.State)"
  Write-Host "上次运行  $($info.LastRunTime)"
  Write-Host "上次结果  $($info.LastTaskResult)"
  Write-Host "执行命令  $($task.Actions[0].Execute) $($task.Actions[0].Arguments)"
  Write-Host "工作目录  $($task.Actions[0].WorkingDirectory)"
}

switch ($Action) {
  'install' {
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
      Write-Warning "配置文件还不存在：$ConfigPath（照 config.example.json 抄一份，token 不填会被拒启动）"
    }
    $action_ = New-ScheduledTaskAction -Execute $NodePath -Argument $argList -WorkingDirectory $here
    # 桌面机重启/注销后自动回来；PC 关机期间没人轮询，云端会看到 offline，这是预期的
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -StartWhenAvailable `
      -MultipleInstances IgnoreNew `
      -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -RestartCount 3 `
      -RestartInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action_ -Trigger $trigger -Settings $settings -Principal $principal `
      -Description 'QQ 机器人 PC 工具通道的本机代理（长轮询云端 bridge，只跑白名单命令）' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "已注册并启动：$TaskName"
    Write-Host "  node     $NodePath"
    Write-Host "  入口     $entry"
    Write-Host "  配置     $ConfigPath"
    Show-Status
  }
  'uninstall' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已删除任务：$TaskName"
  }
  'status' { Show-Status }
  'run' {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "已触发：$TaskName"
  }
  'stop' {
    Stop-ScheduledTask -TaskName $TaskName
    Write-Host "已停止：$TaskName"
  }
}
