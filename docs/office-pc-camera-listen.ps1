# ALMA office PC camera LISTENER (PowerShell 5.1 compatible).
#
# WHY: the companion to office-pc-camera-bridge.ps1. The bridge makes the
# camera SPEAK; this listener makes it HEAR. It pulls the camera's two-way
# mic (RTSP audio) in short chunks, skips silence locally (so we never pay to
# transcribe an empty room), and POSTs speech chunks to the ALMA server. The
# server transcribes them, checks for the wake word ("আলমা শোনো"), and — only
# then — forwards what the staff said to the owner's Telegram.
#
# Setup:
#   1. C:\go2rtc\bridge-token.txt  — the bridge token (same one the bridge uses).
#   2. C:\go2rtc\listen-rtsp.txt   — the FULL RTSP URL of the camera to listen
#      on, e.g.
#      rtsp://admin:<device-pass>@192.168.1.147:554/cam/realmonitor?channel=1&subtype=0&unicast=true&proto=Onvif
#      (kept in a file, never in git — same convention as the token.)
#   3. ffmpeg.exe at C:\go2rtc\ffmpeg.exe (already there for the bridge).
#   4. Run it, or register at logon like the bridge:
#      powershell -ExecutionPolicy Bypass -File C:\go2rtc\camera-listen.ps1
#
# Never exits on its own: every iteration is wrapped in try/catch.

$Api        = 'https://alma-erp-six.vercel.app'
$Room       = 'entrance'                 # which room this listener covers
$TokenFile  = 'C:\go2rtc\bridge-token.txt'
$RtspFile   = 'C:\go2rtc\listen-rtsp.txt'
$Ffmpeg     = 'C:\go2rtc\ffmpeg.exe'
$ChunkSec   = 6                          # length of each audio grab
$SilenceDb  = -45                        # mean volume below this = silence, skip
$Chunk      = "$env:TEMP\alma-listen.wav"

# --- Startup: load token + rtsp url -----------------------------------------
if (-not (Test-Path $TokenFile)) { Write-Host "ERROR: token file not found: $TokenFile"; exit 1 }
if (-not (Test-Path $RtspFile))  { Write-Host "ERROR: rtsp file not found: $RtspFile";   exit 1 }
if (-not (Test-Path $Ffmpeg))    { Write-Host "ERROR: ffmpeg not found: $Ffmpeg";        exit 1 }

$Token = (Get-Content -Raw $TokenFile).Trim()
$Rtsp  = (Get-Content -Raw $RtspFile).Trim()
if ([string]::IsNullOrEmpty($Token)) { Write-Host "ERROR: token file empty"; exit 1 }
if ([string]::IsNullOrEmpty($Rtsp))  { Write-Host "ERROR: rtsp file empty";  exit 1 }

$Headers = @{ Authorization = "Bearer $Token" }
Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') camera listener started (room=$Room, chunk=$ChunkSec s)"

# --- Helpers ----------------------------------------------------------------
function Get-MeanVolumeDb($wav) {
    # Run volumedetect and parse "mean_volume: -xx.x dB" from stderr.
    $out = & $Ffmpeg -hide_banner -i $wav -af volumedetect -f null - 2>&1
    $line = $out | Select-String 'mean_volume:\s*(-?\d+(\.\d+)?) dB'
    if ($line) { return [double]$line.Matches[0].Groups[1].Value }
    return -100  # parse failed -> treat as silence (safer: don't spend on STT)
}

# --- Main loop --------------------------------------------------------------
while ($true) {
    try {
        # 1. Grab one audio chunk from the camera mic (no video, mono 16 kHz).
        if (Test-Path $Chunk) { Remove-Item $Chunk -ErrorAction SilentlyContinue }
        & $Ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i $Rtsp `
            -t $ChunkSec -vn -ac 1 -ar 16000 -y $Chunk 2>&1 | Out-Null

        if (-not (Test-Path $Chunk)) {
            Write-Host "$(Get-Date -Format 'HH:mm:ss') no audio captured (mic off?) — retry"
            Start-Sleep 5
            continue
        }

        # 2. Skip silence locally — don't pay to transcribe an empty room.
        $vol = Get-MeanVolumeDb $Chunk
        if ($vol -lt $SilenceDb) {
            # quiet chunk; loop straight into the next grab (no gap)
            continue
        }

        # 3. Speech present — send the chunk to the server for STT + wake word.
        $bytes = [System.IO.File]::ReadAllBytes($Chunk)
        $uri = "$Api/api/assistant/internal/camera-listen?room=$Room"
        $resp = Invoke-RestMethod -Method POST $uri -Headers $Headers `
            -ContentType 'audio/wav' -Body $bytes -TimeoutSec 40

        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        if ($resp.matched -and $resp.forwarded) {
            Write-Host "$stamp WAKE + forwarded: $($resp.heard)"
        } elseif ($resp.matched) {
            Write-Host "$stamp wake word, not forwarded ($($resp.reason)): $($resp.heard)"
        } elseif ($resp.heard) {
            Write-Host "$stamp heard (no wake word): $($resp.heard)"
        }
    } catch {
        Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') loop error: $($_.Exception.Message)"
        Start-Sleep 10
    }
}
