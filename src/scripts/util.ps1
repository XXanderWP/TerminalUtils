$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$node = $env:NODE
if (-not $node) { $node = "node" }
& $node (Join-Path $scriptDir "util-handler.js") $args
