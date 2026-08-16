# ============================================================
#  Media Parser - 抖音 / 快手 / 哔哩哔哩 批量无水印下载
#  启动脚本（由 start.bat 调用；本文件须保存为 UTF-8 带 BOM）
# ============================================================

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Show-Banner {
    Write-Host ""
    Write-Host "  ============================================================" -ForegroundColor Cyan
    Write-Host "   Media Parser · 短视频 / 图片 批量无水印下载器" -ForegroundColor Cyan
    Write-Host "  ============================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  【用途】" -ForegroundColor Green
    Write-Host "    解析抖音、快手、哔哩哔哩的分享链接 / 分享文本，提取无水印" -ForegroundColor Gray
    Write-Host "    原地址并批量下载视频与图片，无需登录、无需付费。" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  【功能范围】" -ForegroundColor Green
    Write-Host "    · 抖音：视频 + 图文笔记（v.douyin.com 短链 / 长链 / 分享文本）" -ForegroundColor Gray
    Write-Host "    · 快手：视频 + 图集（v.kuaishou.com / short-video）" -ForegroundColor Gray
    Write-Host "    · B站 ：视频(多P/番剧) + 专栏图片 + 动态图片（b23.tv 短链）" -ForegroundColor Gray
    Write-Host "    · 批量：txt 文件批量导入、多链接并发下载" -ForegroundColor Gray
    Write-Host "    · 模式：本机网页版 / 命令行 / REST API 嵌入个人网站" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  【使用提示】" -ForegroundColor Green
    Write-Host "    1. 浏览器将自动打开 http://127.0.0.1:8765" -ForegroundColor Gray
    Write-Host "    2. 粘贴分享文本即可自动提取链接，无需手工清理" -ForegroundColor Gray
    Write-Host "    3. B站视频为 DASH 音视频流：安装 FFmpeg 后自动合并为单文件" -ForegroundColor Gray
    Write-Host "    4. 命令行用法：node cli.js `"链接`" -o 输出目录  或  dl.bat 链接" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  【免责声明】仅供个人学习研究，请遵守平台规则与相关法律法规。" -ForegroundColor DarkYellow
    Write-Host "  ============================================================" -ForegroundColor Cyan
    Write-Host ""
}

# ---- 检查 Node.js ----
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Show-Banner
    Write-Host "  [错误] 未检测到 Node.js，请先安装：" -ForegroundColor Red
    Write-Host "         https://nodejs.org/  （安装 LTS 版本，勾选 Add to PATH）" -ForegroundColor Red
    Write-Host ""
    Read-Host "  按回车键退出"
    exit 1
}

# ---- 检查端口占用 ----
$port = 8765
$listener = $null
if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
}
if ($listener) {
    Show-Banner
    Write-Host "  [提示] 端口 $port 已被占用，可能服务已在运行。" -ForegroundColor Yellow
    Write-Host "         请直接访问 http://127.0.0.1:$port ，或先关闭占用端口的程序。" -ForegroundColor Yellow
    Read-Host "  按回车键退出"
    exit 1
}

Show-Banner
Write-Host "  [*] 正在启动 Web 服务 (http://127.0.0.1:$port) ..." -ForegroundColor Green
Write-Host "  [*] 关闭本窗口即停止服务；启动后浏览器会自动打开页面。" -ForegroundColor Green
Write-Host ""

if (-not $env:MEDIA_PARSER_NO_BROWSER) {
    Start-Process "http://127.0.0.1:$port"
}

node server.js
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [错误] 服务异常退出 (code=$LASTEXITCODE)" -ForegroundColor Red
    Read-Host "  按回车键退出"
    exit 1
}
