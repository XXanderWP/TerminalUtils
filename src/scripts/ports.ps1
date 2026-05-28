$node = $env:NODE
if (-not $node) { $node = "node" }
& $node (Join-Path $PSScriptRoot "main.js") ports $args
