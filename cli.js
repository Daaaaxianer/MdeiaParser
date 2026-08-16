#!/usr/bin/env node
'use strict';

/**
 * 命令行工具：批量无水印下载。
 *
 * 用法：
 *   node cli.js "https://v.douyin.com/xxx/"                    # 解析并下载到 ./downloads
 *   node cli.js "分享文本..." -o D:/videos                      # 指定输出目录
 *   node cli.js --batch links.txt -o ./downloads               # 批量（每行一个链接）
 *   node cli.js "https://www.bilibili.com/video/BVxxx" --info  # 只解析看信息，不下载
 *   node cli.js --json "https://..."                           # 输出 JSON 解析结果
 */

const path = require('path');
const fs = require('fs');
const core = require('./core');
const { downloadResult } = require('./core/download');
const { sanitizeFilename, platformName } = require('./core/util');

function printHelp() {
  console.log(`
Media Parser - 抖音/快手/B站 批量无水印下载

用法:
  node cli.js <链接或分享文本> [选项]
  node cli.js --batch <txt文件> [选项]

选项:
  -o, --out <目录>        输出目录（默认 ./downloads）
  -b, --batch <文件>      批量下载，文件每行一个链接
  -c, --concurrency <N>   批量并发数（默认 3）
  --info                  只解析并打印信息，不下载
  --json                  只解析并输出 JSON（不下载）
  --no-merge              B站 DASH 不尝试 ffmpeg 合并（保留音视频两个文件）
  -h, --help              显示帮助

示例:
  node cli.js "7.43 复制打开抖音... https://v.douyin.com/xxxx/"
  node cli.js "https://v.kuaishou.com/xxxx" -o D:/videos
  node cli.js "https://www.bilibili.com/video/BV1xx411c7mD" -o ./downloads
  node cli.js --batch links.txt -o ./downloads -c 5
`);
}

function parseArgs(argv) {
  const args = { out: 'downloads', concurrency: 3, merge: true, batch: null, info: false, json: false, urls: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-o':
      case '--out':
        args.out = argv[++i];
        break;
      case '-c':
      case '--concurrency':
        args.concurrency = parseInt(argv[++i], 10) || 3;
        break;
      case '-b':
      case '--batch':
        args.batch = argv[++i];
        break;
      case '--info':
        args.info = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--no-merge':
        args.merge = false;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        args.urls.push(a);
    }
  }
  return args;
}

function readBatchFile(file) {
  const raw = fs.readFileSync(file, 'utf-8');
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function printResult(result, idx) {
  const prefix = idx !== undefined ? `[${idx + 1}] ` : '';
  console.log('');
  console.log(`${prefix}平台: ${platformName(result.platform)} | 类型: ${result.type === 'image' ? '图文' : '视频'}`);
  console.log(`${prefix}标题: ${result.title}`);
  console.log(`${prefix}作者: ${result.author}`);
  if (result.duration) console.log(`${prefix}时长: ${result.duration}s`);
  result.items.forEach((it, i) => {
    console.log(`${prefix}  ${i + 1}. [${it.kind}] ${it.filename}${it.quality ? ` (${it.quality})` : ''}`);
    console.log(`${prefix}      ${it.url}`);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  let inputs = [];
  if (args.batch) {
    inputs = readBatchFile(args.batch);
    if (inputs.length === 0) {
      console.error('[!] 批量文件中没有链接');
      process.exit(1);
    }
    console.log(`[+] 批量文件共 ${inputs.length} 条`);
  } else {
    inputs = args.urls;
    if (inputs.length === 0) {
      printHelp();
      process.exit(1);
    }
  }

  if (args.json) {
    const results = await core.parseBatch(inputs, args.concurrency);
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // 逐个解析 + 下载
  let okCount = 0;
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    console.log(`\n========== ${i + 1}/${inputs.length} 解析: ${core.extractUrl(input) || input} ==========`);
    let result;
    try {
      result = await core.parse(input);
    } catch (e) {
      console.error(`[!] 解析失败: ${e.message}`);
      continue;
    }
    printResult(result, inputs.length > 1 ? i : undefined);

    if (args.info) {
      okCount++;
      continue;
    }

    console.log('');
    let saveDir = outDir;
    if (result.type === 'image') {
      saveDir = path.join(outDir, sanitizeFilename(result.title, 40));
    }
    try {
      const { files, merged, ffmpeg } = await downloadResult(result, saveDir, {
        merge: args.merge,
        onItemStart: (item, j, total) => console.log(`[+] 下载 ${j + 1}/${total}: ${item.filename}`),
        onProgress: (received, total) => {
          if (total > 0) {
            const pct = Math.round((received / total) * 100);
            process.stdout.write(`\r    进度 ${pct}%  (${(received / 1024 / 1024).toFixed(1)}MB)`);
          }
        },
      });
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
      files.forEach((f) => console.log(`[OK] 已保存: ${f}`));
      if (result.bvid && merged) console.log('[OK] DASH 音视频已用 ffmpeg 合并');
      if (result.bvid && !merged && result.merged) {
        console.log('[~] 未合并：下载了视频流与音频流两个文件（安装 ffmpeg 后可自动合并）');
      }
      okCount++;
    } catch (e) {
      console.error(`[!] 下载失败: ${e.message}`);
    }
  }

  console.log(`\n完成：成功 ${okCount}/${inputs.length}`);
  if (okCount < inputs.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[!] 运行出错:', e.message);
  process.exit(1);
});
