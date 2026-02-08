<#
Windows installer for TerminalUtils
- Checks for Python and attempts to install via winget if available
- Downloads latest release zip from GitHub and extracts it into the current folder
- Adds the install folder to the user PATH persistently using setx
Note: running this script requires administrative privileges for installing system packages.
#>

param()

function Info($msg) { Write-Host "[info] $msg" -ForegroundColor Cyan }
function Error($msg) { Write-Host "[error] $msg" -ForegroundColor Red }

$repo = 'https://api.github.com/repos/XXanderWP/TerminalUtils/releases/latest'

function Check-Python {
    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
    return $py
}

function Try-Install-Python {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Info 'Installing Python using winget...'
        winget install --id=Python.Python.3 -e --silent
        return Check-Python
    }
    return $null
}

Info 'Checking Python...'
$py = Check-Python
if (-not $py) {
    Info 'Python not found. Attempting to install...'
    $py = Try-Install-Python
    if (-not $py) {
        Error 'Automatic Python installation is not available. Please install Python 3 manually and re-run this script.'
        exit 1
    }
}

Info ("Using Python: {0}" -f ($py.Path))

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
