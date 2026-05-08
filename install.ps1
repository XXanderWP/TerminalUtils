<#
Windows installer for TerminalUtils
- Checks for Node.js and attempts to install via winget if available
- Downloads latest release zip from GitHub and extracts it into the current folder
- Installs npm dependencies
- Adds the install folder to the user PATH persistently using setx
Note: running this script requires administrative privileges for installing system packages.
#>

param()

function Info($msg) { Write-Host "[info] $msg" -ForegroundColor Cyan }
function Error($msg) { Write-Host "[error] $msg" -ForegroundColor Red }

$repo = 'https://api.github.com/repos/XXanderWP/TerminalUtils/releases/latest'

function Check-Node {
    return Get-Command node -ErrorAction SilentlyContinue
}

function Try-Install-Node {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Info 'Installing Node.js LTS using winget...'
        winget install --id=OpenJS.NodeJS.LTS -e --silent
        return Check-Node
    }
    return $null
}

Info 'Checking Node.js...'
$node = Check-Node
if (-not $node) {
    Info 'Node.js not found. Attempting to install...'
    $node = Try-Install-Node
    if (-not $node) {
        Error 'Automatic Node.js installation is not available. Please install Node.js LTS manually and re-run this script.'
        exit 1
    }
}

Info ("Using Node.js: {0}" -f ($node.Path))

Info 'Querying latest release...'
try {
    $rel = Invoke-RestMethod -Uri $repo -UseBasicParsing
    $zipUrl = $rel.zipball_url
} catch {
    Error 'Failed to query GitHub releases.'
    exit 1
}

if (-not $zipUrl) { Error 'No release zip URL found.'; exit 1 }

$out = Join-Path -Path (Get-Location) -ChildPath 'project.zip'
Info ("Downloading $zipUrl -> $out")
Invoke-WebRequest -Uri $zipUrl -OutFile $out -UseBasicParsing -Verbose

Info 'Extracting release...'
$tmp = Join-Path $env:TEMP ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmp | Out-Null
Expand-Archive -Path $out -DestinationPath $tmp -Force

# Move contents from top-level extracted folder to current directory
$dirs = Get-ChildItem -Path $tmp -Directory
if ($dirs.Count -ge 1) {
    $src = $dirs[0].FullName
    Get-ChildItem -Path $src -Force | Move-Item -Destination (Get-Location) -Force
}
Remove-Item -Path $tmp -Recurse -Force
Remove-Item -Path $out -Force

Info 'Installing npm dependencies...'
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Error 'npm is not available in PATH.'
    exit 1
}

npm install --omit=dev
if ($LASTEXITCODE -ne 0) {
    Error 'npm install failed.'
    exit 1
}

Info 'Adding install folder to user PATH...'
$installPath = (Get-Location).Path
$currentPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if (-not $currentPath.Contains($installPath)) {
    setx PATH ("$currentPath;$installPath") | Out-Null
    Info 'PATH updated for current user. Open a new PowerShell window to pick up changes.'
} else {
    Info 'Install folder already in PATH.'
}

Info 'Installation complete.'
