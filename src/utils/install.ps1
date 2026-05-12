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

function Test-TerminalUtilsDir {
	param([string]$Dir)

	if ([string]::IsNullOrWhiteSpace($Dir) -or -not (Test-Path -LiteralPath $Dir -PathType Container)) {
		return $false
	}

	$required = @("util", "upload", "new-version", "ssh-servers", "util.ps1", "upload.ps1", "new-version.ps1", "ssh-servers.ps1")
	foreach ($name in $required) {
		$path = Join-Path $Dir $name
		if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
			return $false
		}
	}

	return $true
}

function Get-ExistingInstallDirFromPath {
	$entries = @($env:Path -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
	foreach ($entry in $entries) {
		try {
			$resolved = [IO.Path]::GetFullPath($entry)
			if (Test-TerminalUtilsDir -Dir $resolved) {
				return $resolved
			}
		}
		catch {
			continue
		}
	}

	return $null
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
	$mainZipPath = Join-Path $tempDir "main.zip"
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
		$mainZipAsset = $releaseData.assets | Where-Object { $_.name -eq "main.zip" } | Select-Object -First 1
		if (-not $mainZipAsset -or [string]::IsNullOrWhiteSpace($mainZipAsset.browser_download_url)) {
			throw "Release asset main.zip not found. Ensure files are uploaded to GitHub Release."
		}

		Write-Host "Latest release: $tag" -ForegroundColor Cyan
		Write-Host ""

		$userDir = $null
		$existingDir = Get-ExistingInstallDirFromPath
		if (-not [string]::IsNullOrWhiteSpace($existingDir)) {
			Write-Host "Detected existing TerminalUtils installation in PATH: $existingDir" -ForegroundColor Yellow
			$answer = Read-Host "Update existing installation in this directory? [Y/n]"
			if ([string]::IsNullOrWhiteSpace($answer) -or $answer -match '^[Yy]$') {
				$userDir = $existingDir
			}
		}

		if ([string]::IsNullOrWhiteSpace($userDir)) {
			Write-Host "Installation directory" -ForegroundColor Gray
			Write-Host "Press Enter to use default: $DefaultInstallDir" -ForegroundColor Gray
			$userDir = Read-Host "Path"
			if ([string]::IsNullOrWhiteSpace($userDir)) {
				$userDir = $DefaultInstallDir
			}
		}

		$installDir = [IO.Path]::GetFullPath($userDir)
		New-Item -ItemType Directory -Path $installDir -Force | Out-Null
		Complete-Step "Installation directory prepared: $installDir"

		Run-WithSpinner "Downloading main.zip" {
			Invoke-WebRequest -Uri $using:mainZipAsset.browser_download_url -OutFile $using:mainZipPath -Headers @{ "User-Agent" = "terminalutils-installer" }
		}
		Complete-Step "Release archive downloaded"

		Run-WithSpinner "Extracting archive and copying files" {
			if (Test-Path -LiteralPath $using:extractDir) {
				Remove-Item -LiteralPath $using:extractDir -Recurse -Force -ErrorAction SilentlyContinue
			}
			New-Item -ItemType Directory -Path $using:extractDir -Force | Out-Null
			Expand-Archive -LiteralPath $using:mainZipPath -DestinationPath $using:extractDir -Force

			Get-ChildItem -Path $using:extractDir -Force | ForEach-Object {
				$target = Join-Path $using:installDir $_.Name
				if (Test-Path -LiteralPath $target) {
					Remove-Item -LiteralPath $target -Recurse -Force
				}
				Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
			}
		}
		Complete-Step "Archive extracted and files copied"

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
