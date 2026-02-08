$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$python = $env:PYTHON
if (-not $python) { $python = "python" }
& $python (Join-Path $scriptDir "util_handler.py") $args
