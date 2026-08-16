'use strict';

/**
 * Media Parser Web 服务（零第三方依赖，基于 node:http）。
 *
 * 启动：node server.js [--port 8765]
 * 默认监听 0.0.0.0:8765，可通过环境变量 PORT 覆盖。
 *
 * API:
 *   GET  /                    → Web 前端（可 iframe 嵌入个人网站）
 *   GET  /api/health          → 健康检查
 *   POST /api/parse           {text} → 解析单条
 *   POST /api/batch           {texts} → 批量解析
 *   GET  /api/download?url=&filename=&platform=&kind=   → 代理下载
 *   GET  /api/download/merged?bvid=&cid=&title=         → B站 DASH ffmpeg 合并下载
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./core');
const { UA_MOBILE, UA_DESKTOP, request } = require('./core/http');
const { hasFfmpeg } = require('./core/download');
const bilibili = require('./core/bilibili');

const ROOT = __dirname;
const WEB_DIR = path.join(ROOT, 'web');
const MAX_BODY = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

/** 平台对应下载请求头 */
function headersForPlatform(platform) {
  switch (platform) {
    case 'douyin':
      return { 'User-Agent': UA_MOBILE, Referer: 'https://www.douyin.com/' };
    case 'kuaishou':
      return { 'User-Agent': UA_MOBILE, Referer: 'https://www.kuaishou.com/' };
    case 'bilibili':
      return { 'User-Agent': UA_DESKTOP, Referer: 'https://www.bilibili.com/' };
    default:
      return { 'User-Agent': UA_DESKTOP };
  }
}

/** 代理下载单个文件 */
async function handleDownload(req, res, url) {
  const q = new URL(url, 'http://localhost');
  const target = q.searchParams.get('url');
  const filename = q.searchParams.get('filename') || 'download';
  const platform = q.searchParams.get('platform') || '';
  if (!target || !/^https?:/.test(target)) {
    sendJson(res, 400, { ok: false, error: '缺少有效的 url 参数' });
    return;
  }
  const headers = headersForPlatform(platform);
  try {
    const upstream = await fetch(target, { headers, redirect: 'follow' });
    if (!upstream.ok) {
      sendJson(res, 502, { ok: false, error: `上游返回 HTTP ${upstream.status}` });
      return;
    }
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    const safeName = filename.replace(/["\r\n]/g, '');
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': upstream.headers.get('content-length') || undefined,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) sendJson(res, 502, { ok: false, error: `下载失败: ${e.message}` });
    else res.end();
  }
}

/** B站 DASH 合并下载（ffmpeg 直连 URL 流式输出） */
async function handleMergedDownload(req, res, url) {
  const q = new URL(url, 'http://localhost');
  const bvid = q.searchParams.get('bvid');
  const cid = q.searchParams.get('cid');
  const title = q.searchParams.get('title') || 'video';
  if (!bvid || !cid) {
    sendJson(res, 400, { ok: false, error: '缺少 bvid/cid' });
    return;
  }

  let play;
  try {
    play = await bilibili.fetchPlayUrl({ bvid, cid });
  } catch (e) {
    sendJson(res, 502, { ok: false, error: `获取播放地址失败: ${e.message}` });
    return;
  }

  const safeTitle = title.replace(/[\\/:*?"<>|\r\n\t]/g, '').slice(0, 80) || 'video';
  const ffmpeg = await hasFfmpeg();
  corsHeaders(res);

  // ---- 方案A：ffmpeg 合并 ----
  if (ffmpeg && play.dash && play.dash.video && play.dash.audio && play.dash.audio.length) {
    const pickBest = (arr) =>
      arr
        .filter((t) => t.baseUrl || (t.backupUrl && t.backupUrl[0]))
        .sort((a, b) => (b.id || 0) - (a.id || 0))[0];
    const v = pickBest(play.dash.video);
    const a = pickBest(play.dash.audio);
    if (v && a) {
      const vUrl = v.baseUrl || v.backupUrl[0];
      const aUrl = a.baseUrl || a.backupUrl[0];
      const headersArg =
        'Referer: https://www.bilibili.com/\r\nUser-Agent: ' + UA_DESKTOP + '\r\n';
      const args = [
        '-y',
        '-headers', headersArg,
        '-i', vUrl,
        '-headers', headersArg,
        '-i', aUrl,
        '-c', 'copy',
        '-movflags', 'frag_keyframe+empty_moov+faststart',
        '-f', 'mp4',
        'pipe:1',
      ];
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeTitle + '_merged.mp4')}`,
        'Cache-Control': 'no-store',
      });
      const ff = spawn('ffmpeg', args, { windowsHide: true });
      ff.stdout.pipe(res);
      ff.stderr.on('data', () => {});
      ff.on('error', () => res.end());
      ff.on('exit', (code) => {
        if (code !== 0) res.end();
      });
      return;
    }
  }

  // ---- 方案B：降级为单文件 mp4（fnval=0, qn=64，含音轨） ----
  const api =
    'https://api.bilibili.com/x/player/playurl' +
    `?bvid=${bvid}&cid=${cid}` +
    '&qn=64&fnval=0&high_quality=1';
  try {
    const r = await request(api, {
      headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': UA_DESKTOP },
    });
    const durl = r.json && r.json.data && r.json.data.durl;
    const single = durl && durl[0] && durl[0].url;
    if (!single) {
      sendJson(res, 502, { ok: false, error: '没有可用视频流（可能需要登录）' });
      return;
    }
    const upstream = await fetch(single, {
      headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': UA_DESKTOP },
    });
    if (!upstream.ok) {
      sendJson(res, 502, { ok: false, error: `上游返回 HTTP ${upstream.status}` });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': upstream.headers.get('content-length') || undefined,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeTitle + '.mp4')}`,
      'Cache-Control': 'no-store',
    });
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) sendJson(res, 502, { ok: false, error: `下载失败: ${e.message}` });
    else res.end();
  }
}

