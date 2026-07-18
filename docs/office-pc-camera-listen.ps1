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
#   1. C:\go2rtc\listener-token.txt — preferred dedicated listener token.
#      During migration the script falls back to C:\go2rtc\bridge-token.txt.
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
$ListenerTokenFile = 'C:\go2rtc\listener-token.txt'
$BridgeTokenFile   = 'C:\go2rtc\bridge-token.txt'
$RtspFile   = 'C:\go2rtc\listen-rtsp.txt'
$Ffmpeg     = 'C:\go2rtc\ffmpeg.exe'
$ChunkSec   = 12                         # length of each audio grab (long enough for a full sentence)
$SilenceDb  = -45                        # mean volume below this = silence, skip
$Chunk      = "$env:TEMP\alma-listen.wav"      # raw grab (silence check runs on this)
$SendChunk  = "$env:TEMP\alma-listen-send.wav" # filtered copy actually sent (voice boosted)

# --- Startup: load token + rtsp url -----------------------------------------
$TokenFile = if (Test-Path $ListenerTokenFile) { $ListenerTokenFile } else { $BridgeTokenFile }
if (-not (Test-Path $TokenFile)) { Write-Host "ERROR: listener/bridge token file not found"; exit 1 }
if (-not (Test-Path $RtspFile))  { Write-Host "ERROR: rtsp file not found: $RtspFile";   exit 1 }
if (-not (Test-Path $Ffmpeg))    { Write-Host "ERROR: ffmpeg not found: $Ffmpeg";        exit 1 }

$Token = (Get-Content -Raw $TokenFile).Trim()
$Rtsp  = (Get-Content -Raw $RtspFile).Trim()
if ([string]::IsNullOrEmpty($Token)) { Write-Host "ERROR: token file empty"; exit 1 }
if ([string]::IsNullOrEmpty($Rtsp))  { Write-Host "ERROR: rtsp file empty";  exit 1 }

$Headers = @{ Authorization = "Bearer $Token" }
$LastHeartbeat = [datetime]::MinValue
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
        # 1. Authenticated heartbeat makes listener health visible server-side.
        if (((Get-Date) - $LastHeartbeat).TotalSeconds -ge 30) {
            Invoke-RestMethod -Method GET "$Api/api/assistant/internal/camera-listen?room=$Room" `
                -Headers $Headers -TimeoutSec 20 | Out-Null
            $LastHeartbeat = Get-Date
        }

        # 2. Grab one audio chunk from the camera mic (no video, mono 16 kHz).
        if (Test-Path $Chunk) { Remove-Item $Chunk -ErrorAction SilentlyContinue }
        & $Ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i $Rtsp `
            -t $ChunkSec -vn -ac 1 -ar 16000 -y $Chunk 2>&1 | Out-Null

        if (-not (Test-Path $Chunk)) {
            Write-Host "$(Get-Date -Format 'HH:mm:ss') no audio captured (mic off?) — retry"
            Start-Sleep 5
            continue
        }

        # 3. Skip silence locally — don't pay to transcribe an empty room.
        $vol = Get-MeanVolumeDb $Chunk
        if ($vol -lt $SilenceDb) {
            # quiet chunk; loop straight into the next grab (no gap)
            continue
        }

        # 4. Speech present — boost the distant voice (highpass kills hum,
        #    dynaudnorm lifts far-field speech) and send THAT copy for STT.
        #    The silence check above ran on the RAW grab, so normalization
        #    cannot trick it into transcribing an empty room.
        & $Ffmpeg -hide_banner -loglevel error -i $Chunk `
            -af "highpass=f=100,dynaudnorm=f=150:g=15" -ac 1 -ar 16000 -y $SendChunk 2>&1 | Out-Null
        $sendPath = if (Test-Path $SendChunk) { $SendChunk } else { $Chunk }
        $bytes = [System.IO.File]::ReadAllBytes($sendPath)
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
