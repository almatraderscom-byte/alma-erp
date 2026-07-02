# ALMA office PC - listener quality patch (PowerShell 5.1, ASCII-only).
# Stops the running camera listener, rewrites C:\go2rtc\camera-listen.ps1 with
# the improved capture settings (12 s chunks + voice-boost filter before send),
# and starts it again. Idempotent; safe to re-run.

$ErrorActionPreference = 'Continue'
$Go2rtcDir = 'C:\go2rtc'
$ScriptPath = Join-Path $Go2rtcDir 'camera-listen.ps1'

# --- 1. Stop the currently running listener ---------------------------------
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -match 'camera-listen\.ps1' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 1
Write-Host "OK: old listener stopped (if it was running)."

# --- 2. Write the improved listener ------------------------------------------
$listener = @'
# ALMA office PC camera LISTENER (v2 - 12s chunks + voice boost).
$Api        = 'https://alma-erp-six.vercel.app'
$Room       = 'entrance'
$TokenFile  = 'C:\go2rtc\bridge-token.txt'
$RtspFile   = 'C:\go2rtc\listen-rtsp.txt'
$Ffmpeg     = 'C:\go2rtc\ffmpeg.exe'
$ChunkSec   = 12
$SilenceDb  = -45
$Chunk      = "$env:TEMP\alma-listen.wav"
$SendChunk  = "$env:TEMP\alma-listen-send.wav"

if (-not (Test-Path $TokenFile)) { Write-Host "ERROR: token file not found: $TokenFile"; exit 1 }
if (-not (Test-Path $RtspFile))  { Write-Host "ERROR: rtsp file not found: $RtspFile";   exit 1 }
if (-not (Test-Path $Ffmpeg))    { Write-Host "ERROR: ffmpeg not found: $Ffmpeg";        exit 1 }
$Token = (Get-Content -Raw $TokenFile).Trim()
$Rtsp  = (Get-Content -Raw $RtspFile).Trim()
if ([string]::IsNullOrEmpty($Token)) { Write-Host "ERROR: token file empty"; exit 1 }
if ([string]::IsNullOrEmpty($Rtsp))  { Write-Host "ERROR: rtsp file empty";  exit 1 }
$Headers = @{ Authorization = "Bearer $Token" }
Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') camera listener v2 started (room=$Room, chunk=$ChunkSec s)"

function Get-MeanVolumeDb($wav) {
    $out = & $Ffmpeg -hide_banner -i $wav -af volumedetect -f null - 2>&1
    $line = $out | Select-String 'mean_volume:\s*(-?\d+(\.\d+)?) dB'
    if ($line) { return [double]$line.Matches[0].Groups[1].Value }
    return -100
}

while ($true) {
    try {
        if (Test-Path $Chunk) { Remove-Item $Chunk -ErrorAction SilentlyContinue }
        & $Ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i $Rtsp -t $ChunkSec -vn -ac 1 -ar 16000 -y $Chunk 2>&1 | Out-Null
        if (-not (Test-Path $Chunk)) { Write-Host "$(Get-Date -Format 'HH:mm:ss') no audio captured - retry"; Start-Sleep 5; continue }
        $vol = Get-MeanVolumeDb $Chunk
        if ($vol -lt $SilenceDb) { continue }
        & $Ffmpeg -hide_banner -loglevel error -i $Chunk -af "highpass=f=100,dynaudnorm=f=150:g=15" -ac 1 -ar 16000 -y $SendChunk 2>&1 | Out-Null
        $sendPath = if (Test-Path $SendChunk) { $SendChunk } else { $Chunk }
        $bytes = [System.IO.File]::ReadAllBytes($sendPath)
        $uri = "$Api/api/assistant/internal/camera-listen?room=$Room"
        $resp = Invoke-RestMethod -Method POST $uri -Headers $Headers -ContentType 'audio/wav' -Body $bytes -TimeoutSec 40
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        if ($resp.matched -and $resp.forwarded) { Write-Host "$stamp WAKE + forwarded: $($resp.heard)" }
        elseif ($resp.matched) { Write-Host "$stamp wake word, not forwarded ($($resp.reason)): $($resp.heard)" }
        elseif ($resp.heard) { Write-Host "$stamp heard (no wake word): $($resp.heard)" }
    } catch {
        Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') loop error: $($_.Exception.Message)"; Start-Sleep 10
    }
}
'@
Set-Content -Path $ScriptPath -Value $listener -Encoding ASCII
Write-Host "OK: camera-listen.ps1 updated to v2."

# --- 3. Start it again --------------------------------------------------------
Start-Process -FilePath 'powershell' -ArgumentList "-ExecutionPolicy Bypass -WindowStyle Minimized -File $ScriptPath"
Write-Host "OK: listener v2 running."
Write-Host ""
Write-Host "DONE. Listener patched (12s chunks + voice boost)."
