# Lyca contact-store catch-up go-live (HIR-526). Run it by hand, once, after the HIR-526 PR (and
# HIR-528's, if merged) is merged and main is checked out. Runbook: docs/CONTACT_REVEAL.md,
# "Going live". Lyca project adfubeifnsgxwmpfslkt only, never Adobe's. In order:
#   0. refuses a checkout with uncommitted changes; shows branch + commit (asks if not origin/main);
#      shows the sha256 of each SQL file it will run (workspaces/lyca/ops/) and asks you to confirm
#   1. migrations: dry run first, asks, then db-push (functions-deploy refuses while any is missing)
#   2. deploys candidate-contacts and contact-store-sync
#   3. generates a new random CONTACT_STORE_SYNC_SECRET and sets it as a function secret
#   4. stores the function URL + that secret in Supabase Vault and schedules the pg_cron job
#      (every 10 min, pg_net timeout 90 s) with workspaces/lyca/ops/contact-store-sync-schedule.sql
#   5. FAILS unless the job is active and its own call (URL + secret read from Vault, sent by pg_net)
#      answers HTTP 200; then calls the function once more directly and prints the counts
# The secret is never printed. It exists in memory, in one temporary env file for `secrets set`
# (deleted right after, also on failure), and in env LYCA_SQL_SYNC_SECRET for step 4 only:
# lyca-deploy.mjs fills it into a copy of the SQL inside its own throw-away work directory and
# prints the CLI's output with it replaced by [redacted]. Stops at the first failure; safe to run
# again (a rerun makes a NEW secret and sets it in both places).
#
# Run from the repo root:  pwsh -File scripts/lyca-store-sync-go-live.ps1   (or Windows PowerShell)
# If step 4 fails through the CLI, run again with -PasteSql: the filled-in SQL is then put on the
# clipboard for you to paste into the Supabase SQL editor, and the clipboard is cleared after Enter.
param([switch]$PasteSql)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$ref = 'adfubeifnsgxwmpfslkt'
$functionUrl = "https://$ref.supabase.co/functions/v1/contact-store-sync"
$ops = 'workspaces/lyca/ops'
$sqlFiles = @(
  'contact-store-sync-schedule.sql',
  'contact-store-sync-check-job.sql',
  'contact-store-sync-test-call.sql',
  'contact-store-sync-wait-answer.sql'
)
$utf8 = New-Object System.Text.UTF8Encoding $false
$tmpEnv = Join-Path ([System.IO.Path]::GetTempPath()) ("lyca-store-sync-" + [Guid]::NewGuid().ToString('N') + '.env')
$secret = $null
$clipboardUsed = $false
$hashes = @{}

# One reviewed SQL file through lyca-deploy.mjs db-query, with the sha256 confirmed in step 0.
function Invoke-OpsQuery([string]$file) {
  $env:LYCA_DB_QUERY_SHA256 = $hashes[$file]
  try {
    node scripts/lyca-deploy.mjs db-query $file
    return ($LASTEXITCODE -eq 0)
  } finally {
    Remove-Item Env:\LYCA_DB_QUERY_SHA256 -ErrorAction SilentlyContinue
  }
}

