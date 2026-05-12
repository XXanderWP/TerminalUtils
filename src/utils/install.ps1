$ErrorActionPreference = "Stop"

$Owner = "XXanderWP"
$Repo = "TerminalUtils"
$DefaultInstallDir = Join-Path $HOME "terminalutils"

$Script:TotalSteps = 6
$Script:CurrentStep = 0

function Write-Banner {
	Write-Host ""
	Write-Host "===============================================" -ForegroundColor Cyan
	Write-Host "          TerminalUtils Installer" -ForegroundColor Cyan
	Write-Host "===============================================" -ForegroundColor Cyan
	Write-Host "Latest release setup for Windows" -ForegroundColor DarkGray
	Write-Host ""
}

function Write-ProgressBar {
	$width = 34
	$percent = [int](($Script:CurrentStep * 100) / $Script:TotalSteps)
	$filled = [int](($percent * $width) / 100)
	$empty = $width - $filled
	$bar = ("#" * $filled) + ("-" * $empty)
	Write-Host "[$bar] $percent%" -ForegroundColor Cyan
}

function Complete-Step {
	param([string]$Message)

	$Script:CurrentStep += 1
	Write-Host "[OK] $Message" -ForegroundColor Green
	Write-ProgressBar
	Write-Host ""
}

function Run-WithSpinner {
	param(
		[string]$Message,
		[scriptblock]$Action
	)

	Write-Host "[..] $Message" -NoNewline -ForegroundColor Yellow
	$spinner = @("|", "/", "-", "\\")
	$index = 0

	$job = Start-Job -ScriptBlock $Action
	try {
		while ($job.State -eq "Running" -or $job.State -eq "NotStarted") {
			Write-Host "`r[..] $Message $($spinner[$index])" -NoNewline -ForegroundColor Yellow
			$index = ($index + 1) % $spinner.Count
			Start-Sleep -Milliseconds 120
		}

		$null = Receive-Job -Job $job -ErrorAction Stop
		Write-Host "`r[OK] $Message   " -ForegroundColor Green
	}
	catch {
		Write-Host "`r[!!] $Message   " -ForegroundColor Red
		throw
	}
	finally {
		Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
	}
}

function Ensure-Command {
	param([string]$Name)
	if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
		throw "Required command not found: $Name"
	}
}

function Add-ToUserPath {
	param([string]$InstallDir)

	$currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
	if ([string]::IsNullOrWhiteSpace($currentUserPath)) {
		$newPath = $InstallDir
	}
	else {
		$entries = $currentUserPath.Split(";") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
		if ($entries -contains $InstallDir) {
			$newPath = $currentUserPath
		}
		else {
			$newPath = "$currentUserPath;$InstallDir"
		}
	}

	[Environment]::SetEnvironmentVariable("Path", $newPath, "User")

	$processEntries = $env:Path.Split(";") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
	if (-not ($processEntries -contains $InstallDir)) {
		$env:Path = "$env:Path;$InstallDir"
	}
}

function Remove-InstallFiles {
	param([string]$InstallDir)

	Get-ChildItem -Path $InstallDir -File -Filter "install*" -ErrorAction SilentlyContinue |
		Remove-Item -Force -ErrorAction SilentlyContinue
}

function Install-TerminalUtils {
	Write-Banner

	Ensure-Command "Invoke-RestMethod"
	Ensure-Command "Invoke-WebRequest"
	Ensure-Command "Expand-Archive"

	$apiUrl = "https://api.github.com/repos/$Owner/$Repo/releases/latest"
	$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("terminalutils-install-" + [Guid]::NewGuid().ToString("N"))
	$releaseJsonPath = Join-Path $tempDir "release.json"
	$zipPath = Join-Path $tempDir "release.zip"
	$extractDir = Join-Path $tempDir "extract"

	New-Item -ItemType Directory -Path $tempDir, $extractDir -Force | Out-Null

	try {
		Run-WithSpinner "Requesting latest release metadata" {
			$release = Invoke-RestMethod -Uri $using:apiUrl -Headers @{ "User-Agent" = "terminalutils-installer" }
			$release | ConvertTo-Json -Depth 8 | Set-Content -Path $using:releaseJsonPath -Encoding UTF8
		}
		Complete-Step "Latest release metadata loaded"

		$releaseData = Get-Content -Path $releaseJsonPath -Raw | ConvertFrom-Json
		$tag = [string]$releaseData.tag_name
		$zipUrl = [string]$releaseData.zipball_url
		if ([string]::IsNullOrWhiteSpace($zipUrl)) {
			throw "Latest release zip URL not found."
		}

		Write-Host "Latest release: $tag" -ForegroundColor Cyan
		Write-Host ""

		Write-Host "Installation directory" -ForegroundColor Gray
		Write-Host "Press Enter to use default: $DefaultInstallDir" -ForegroundColor Gray
		$userDir = Read-Host "Path"
		if ([string]::IsNullOrWhiteSpace($userDir)) {
			$userDir = $DefaultInstallDir
		}

		$installDir = [IO.Path]::GetFullPath($userDir)
		New-Item -ItemType Directory -Path $installDir -Force | Out-Null
		Complete-Step "Installation directory prepared: $installDir"

		Run-WithSpinner "Downloading release archive" {
			Invoke-WebRequest -Uri $using:zipUrl -OutFile $using:zipPath -Headers @{ "User-Agent" = "terminalutils-installer" }
		}
		Complete-Step "Release archive downloaded"

		Run-WithSpinner "Extracting archive" {
			Expand-Archive -LiteralPath $using:zipPath -DestinationPath $using:extractDir -Force
		}
		Complete-Step "Archive extracted"

		$topDir = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1
		if (-not $topDir) {
			throw "Could not locate extracted release folder."
		}

		Run-WithSpinner "Copying files to destination" {
			Get-ChildItem -Path $using:topDir.FullName -Force | ForEach-Object {
				if ($_.Name -eq ".git" -or $_.Name -eq ".github") {
					return
				}

				$target = Join-Path $using:installDir $_.Name
				if (Test-Path -LiteralPath $target) {
					Remove-Item -LiteralPath $target -Recurse -Force
				}
				Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
			}
		}

		Remove-InstallFiles -InstallDir $installDir
		Complete-Step "Files installed and install* scripts removed"

		Write-Host "[..] Configuring PATH" -ForegroundColor Yellow
		Add-ToUserPath -InstallDir $installDir
		Write-Host "[OK] Configuring PATH" -ForegroundColor Green
		Complete-Step "PATH configuration complete"

		Write-Host "TerminalUtils installed successfully." -ForegroundColor Green
		Write-Host "Use command: util" -ForegroundColor Green
		Write-Host "If command is not found immediately, restart the terminal window." -ForegroundColor DarkGray
		Write-Host ""
	}
	finally {
		if (Test-Path -LiteralPath $tempDir) {
			Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
		}
	}
}

Install-TerminalUtils
