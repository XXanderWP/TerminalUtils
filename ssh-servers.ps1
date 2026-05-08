$node = $env:NODE
if (-not $node) { $node = "node" }
& $node (Join-Path $PSScriptRoot "ssh-servers-handler.js") $args