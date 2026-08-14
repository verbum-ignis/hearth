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

# Channel B: monthly compression. Daily 01:00 check; month eligibility is decided
# inside monthly.js using Asia/Shanghai (system clock is Pacific-skewed). Idempotent:
# only fully-ended months past the 60-day observation window get compressed,
# all other days the task exits with zero writes.
$monthlyEntry = Join-Path $scriptDir 'src\monthly.js'
$monthlyName = 'Hearth Monthly Compression'
$monthlyAction = New-ScheduledTaskAction -Execute $node -Argument ('"{0}"' -f $monthlyEntry) -WorkingDirectory $scriptDir
$monthlyTrigger = New-ScheduledTaskTrigger -Daily -At '01:00'
$monthlySettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName $monthlyName -Action $monthlyAction -Trigger $monthlyTrigger -Settings $monthlySettings -Principal $principal -Description 'Hearth Channel B: compress fully-aged diary months into monthly digests; retire originals only after verify passes.' -Force | Out-Null
Write-Host "Registered scheduled task: $monthlyName (daily 01:00 check, compresses only eligible months)"
