'use strict';

/**
 * 抖音（抖音短视频 / 图文笔记）无水印解析器。
 *
 * 解析策略（多级降级）：
 *  1. 短链/长链 → 重定向拿到真实 URL → 提取 aweme_id 与类型（video/note）
 *  2. 优先尝试 www.iesdouyin.com 分享页 window._ROUTER_DATA
 *  3. 其次尝试 www.douyin.com/video|<id> 页面的 RENDER_DATA / _ROUTER_DATA
 *  4. 最后降级到 detail JSON API（自动注册 ttwid cookie 后重试）
 *
 * 无水印：play_addr 本身就是无水印地址；若拿到 playwm 地址则重写为 play。
 */

const { request, resolveRedirects, registerTtwid, UA_MOBILE, UA_DESKTOP } = require('./http');
const {
  ParseError,
  rewriteDouyinNoWatermark,
  pickBestImage,
  sanitizeFilename,
  extFromUrl,
} = require('./util');

const HOSTS = ['douyin.com', 'iesdouyin.com', 'douyinvod.com'];

function match(text) {
  const { extractUrl } = require('./util');
  const u = extractUrl(text);
  if (!u) return false;
  try {
    const h = new URL(u).hostname.toLowerCase();
    return HOSTS.some((s) => h === s || h.endsWith('.' + s));
  } catch {
    return false;
  }
}

/** 从真实 URL 中提取 content_id 和类型 */
function extractIdFromRealUrl(realUrl) {
  let type = null;
  let id = null;

  if (/\/note\//.test(realUrl)) {
    type = 'note';
    const m = realUrl.match(/\/note\/(\d+)/);
    if (m) id = m[1];
  } else if (/\/video\//.test(realUrl)) {
    type = 'video';
    const m = realUrl.match(/\/video\/(\d+)/);
    if (m) id = m[1];
  }

  if (!id) {
    for (const param of ['modal_id', 'note_id', 'item_id', 'aweme_id', 'video_id']) {
      const m = realUrl.match(new RegExp(`${param}=(\\d+)`));
      if (m) {
        id = m[1];
        if (!type && param === 'note_id') type = 'note';
        else if (!type) type = 'video';
        break;
      }
    }
  }
  if (!id) {
    const m = realUrl.match(/(\d{15,})/);
    if (m) {
      id = m[1];
      type = type || 'video';
    }
  }
  return { id, type };
}

/** 深度搜索第一个非空 item_list / aweme_detail */
function findAweme(root) {
  if (!root || typeof root !== 'object') return null;
  if (Array.isArray(root.item_list) && root.item_list.length > 0) return root.item_list[0];
  if (root.aweme_detail && typeof root.aweme_detail === 'object') return root.aweme_detail;
  for (const key of Object.keys(root)) {
    const found = findAweme(root[key]);
    if (found) return found;
  }
  return null;
}

/** 从 aweme item 构建标准结果 */
function buildResult(aweme, id) {
  if (!aweme) return null;
  const desc = aweme.desc || '无标题';
  const nickname = (aweme.author && aweme.author.nickname) || '未知作者';
  const images = Array.isArray(aweme.images) ? aweme.images : [];
  const video = aweme.video || {};

  const items = [];

  if (images.length > 0) {
    // ---- 图文 ----
    for (let i = 0; i < images.length; i++) {
      const url = pickBestImage(images[i].url_list || []);
      if (!url) continue;
      const ext = /\.jpe?g[?/]/i.test(url) ? 'jpeg' : extFromUrl(url) === 'png' ? 'png' : 'jpeg';
      items.push({
        kind: 'image',
        url,
        ext,
        filename: `图片${i + 1}.${ext}`,
        headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.douyin.com/' },
      });
    }
    if (items.length === 0) return null;
    return {
      platform: 'douyin',
      platformName: '抖音',
      type: 'image',
      id: String(aweme.aweme_id || id),
      title: desc,
      author: nickname,
      cover: null,
      items,
    };
  }

  // ---- 视频 ----
  const playAddr = video.play_addr || {};
  let urlList = Array.isArray(playAddr.url_list) ? playAddr.url_list : [];
  // 优先选 douyinvod.com 直链（通常已是无水印）
  let url = urlList.find((u) => /douyinvod\.com/.test(u)) || urlList[0] || null;

  // 若无 url_list，用 uri 构造播放地址
  if (!url && playAddr.uri) {
    url = `https://www.douyin.com/aweme/v1/play/?video_id=${playAddr.uri}`;
  }
  if (!url && video.download_addr && video.download_addr.url_list) {
    url = video.download_addr.url_list[0];
  }
  if (!url) return null;

  url = rewriteDouyinNoWatermark(url);

  const cover = pickBestImage((video.cover || {}).url_list || []) ||
    pickBestImage((video.origin_cover || {}).url_list || []) ||
    pickBestImage((video.dynamic_cover || {}).url_list || []);

  const safeTitle = sanitizeFilename(desc, 40);
  items.push({
    kind: 'video',
    url,
    ext: 'mp4',
    filename: `${safeTitle}_${aweme.aweme_id || id}.mp4`,
    headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.douyin.com/' },
    quality: playAddr.data_size ? `${(playAddr.data_size / 1024 / 1024).toFixed(1)}MB` : undefined,
  });

  return {
    platform: 'douyin',
    platformName: '抖音',
    type: 'video',
    id: String(aweme.aweme_id || id),
    title: desc,
    author: nickname,
    cover,
    duration: video.duration ? Math.round(video.duration / 1000) : null,
    items,
  };
}

