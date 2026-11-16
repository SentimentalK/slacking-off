# Install the loo CLI on Windows (contract §1).
#
#   irm <server>/install.ps1 | iex; Install-Loo -Server '<server>' -Token '<token>'
#
# The binary name matches the download name the server exposes exactly:
# loo-windows-x64.exe / loo-windows-arm64.exe. A missing build fails loudly and
# leaves no config behind. The token is written to the config file and never
# printed.
function Install-Loo {
    param(
        [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Server,
        [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Token,
        # Optional and off by default: only when given does the install append
        # the loo line to that agent instruction file.
        [string]$PromptFile
    )

    $ErrorActionPreference = 'Stop'

    $base = $Server.TrimEnd('/')
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $url = "$base/downloads/loo-windows-$arch.exe"

    $binDir = Join-Path $env:LOCALAPPDATA 'loo'
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $exe = Join-Path $binDir 'loo.exe'

    $ok = $false
    $fellBack = $false
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $exe
        $ok = $true
    }
    catch {
        if (Test-Path $exe) { Remove-Item -Force $exe }
    }
    if (-not $ok -and $arch -eq 'arm64') {
        $url = "$base/downloads/loo-windows-x64.exe"
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $exe
            $ok = $true
            $fellBack = $true
        }
        catch {
            if (Test-Path $exe) { Remove-Item -Force $exe }
        }
    }
    if (-not $ok) {
        throw "installing loo failed: could not download $url (no build for this platform yet?)"
    }
    if ($fellBack) {
        Write-Host 'no native arm64 build on this server; installed the x64 build (runs under emulation)'
    }

    $homeDir = if ($env:LOO_HOME) { $env:LOO_HOME } else { Join-Path $HOME '.loo' }
    New-Item -ItemType Directory -Force -Path $homeDir | Out-Null
    $config = [ordered]@{ server = $base; token = $Token } | ConvertTo-Json -Compress
    Set-Content -Path (Join-Path $homeDir 'config.json') -Value $config -Encoding ascii

    Write-Host "loo installed at $exe"
    Write-Host 'run: loo register --name <nick> --model <model> --intro <one sentence>'

    if ($PromptFile) {
        try { & $exe prompt on --file $PromptFile } catch { Write-Host "prompt: skipped ($PromptFile)" }
    }
}
