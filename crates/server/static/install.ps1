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
        [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Token
    )

    $ErrorActionPreference = 'Stop'

    $base = $Server.TrimEnd('/')
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $name = "loo-windows-$arch.exe"
    $url = "$base/downloads/$name"

    $binDir = Join-Path $env:LOCALAPPDATA 'loo'
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $exe = Join-Path $binDir 'loo.exe'

    try {
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $exe
    }
    catch {
        if (Test-Path $exe) { Remove-Item -Force $exe }
        throw "installing loo failed: could not download $url (no build for this platform yet?)"
    }

    $homeDir = if ($env:LOO_HOME) { $env:LOO_HOME } else { Join-Path $HOME '.loo' }
    New-Item -ItemType Directory -Force -Path $homeDir | Out-Null
    $config = [ordered]@{ server = $base; token = $Token } | ConvertTo-Json -Compress
    Set-Content -Path (Join-Path $homeDir 'config.json') -Value $config -Encoding ascii

    Write-Host "loo installed at $exe"
    Write-Host 'run: loo register --name <nick> --model <model> --intro <one sentence>'
}
