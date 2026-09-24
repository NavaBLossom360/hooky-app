# Copies the shippable web files into www/ for Capacitor (see README, "Shipping to the app stores").
# Usage: powershell -ExecutionPolicy Bypass -File build.ps1
$root = $PSScriptRoot
$out = Join-Path $root "www"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory $out | Out-Null
$files = @("index.html", "styles.css", "safety.js", "store.js", "call.js", "app.js", "sw.js", "manifest.json", "icon.svg", "legal.html")
foreach ($f in $files) { Copy-Item (Join-Path $root $f) $out }
Copy-Item (Join-Path $root "assets") (Join-Path $out "assets") -Recurse
if (Test-Path (Join-Path $root "config.js")) { Copy-Item (Join-Path $root "config.js") $out } else { Write-Warning "No config.js: the build will run in demo mode. Create it from config.example.js before a store build." }
Write-Host "Built www/ with $((Get-ChildItem $out -Recurse -File).Count) files"