/** 方式1：iesdouyin 分享页 _ROUTER_DATA */
async function parseViaIesdouyin(id, type) {
  const paths = [type || 'video', type === 'video' ? 'note' : 'video'];
  for (const p of paths) {
    const url = `https://www.iesdouyin.com/share/${p}/${id}/`;
    let r;
    try {
      r = await request(url, { ua: UA_MOBILE, referer: 'https://www.douyin.com/' });
    } catch {
      continue;
    }
    const m = r.text.match(/window\._ROUTER_DATA\s*=\s*(\{.*?\})<\/script>/s);
    if (!m) continue;
    let data;
    try {
      data = JSON.parse(m[1].trim().replace(/;?\s*$/, ''));
    } catch {
      continue;
    }
    const aweme = findAweme(data);
    if (aweme) return buildResult(aweme, id);
  }
  return null;
}

/** 方式2：www.douyin.com/video|<id> 页面 RENDER_DATA / _ROUTER_DATA */
async function parseViaDouyinPage(id, type) {
  const path = type === 'note' ? 'note' : 'video';
  const url = `https://www.douyin.com/${path}/${id}`;
  let r;
  try {
    r = await request(url, { ua: UA_DESKTOP, referer: 'https://www.douyin.com/' });
  } catch {
    return null;
  }

  // RENDER_DATA（URL 编码的 JSON）
  const mRender = r.text.match(/<script id="RENDER_DATA" type="application\/json">([^<]+)<\/script>/);
  if (mRender) {
    try {
      const data = JSON.parse(decodeURIComponent(mRender[1]));
      const aweme = findAweme(data);
      if (aweme) return buildResult(aweme, id);
    } catch {
      /* ignore */
    }
  }

  // _ROUTER_DATA
  const mRouter = r.text.match(/window\._ROUTER_DATA\s*=\s*(\{.*?\})<\/script>/s);
  if (mRouter) {
    try {
      const data = JSON.parse(mRouter[1].trim().replace(/;?\s*$/, ''));
      const aweme = findAweme(data);
      if (aweme) return buildResult(aweme, id);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 方式3：detail JSON API（需要 ttwid） */
async function parseViaDetailApi(id) {
  const apiUrl =
    'https://www.douyin.com/aweme/v1/web/aweme/detail/' +
    `?aweme_id=${id}` +
    '&device_platform=webapp&aid=6383&channel=channel_pc_web';

  for (let attempt = 0; attempt < 2; attempt++) {
    const cookie = attempt === 0 ? undefined : await registerTtwid();
    try {
      const r = await request(apiUrl, {
        ua: UA_MOBILE,
        referer: 'https://www.douyin.com/',
        cookie,
      });
      const aweme = r.json && r.json.aweme_detail;
      if (aweme) return buildResult(aweme, id);
      // 状态码非 0 或空：尝试注册 ttwid 重试
    } catch {
      if (attempt === 0) continue;
    }
  }
  return null;
}

/**
 * 主入口：解析抖音分享文本/链接。
 * @param {string} text
 * @returns {Promise<object>}
 */
async function parse(text) {
  if (!match(text)) {
    throw new ParseError('不是抖音链接', 'PLATFORM_MISMATCH');
  }

  const { extractUrl } = require('./util');
  const shareUrl = extractUrl(text);
  if (!shareUrl) {
    throw new ParseError('未找到有效链接', 'NO_URL');
  }

  // 1. 拿真实 URL
  let realUrl = shareUrl;
  if (!/douyin\.com\/(video|note)\//.test(shareUrl) && !/iesdouyin\.com\/share\//.test(shareUrl)) {
    realUrl = await resolveRedirects(shareUrl, { ua: UA_MOBILE });
  }
  const { id, type } = extractIdFromRealUrl(realUrl);
  if (!id) {
    throw new ParseError('无法从链接中提取视频 ID', 'NO_ID', realUrl);
  }

  // 2. 多级解析
  let result = await parseViaIesdouyin(id, type);
  if (!result) result = await parseViaDouyinPage(id, type);
  if (!result) result = await parseViaDetailApi(id);

  if (!result) {
    throw new ParseError(
      '解析失败：抖音页面被限速或内容不可用（可能已删除/私密/区域限制）。可稍后重试。',
      'PARSE_FAILED',
      realUrl
    );
  }
  return result;
}

module.exports = { name: 'douyin', match, parse, extractIdFromRealUrl, buildResult, findAweme };
