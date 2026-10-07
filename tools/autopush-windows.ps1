# Z AutoPush: watches the local Z repos and pushes edits to GitHub automatically.
# Runs hidden at logon (scheduled task "ZAutoPush"). Debounces edits for ~40s
# so half-finished saves get grouped into one commit.
# Disable:  schtasks /Delete /TN ZAutoPush /F

$ErrorActionPreference = "Continue"
$repos = @(
  "C:\Users\charles\Documents\Default Project\z-chat-app",
  "C:\Users\charles\Documents\Default Project\zgames",
  "C:\Users\charles\Documents\Default Project\z-services"
)
$logPath = "C:\Users\charles\.z-autopush\autopush.log"

function Log([string]$message) {
  try { "$(Get-Date -Format s)  $message" | Add-Content -Path $logPath } catch {}
}

Log "watcher started"

$state = @{}

while ($true) {
  foreach ($repo in $repos) {
    if (-not (Test-Path (Join-Path $repo ".git"))) { continue }
    try {
      Push-Location $repo
      $status = (& git status --porcelain 2>$null) -join "`n"
      Pop-Location
    } catch { continue }

    if (-not $status) { $state[$repo] = $null; continue }

    $prev = $state[$repo]
    if ($prev -and $prev.status -eq $status -and ((Get-Date) - $prev.since).TotalSeconds -ge 40) {
      try {
        Push-Location $repo
        & git add -A 2>$null | Out-Null
        & git commit -m "auto: save $(Get-Date -Format 'yyyy-MM-dd HH:mm')" 2>$null | Out-Null
        & git push 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
          & git fetch origin main 2>$null | Out-Null
          & git pull --rebase origin main 2>$null | Out-Null
          & git push 2>$null | Out-Null
        }
        Pop-Location
        Log "pushed $repo"
      } catch {
        Log "push failed for $repo : $_"
      }
      $state[$repo] = $null
    } elseif (-not $prev -or $prev.status -ne $status) {
      $state[$repo] = @{ status = $status; since = Get-Date }
    }
  }
  Start-Sleep -Seconds 20
}
