$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node.exe).Source
$entry = Join-Path $scriptDir 'src\index.js'
$taskName = 'Hearth H8 Diary'

$action = New-ScheduledTaskAction -Execute $node -Argument ('"{0}"' -f $entry) -WorkingDirectory $scriptDir
$trigger = New-ScheduledTaskTrigger -Daily -At '00:10'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Hearth H8: extract yesterday Claude sessions, summarize with DeepSeek, write stream diary.' -Force | Out-Null
Write-Host "Registered scheduled task: $taskName (daily 00:10, StartWhenAvailable)"
