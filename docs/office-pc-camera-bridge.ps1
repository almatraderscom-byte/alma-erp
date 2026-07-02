# ALMA office PC camera bridge (PowerShell 5.1 compatible).
#
# WHY: Vercel cannot reach the office LAN, so this script runs on the office
# Windows PC (the same one running go2rtc) and bridges the two worlds:
# it polls the ALMA server for queued Bangla announcements and, when one
# arrives, tells the local go2rtc to pull the MP3 and play it out through
# the camera's two-way-audio speaker.
#
# Setup:
#   1. Put the bridge token (from the owner) in C:\go2rtc\bridge-token.txt
#      (single line, no quotes).
#   2. Run this script in a PowerShell window, or register it as a
#      scheduled task at logon: powershell -ExecutionPolicy Bypass -File <path>
#
# It never exits on its own: every iteration is wrapped in try/catch so a
# network blip or a bad job cannot kill the loop.

$Api = 'https://alma-erp-six.vercel.app'
$Go2rtc = 'http://localhost:1984'
$TokenFile = 'C:\go2rtc\bridge-token.txt'
$IntervalSec = 7

# --- Startup: load the bearer token -----------------------------------------
if (-not (Test-Path $TokenFile)) {
    Write-Host "ERROR: token file not found: $TokenFile"
    Write-Host "Create it with the bridge token on a single line, then re-run."
    exit 1
}
$Token = (Get-Content -Raw $TokenFile).Trim()
if ([string]::IsNullOrEmpty($Token)) {
    Write-Host "ERROR: token file is empty: $TokenFile"
    exit 1
}

$Headers = @{ Authorization = "Bearer $Token" }
Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') camera bridge started (poll every $IntervalSec s)"

# --- Main loop ---------------------------------------------------------------
while ($true) {
    try {
        # 1. Ask the server for the next queued announcement.
        $r = Invoke-RestMethod -Method GET "$Api/api/assistant/internal/camera-bridge" -Headers $Headers -TimeoutSec 20

        # 2. Nothing queued -> just wait and poll again.
        if ($null -eq $r.job) {
            Start-Sleep $IntervalSec
            continue
        }

        # 3. Tell go2rtc to play the MP3 into the camera's backchannel stream.
        #    pcma (G.711 a-law) is what the camera's speaker expects.
        $ok = $true
        $errMsg = ''
        $src = 'ffmpeg:' + $r.job.audioUrl + '#audio=pcma'
        $enc = [uri]::EscapeDataString($src)
        try {
            Invoke-RestMethod -Method POST "$Go2rtc/api/streams?dst=$($r.job.stream)&src=$enc" -TimeoutSec 30 | Out-Null
        } catch {
            $ok = $false
            $errMsg = $_.Exception.Message
        }

        # 4. Ack the job so the server marks it played (or failed).
        $ackBody = @{ id = $r.job.id; ok = $ok; error = $errMsg } | ConvertTo-Json
        Invoke-RestMethod -Method POST "$Api/api/assistant/internal/camera-bridge" -Headers $Headers -ContentType 'application/json' -Body $ackBody -TimeoutSec 20 | Out-Null

        # 5. Log one line per job so problems are visible at a glance.
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        if ($ok) {
            Write-Host "$stamp played job $($r.job.id) on stream $($r.job.stream)"
        } else {
            Write-Host "$stamp FAILED job $($r.job.id) on stream $($r.job.stream): $errMsg"
        }
    } catch {
        # One bad iteration (server down, DNS blip, bad JSON) must never kill
        # the bridge -- log it, back off a little longer, keep going.
        Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') loop error: $($_.Exception.Message)"
        Start-Sleep 15
        continue
    }

    Start-Sleep $IntervalSec
}
