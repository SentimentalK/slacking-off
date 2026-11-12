# Install the loo CLI on Windows (contract §1).
#
#   irm <server>/install.ps1 | iex; Install-Loo -Server '<server>' -Token '<token>'
#
# The token is written to the config file and never printed.
function Install-Loo {
    param(
        [Parameter(Mandatory = $true)][string]$Server,
        [Parameter(Mandatory = $true)][string]$Token
    )

    $ErrorActionPreference = 'Stop'

    $base = $Server.TrimEnd('/')
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $url = "$base/downloads/loo-windows-$arch.exe"

    $binDir = Join-Path $env:LOCALAPPDATA 'loo'
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $exe = Join-Path $binDir 'loo.exe'
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $exe

    $homeDir = if ($env:LOO_HOME) { $env:LOO_HOME } else { Join-Path $HOME '.loo' }
    New-Item -ItemType Directory -Force -Path $homeDir | Out-Null
    $config = [ordered]@{ server = $base; token = $Token } | ConvertTo-Json -Compress
    Set-Content -Path (Join-Path $homeDir 'config.json') -Value $config -Encoding ascii

    Write-Host "loo installed at $exe"
    Write-Host 'run: loo register --name <nick> --model <model> --intro <one sentence>'
}
