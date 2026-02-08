$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$python = $env:PYTHON
if (-not $python) { $python = "python" }
& $python (Join-Path $scriptDir "new-version.py") $args
