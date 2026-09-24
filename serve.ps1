# Tiny static file server for local development (no Node needed).
# Usage: powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8787]
param([int]$Port = 8787)
$root = $PSScriptRoot
$mime = @{ ".html"="text/html; charset=utf-8"; ".js"="text/javascript; charset=utf-8"; ".css"="text/css; charset=utf-8"; ".json"="application/json"; ".png"="image/png"; ".jpg"="image/jpeg"; ".svg"="image/svg+xml"; ".md"="text/plain; charset=utf-8"; ".mp4"="video/mp4"; ".webp"="image/webp"; ".wasm"="application/wasm"; ".woff2"="font/woff2"; ".webmanifest"="application/manifest+json" }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Hooky dev server on http://localhost:$Port/"
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
  if ($path -eq "/") { $path = "/index.html" }
  $file = Join-Path $root ($path -replace "/", "\")
  $res = $ctx.Response
  # Dev-only upload endpoint used by logo.html to save generated images into
  # assets/, or assets/emoji/ for names starting with "emoji/".
  if ($ctx.Request.HttpMethod -eq "POST" -and $ctx.Request.Url.AbsolutePath -eq "/upload") {
    $name = $ctx.Request.QueryString["name"]
    if ($name -match "^(emoji/)?[a-z0-9-]+\.(png|webp)$") {
      $dir = Join-Path $root "assets"
      if ($name.StartsWith("emoji/")) { $dir = Join-Path $dir "emoji"; $name = $name.Substring(6) }
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory $dir | Out-Null }
      $ms = New-Object IO.MemoryStream; $ctx.Request.InputStream.CopyTo($ms)
      [IO.File]::WriteAllBytes((Join-Path $dir $name), $ms.ToArray())
      $res.StatusCode = 200
    } else { $res.StatusCode = 400 }
    $res.Close(); continue
  }
  if ((Test-Path $file -PathType Leaf) -and ((Resolve-Path $file).Path.StartsWith($root))) {
    $bytes = [IO.File]::ReadAllBytes($file)
    $ext = [IO.Path]::GetExtension($file).ToLower()
    $res.ContentType = if ($mime[$ext]) { $mime[$ext] } else { "application/octet-stream" }
    $res.Headers.Add("Cache-Control", "no-store")
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $res.StatusCode = 404
  }
  $res.Close()
}
