$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$python = $env:PYTHON
if (-not $python) { $python = "python" }
& $python (Join-Path $scriptDir "upload-handler.py") $args