/** 静态文件服务 */
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (rel.startsWith('web/')) rel = rel.slice(4);
  let filePath = path.resolve(WEB_DIR, rel);
  if (!filePath.startsWith(path.resolve(WEB_DIR) + path.sep) && filePath !== path.resolve(WEB_DIR)) {
    sendJson(res, 403, { ok: false, error: '禁止访问' });
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      sendJson(res, 404, { ok: false, error: 'Not Found' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = req.url || '/';
    const pathname = url.split('?')[0];
    corsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // ---- API ----
      if (pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          name: 'media-parser',
          platforms: core.listPlatforms(),
          node: process.version,
        });
        return;
      }

      if (pathname === '/api/parse' && req.method === 'POST') {
        const body = await readBody(req);
        const text = body.text || body.url || '';
        if (!text) {
          sendJson(res, 400, { ok: false, error: '缺少 text 参数' });
          return;
        }
        try {
          const result = await core.parse(text);
          sendJson(res, 200, { ok: true, result });
        } catch (e) {
          sendJson(res, 200, { ok: false, error: e.message, code: e.code || 'PARSE_FAILED' });
        }
        return;
      }

      if (pathname === '/api/batch' && req.method === 'POST') {
        const body = await readBody(req);
        const texts = Array.isArray(body.texts) ? body.texts : (body.text || '').split(/\r?\n/).filter(Boolean);
        if (texts.length === 0) {
          sendJson(res, 400, { ok: false, error: '缺少 texts' });
          return;
        }
        const results = await core.parseBatch(texts, body.concurrency || 3);
        sendJson(res, 200, { ok: true, results });
        return;
      }

      if (pathname === '/api/download') {
        await handleDownload(req, res, url);
        return;
      }

      if (pathname === '/api/download/merged') {
        await handleMergedDownload(req, res, url);
        return;
      }

      // ---- 静态 ----
      serveStatic(req, res, pathname);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
  });
}

function main() {
  const args = process.argv.slice(2);
  let port = parseInt(process.env.PORT || '8765', 10);
  const pi = args.indexOf('--port');
  if (pi >= 0 && args[pi + 1]) port = parseInt(args[pi + 1], 10);
  if (Number.isNaN(port)) port = 8765;

  const server = createServer();
  server.listen(port, '0.0.0.0', () => {
    console.log('============================================');
    console.log('  Media Parser Web 服务已启动');
    console.log(`  本机访问:   http://127.0.0.1:${port}`);
    console.log(`  局域网访问: http://<本机IP>:${port}`);
    console.log('  健康检查:   GET /api/health');
    console.log('============================================');
  });
}

if (require.main === module) {
  main();
}

module.exports = { createServer };
