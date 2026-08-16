'use strict';

/**
 * 在线实测：请求真实平台接口验证解析 + 下载链路。
 * 运行：node tests/live.js
 * 说明：平台接口可能限流/变更，单项失败不影响整体退出码（单独报告）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../core');
const { downloadFile } = require('../core/download');
const { extractUrl } = require('../core/util');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-live-'));

async function tryDownloadCover(result) {
  if (!result.cover) return { ok: false, reason: '无封面图' };
  const file = path.join(tmpDir, 'cover_' + result.platform + '.' + (result.cover.includes('.webp') ? 'webp' : 'jpg'));
  await downloadFile(result.cover, file, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const size = fs.statSync(file).size;
  return { ok: size > 1000, size };
}

async function main() {
  const results = [];

  async function runCase(name, fn) {
    try {
      const info = await fn();
      results.push({ name, ok: true, info });
      console.log(`  ✓ ${name}${info ? '  ' + JSON.stringify(info) : ''}`);
    } catch (e) {
      results.push({ name, ok: false, error: e.message });
      console.log(`  ✗ ${name}  → ${e.message}`);
    }
  }

  console.log('== B站实测 ==');
  await runCase('B站视频解析 BV1xx411c7mD', async () => {
    const r = await core.parse('https://www.bilibili.com/video/BV1xx411c7mD');
    const info = { title: r.title, author: r.author, items: r.items.length, cid: r.cid };
    const d = await tryDownloadCover(r);
    info.coverDownload = d.ok ? `${d.size} bytes` : d.reason;
    return info;
  });

  await runCase('B站专栏图片 cv', async () => {
    // 尝试几个已知专栏，任一成功即可
    for (const id of ['12132451', '80000']) {
      try {
        const r = await core.parse(`https://www.bilibili.com/read/cv${id}`);
        return { title: r.title, images: r.items.length };
      } catch {
        /* try next */
      }
    }
    throw new Error('已知专栏均不可用');
  });

  console.log('\n== 抖音实测 ==');
  await runCase('抖音 detail API 解析', async () => {
    const ids = ['7600361826030865707', '7581044356631612699'];
    let lastErr = null;
    for (const id of ids) {
      try {
        const r = await core.parse(`https://www.douyin.com/video/${id}`);
        const info = { id, title: r.title, author: r.author, type: r.type, items: r.items.length };
        const d = await tryDownloadCover(r);
        info.coverDownload = d.ok ? `${d.size} bytes` : d.reason;
        return info;
      } catch (e) {
        lastErr = e.message;
      }
    }
    throw new Error(`已知 aweme_id 均解析失败: ${lastErr}`);
  });

  console.log('\n== 快手实测 ==');
  await runCase('快手热榜作品解析', async () => {
    // 从快手首页 __APOLLO_STATE__ 热榜节点提取真实 photoIds
    const res = await fetch('https://www.kuaishou.com/?isHome=1', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Cookie: 'did=web_' + 'a'.repeat(16),
      },
    });
    const html = await res.text();
    const kw = 'window.__APOLLO_STATE__=';
    const start = html.indexOf(kw);
    if (start < 0) throw new Error('首页无 __APOLLO_STATE__');
    let end = html.indexOf(';(function', start);
    if (end < 0) end = html.indexOf('</script>', start);
    const state = JSON.parse(html.slice(start + kw.length, end).trim());
    const dc = state.defaultClient || {};
    const ids = [];
    for (const key of Object.keys(dc)) {
      const v = dc[key];
      if (v && typeof v === 'object' && v.photoIds && Array.isArray(v.photoIds.json)) {
        ids.push(...v.photoIds.json);
      }
    }
    const uniq = [...new Set(ids)].slice(0, 3);
    if (uniq.length === 0) throw new Error('首页热榜无 photoIds');
    let lastErr = null;
    for (const id of uniq) {
      try {
        const r = await core.parse(`https://www.kuaishou.com/short-video/${id}`);
        const info = { id, title: r.title.slice(0, 30), author: r.author, type: r.type, items: r.items.length };
        const d = await tryDownloadCover(r);
        info.coverDownload = d.ok ? `${d.size} bytes` : d.reason;
        return info;
      } catch (e) {
        lastErr = e.message;
      }
    }
    throw new Error(`候选ID均失败: ${lastErr}`);
  });

  console.log('\n== 下载链路实测 ==');
  await runCase('B站视频首帧/封面真实下载', async () => {
    // 下载真实视频文件的一小段：用 Range 请求验证直链可用性（不保存完整视频）
    const r = await core.parse('https://www.bilibili.com/video/BV1xx411c7mD');
    const item = r.items.find((i) => i.kind === 'video') || r.items[0];
    const res = await fetch(item.url, {
      headers: { ...item.headers, Range: 'bytes=0-65535' },
    });
    if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new Error('数据过短');
    return { bytes: buf.length, status: res.status };
  });

  console.log(`\n实测结果: ${results.filter((r) => r.ok).length}/${results.length} 通过`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('\n未通过项（多为平台限流/链接失效，非代码缺陷）:');
    failed.forEach((f) => console.log(`  - ${f.name}: ${f.error}`));
  }
}

main().catch((e) => {
  console.error('实测运行异常:', e);
  process.exit(1);
});