Push-Location $repo
try {
  Write-Host "`n== 0/5 checkout" -ForegroundColor Cyan
  $dirty = git status --porcelain
  if ($LASTEXITCODE -ne 0) { throw 'git status failed' }
  if ($dirty) {
    git status --short
    throw 'This checkout has uncommitted changes (listed above): commit, stash or discard them first. Nothing was changed.'
  }
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  $head = (git rev-parse HEAD).Trim()
  Write-Host "branch: $branch"
  Write-Host "commit: $head"
  git fetch --quiet origin main
  $originMain = (git rev-parse origin/main).Trim()
  if ($branch -ne 'main') { Write-Warning "not on main (on $branch)" }
  if ($head -ne $originMain) { Write-Warning "HEAD is not origin/main ($originMain)" }
  if (($branch -ne 'main') -or ($head -ne $originMain)) {
    $go = Read-Host 'Deploy THIS commit to Lyca anyway? (yes/no)'
    if ($go -ne 'yes') { throw 'Stopped: nothing was changed.' }
  }
  if (-not (Test-Path 'workspaces/lyca/migrations/20261029000001_contact_store_sync.sql')) {
    throw 'This checkout has no HIR-526 migration: check out the merged main first.'
  }
  if (-not (Test-Path 'supabase/functions/contact-store-sync/index.ts')) {
    throw 'This checkout has no contact-store-sync function: check out the merged main first.'
  }
  # The sha256 lyca-deploy.mjs checks is of the committed file (git's line endings); it prints them.
  $listed = node scripts/lyca-deploy.mjs ops-sha256
  if ($LASTEXITCODE -ne 0) { throw 'could not hash the SQL files in workspaces/lyca/ops' }
  foreach ($line in $listed) {
    $parts = "$line".Trim() -split '\s+'
    if ($parts.Count -eq 2) { $hashes[(Split-Path -Leaf $parts[1])] = $parts[0] }
  }
  Write-Host "SQL this script runs on Lyca (sha256 of the committed file):"
  foreach ($f in $sqlFiles) {
    if (-not $hashes[$f]) { throw "missing in this commit: $ops/$f" }
    Write-Host ("  {0}  {1}" -f $hashes[$f], "$ops/$f")
  }
  $ok = Read-Host 'Read these files at this commit. Are they the reviewed ones? (yes/no)'
  if ($ok -ne 'yes') { throw 'Stopped: nothing was changed.' }
  $env:LYCA_DEPLOY_CONFIRM = $ref

  Write-Host "`n== 1/5 migrations (dry run first)" -ForegroundColor Cyan
  node scripts/lyca-deploy.mjs db-push-dry-run
  if ($LASTEXITCODE -ne 0) { throw 'migration dry run failed: nothing was changed' }
  Write-Host 'Expected above: 20261029000001_contact_store_sync.sql, and 20261029000002_contact_lookup_claims.sql once HIR-528 is merged (or nothing, on a rerun).'
  $answer = Read-Host "`nApply the migration(s) listed above to Lyca? (yes/no; on a rerun with nothing listed, yes applies nothing)"
  if ($answer -ne 'yes') { throw 'Stopped before the migrations: nothing was changed.' }
  node scripts/lyca-deploy.mjs db-push
  if ($LASTEXITCODE -ne 0) { throw 'migration failed: nothing else was changed' }

  Write-Host "`n== 2/5 function deploys" -ForegroundColor Cyan
  foreach ($fn in @('candidate-contacts', 'contact-store-sync')) {
    node scripts/lyca-deploy.mjs functions-deploy $fn
    if ($LASTEXITCODE -ne 0) { throw "deploy of $fn failed (migrations applied; safe to run this script again)" }
  }

  Write-Host "`n== 3/5 CONTACT_STORE_SYNC_SECRET (new, random, not shown)" -ForegroundColor Cyan
  $bytes = New-Object byte[] 48
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  $secret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  [System.IO.File]::WriteAllText($tmpEnv, "CONTACT_STORE_SYNC_SECRET=$secret`n", $utf8)
  try {
    npx supabase secrets set --project-ref $ref --env-file $tmpEnv
    $setOk = $LASTEXITCODE -eq 0
  } finally {
    Remove-Item $tmpEnv -Force -ErrorAction SilentlyContinue
  }
  if (-not $setOk) { throw 'setting the secret failed (migrations + functions are live; the sync refuses calls until a secret is set; safe to run again)' }

  Write-Host "`n== 4/5 Vault entries + pg_cron job (every 10 minutes)" -ForegroundColor Cyan
  if ($PasteSql) {
    $template = (git cat-file blob "HEAD:$ops/contact-store-sync-schedule.sql") -join "`n"
    $sql = $template.Replace('__FUNCTION_URL__', $functionUrl).Replace('__SYNC_SECRET__', $secret)
    Set-Clipboard -Value $sql
    $clipboardUsed = $true
    $sql = $null
    Write-Host 'The SQL is on the clipboard. In the Supabase dashboard of project'
    Write-Host "$ref open SQL Editor -> New query, paste (Ctrl+V), Run. Paste it nowhere else."
    Read-Host 'Press Enter after it ran (the clipboard is cleared then)' | Out-Null
    Set-Clipboard -Value ' '
    $clipboardUsed = $false
  } else {
    $env:LYCA_SQL_FUNCTION_URL = $functionUrl
    $env:LYCA_SQL_SYNC_SECRET = $secret
    try {
      $queryOk = Invoke-OpsQuery 'contact-store-sync-schedule.sql'
    } finally {
      Remove-Item Env:\LYCA_SQL_SYNC_SECRET, Env:\LYCA_SQL_FUNCTION_URL -ErrorAction SilentlyContinue
    }
    if (-not $queryOk) { throw 'scheduling failed (secret is set; run again, or run again with -PasteSql)' }
  }

  Write-Host "`n== 5/5 checks (each one fails the script)" -ForegroundColor Cyan
  Write-Host '- the cron job exists, is active, every 10 minutes, with a pg_net timeout'
  if (-not (Invoke-OpsQuery 'contact-store-sync-check-job.sql')) { throw 'no active contact-store-sync cron job: step 4 did not take effect' }

  Write-Host "- the job's own call (URL + secret from Vault, through pg_net) answers HTTP 200"
  $env:LYCA_SQL_SINCE = [DateTime]::UtcNow.AddSeconds(-5).ToString('yyyy-MM-ddTHH:mm:ssZ', [Globalization.CultureInfo]::InvariantCulture)
  try {
    if (-not (Invoke-OpsQuery 'contact-store-sync-test-call.sql')) { throw 'could not run the cron job command' }
    if (-not (Invoke-OpsQuery 'contact-store-sync-wait-answer.sql')) { throw 'the cron job call did not answer HTTP 200 (see the error above; function logs in the dashboard)' }
  } finally {
    Remove-Item Env:\LYCA_SQL_SINCE -ErrorAction SilentlyContinue
  }

  # One more run, called directly, to show the counts. "skipped / store_not_ready" means the store is
  # down right now; the job keeps trying every 10 minutes.
  Write-Host '- one direct run (counts only)'
  $result = Invoke-RestMethod -Method Post -Uri $functionUrl -ContentType 'application/json' -Body '{}' `
    -Headers @{ 'x-contact-store-sync-secret' = $secret } -TimeoutSec 90
  Write-Host ("run: " + ($result | ConvertTo-Json -Depth 4 -Compress))

  Write-Host "`nDone: Lyca re-sends unsynced contacts and thumbs to the shared store every 10 minutes." -ForegroundColor Green
} finally {
  Remove-Item $tmpEnv -Force -ErrorAction SilentlyContinue
  if ($clipboardUsed) { Set-Clipboard -Value ' ' }
  $secret = $null
  $sql = $null
  foreach ($v in @('LYCA_DEPLOY_CONFIRM', 'LYCA_DB_QUERY_SHA256', 'LYCA_SQL_SYNC_SECRET', 'LYCA_SQL_FUNCTION_URL', 'LYCA_SQL_SINCE')) {
    Remove-Item "Env:\$v" -ErrorAction SilentlyContinue
  }
  Pop-Location
}
