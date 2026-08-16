'use strict';

/**
 * 下载器：
 *  - 流式下载（支持进度回调、重试、自定义请求头）
 *  - B站 DASH 音视频流用 ffmpeg 合并（若本机安装了 ffmpeg）
 *  - 批量并发下载
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getFetcher } = require('./http');
const { sanitizeFilename } = require('./util');

/**
 * 下载单个文件。
 * @param {string} url
 * @param {string} filepath
 * @param {object} [options]
 * @param {object} [options.headers] 请求头
 * @param {Function} [options.onProgress] (received, total) => void
 * @param {number} [options.retries=2]
 * @returns {Promise<{bytes:number, filepath:string}>}
 */
async function downloadFile(url, filepath, options = {}) {
  const { headers = {}, onProgress, retries = 2 } = options;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await getFetcher()(url, { headers, redirect: 'follow' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
      let received = 0;
      const tmpPath = filepath + '.part';
      const ws = fs.createWriteStream(tmpPath);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        ws.write(Buffer.from(value));
        if (onProgress) onProgress(received, total);
      }
      await new Promise((resolve, reject) => {
        ws.end((err) => (err ? reject(err) : resolve()));
      });
      fs.renameSync(tmpPath, filepath);
      return { bytes: received, filepath };
    } catch (e) {
      lastErr = e;
      // 清理残留
      try {
        fs.rmSync(filepath + '.part', { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  throw lastErr || new Error('下载失败');
}

/** 检查 ffmpeg 是否可用 */
function hasFfmpeg() {
  return new Promise((resolve) => {
    try {
      const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/**
 * 用 ffmpeg 合并音视频文件（-c copy，无损快速）。
 * @param {string} videoFile
 * @param {string} audioFile
 * @param {string} outFile
 * @returns {Promise<boolean>}
 */
function mergeMedia(videoFile, audioFile, outFile) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', videoFile,
      '-i', audioFile,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-bsf:a', 'aac_adtstoasc',
      outFile,
    ];
    const p = spawn('ffmpeg', args, { windowsHide: true });
    let errOut = '';
    p.stderr.on('data', (d) => {
      errOut += d.toString();
    });
    p.on('error', (e) => reject(e));
    p.on('exit', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`ffmpeg 合并失败 (code=${code}): ${errOut.slice(-500)}`));
    });
  });
}

/**
 * 下载一个解析结果（视频/图文），返回保存的文件列表。
 * @param {object} result 解析结果
 * @param {string} outDir 输出目录
 * @param {object} [options]
 * @param {boolean} [options.merge=true] B站 DASH 是否尝试 ffmpeg 合并
 * @param {Function} [options.onItemStart] (item, index, total) => void
 * @param {Function} [options.onProgress] (received, total, item) => void
 * @returns {Promise<{files:string[], merged:boolean, ffmpeg:boolean}>}
 */
async function downloadResult(result, outDir, options = {}) {
  const { merge = true, onItemStart, onProgress } = options;
  fs.mkdirSync(outDir, { recursive: true });

  const ffmpegAvailable = merge ? await hasFfmpeg() : false;
  const files = [];
  let merged = false;
  let usedFfmpeg = ffmpegAvailable;

  // 图文：每个图片一个文件，放在子目录
  if (result.type === 'image') {
    const subDir = path.join(outDir, sanitizeFilename(result.title, 40));
    fs.mkdirSync(subDir, { recursive: true });
    for (let i = 0; i < result.items.length; i++) {
      const item = result.items[i];
      if (onItemStart) onItemStart(item, i, result.items.length);
      const filepath = path.join(subDir, item.filename);
      await downloadFile(item.url, filepath, {
        headers: item.headers,
        onProgress: (r, t) => onProgress && onProgress(r, t, item),
      });
      files.push(filepath);
    }
    return { files, merged: false, ffmpeg: ffmpegAvailable };
  }

  // 视频：普通单流
  if (!result.items.some((it) => it.dash)) {
    for (let i = 0; i < result.items.length; i++) {
      const item = result.items[i];
      if (onItemStart) onItemStart(item, i, result.items.length);
      const filepath = path.join(outDir, item.filename);
      await downloadFile(item.url, filepath, {
        headers: item.headers,
        onProgress: (r, t) => onProgress && onProgress(r, t, item),
      });
      files.push(filepath);
    }
    return { files, merged: false, ffmpeg: ffmpegAvailable };
  }

  // 视频：DASH（视频流 + 音频流）
  const vItem = result.items.find((it) => it.kind === 'video');
  const aItem = result.items.find((it) => it.kind === 'audio');

  if (!vItem) throw new Error('DASH 结果缺少视频流');
  if (ffmpegAvailable && aItem) {
    // 方案1：下载到临时文件 → ffmpeg 合并
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'media-parser-'));
    const vTmp = path.join(tmpDir, 'video.m4s');
    const aTmp = path.join(tmpDir, 'audio.m4s');
    if (onItemStart) onItemStart(vItem, 0, 2);
    await downloadFile(vItem.url, vTmp, { headers: vItem.headers, onProgress: (r, t) => onProgress && onProgress(r, t, vItem) });
    if (onItemStart) onItemStart(aItem, 1, 2);
    await downloadFile(aItem.url, aTmp, { headers: aItem.headers, onProgress: (r, t) => onProgress && onProgress(r, t, aItem) });

    const outBase = vItem.filename.replace(/\.mp4$/, '');
    const outFile = path.join(outDir, `${outBase}_merged.mp4`);
    try {
      await mergeMedia(vTmp, aTmp, outFile);
      files.push(outFile);
      merged = true;
    } catch (e) {
      // 合并失败：保留两个文件
      fs.copyFileSync(vTmp, path.join(outDir, vItem.filename));
      fs.copyFileSync(aTmp, path.join(outDir, aItem.filename));
      files.push(path.join(outDir, vItem.filename), path.join(outDir, aItem.filename));
      merged = false;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return { files, merged, ffmpeg: true };
  }

  // 方案2：无 ffmpeg，下载视频流+音频流两个文件
  for (let i = 0; i < result.items.length; i++) {
    const item = result.items[i];
    if (onItemStart) onItemStart(item, i, result.items.length);
    const filepath = path.join(outDir, item.filename);
    await downloadFile(item.url, filepath, {
      headers: item.headers,
      onProgress: (r, t) => onProgress && onProgress(r, t, item),
    });
    files.push(filepath);
  }
  usedFfmpeg = false;
  return { files, merged: false, ffmpeg: usedFfmpeg };
}

/**
 * 并发下载多个结果。
 * @param {object[]} results
 * @param {string} outDir
 * @param {object} [options]
 * @param {number} [options.concurrency=3]
 * @returns {Promise<Array<{result:object, files:string[], error?:Error}>>}
 */
async function downloadBatch(results, outDir, options = {}) {
  const { concurrency = 3 } = options;
  const queue = [...results];
  const workers = [];
  const out = new Array(queue.length);
  const worker = async () => {
    for (;;) {
      const idx = queue.findIndex((r) => r && !r.__started);
      if (idx < 0) break;
      queue[idx].__started = true;
      try {
        const files = await downloadResult(queue[idx], outDir, options);
        out[idx] = { result: queue[idx], files };
      } catch (e) {
        out[idx] = { result: queue[idx], files: [], error: e };
      }
    }
  };
  for (let i = 0; i < Math.min(concurrency, results.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return out;
}

module.exports = {
  downloadFile,
  downloadResult,
  downloadBatch,
  hasFfmpeg,
  mergeMedia,
};
