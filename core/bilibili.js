'use strict';

/**
 * 哔哩哔哩（B站）解析器。
 *
 * 支持：
 *  - 视频：/video/BVxxx、/video/avxxx、?p=N 多P、番剧 /bangumi/play/epxxx
 *  - 专栏图片：/read/cvxxx
 *  - 动态/Opus 图片或视频：t.bilibili.com/<id>、/opus/<id>
 *  - 短链：b23.tv
 *
 * 视频流：x/player/playurl DASH 接口（fnval=4048），返回最高可用画质的
 * 视频流 + 音频流；CLI/服务端可自动用 ffmpeg 合并。未登录通常可达 1080p。
 */

const { request, resolveRedirects, UA_DESKTOP } = require('./http');
const { ParseError, sanitizeFilename } = require('./util');

const HOSTS = ['bilibili.com', 'b23.tv', 'bili2233.cn'];

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

const API_HEADERS = {
  Referer: 'https://www.bilibili.com/',
  'User-Agent': UA_DESKTOP,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * B站 API JSON 请求（带限流/反爬重试）。
 * code -509(请求过于频繁) / -412 时退避重试。
 */
async function apiJson(url, headers = API_HEADERS, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await request(url, { headers });
      const j = r.json;
      if (j && (j.code === -509 || j.code === -412)) {
        lastErr = new Error(`B站限流(code=${j.code})`);
        await sleep(800 * (i + 1));
        continue;
      }
      return j;
    } catch (e) {
      lastErr = e;
      await sleep(500 * (i + 1));
    }
  }
  throw lastErr || new Error('B站 API 请求失败');
}

/** 从视频页 HTML 提取 window.__INITIAL_STATE__ */
function extractInitialState(html) {
  const keyword = 'window.__INITIAL_STATE__=';
  const start = html.indexOf(keyword);
  if (start < 0) return null;
  let end = html.indexOf(';(function', start);
  if (end < 0) end = html.indexOf('</script>', start);
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(start + keyword.length, end).trim());
  } catch {
    return null;
  }
}

/**
 * 获取视频元数据。
 * 优先从视频页 HTML 的 __INITIAL_STATE__ 提取（web 页面一般不会被反爬 412）；
 * 失败时兜底调用 x/web-interface/view API。
 */
async function getVideoMeta(bvidOrPath) {
  try {
    const r = await request(`https://www.bilibili.com/video/${bvidOrPath}`, {
      headers: API_HEADERS,
    });
    const state = extractInitialState(r.text);
    const vd = state && state.videoData;
    if (vd && vd.cid && vd.title) {
      return {
        bvid: vd.bvid || bvidOrPath,
        aid: vd.aid,
        title: vd.title,
        pic: vd.pic,
        owner: vd.owner || { name: '未知UP主' },
        duration: vd.duration || 0,
        pages: Array.isArray(vd.pages) && vd.pages.length ? vd.pages : [{ cid: vd.cid, part: '' }],
      };
    }
  } catch {
    /* fall through to view API */
  }
  const api = /^BV/.test(bvidOrPath)
    ? `https://api.bilibili.com/x/web-interface/view?bvid=${bvidOrPath}`
    : `https://api.bilibili.com/x/web-interface/view?aid=${bvidOrPath}`;
  const j = await apiJson(api);
  const data = j && j.data;
  if (!data) {
    throw new ParseError('视频不存在或解析失败', 'PARSE_FAILED', api);
  }
  return data;
}

/** 提取视频流（DASH 或 durl） */
async function fetchPlayUrl({ bvid, cid }) {
  const api =
    'https://api.bilibili.com/x/player/playurl' +
    `?bvid=${bvid}&cid=${cid}` +
    '&qn=127&fnval=4048&fourk=1';
  const j = await apiJson(api);
  const data = j && j.data;
  if (!data) {
    throw new ParseError('B站播放地址接口无数据（可能需要登录）', 'PARSE_FAILED', api);
  }
  return data;
}

/**
 * 从 view API 数据构建视频结果。
 * @param {object} view view API 的 data
 * @param {string} bvid
 * @param {number} pageNo 1-based
 */
async function buildVideoResult(view, bvid, pageNo = 1) {
  const pages = Array.isArray(view.pages) ? view.pages : [{ cid: view.cid, part: '' }];
  const page = pages[Math.min(Math.max(pageNo, 1), pages.length) - 1] || pages[0];
  const cid = page.cid;
  if (!cid) throw new ParseError('未找到该分P的 cid', 'PARSE_FAILED');

  const play = await fetchPlayUrl({ bvid, cid });
  const title = view.title || '无标题';
  const partSuffix = page.part && page.part !== title ? `_${sanitizeFilename(page.part, 30)}` : '';
  const base = sanitizeFilename(title, 40) + partSuffix;
  const items = [];
  let merged = false;

  // DASH：视频流 + 音频流
  if (play.dash && play.dash.video && play.dash.video.length) {
    const pickBest = (arr) =>
      arr
        .filter((t) => t.baseUrl || (t.backupUrl && t.backupUrl[0]))
        .sort((a, b) => (b.id || 0) - (a.id || 0))[0];
    const v = pickBest(play.dash.video);
    const a = pickBest(play.dash.audio || []);
    if (v) {
      const vUrl = v.baseUrl || v.backupUrl[0];
      items.push({
        kind: 'video',
        url: vUrl,
        ext: 'mp4',
        filename: `${base}.mp4`,
        quality: `视频流(qn=${v.id})`,
        headers: API_HEADERS,
        dash: true,
      });
    }
    if (a) {
      items.push({
        kind: 'audio',
        url: a.baseUrl || a.backupUrl[0],
        ext: 'm4a',
        filename: `${base}.m4a`,
        quality: '音频流',
        headers: API_HEADERS,
        dash: true,
      });
    }
    if (items.length === 2) merged = true;
  }

  // 兜底：单一 mp4/flv（含音轨）
  if (items.length === 0 && play.durl && play.durl.length) {
    const d = play.durl[0];
    const isFlv = /\.flv\b/.test(d.url) || /flv/.test(d.url);
    items.push({
      kind: 'video',
      url: d.url,
      ext: isFlv ? 'flv' : 'mp4',
      filename: `${base}.${isFlv ? 'flv' : 'mp4'}`,
      quality: `qn=${play.quality || 64}`,
      headers: API_HEADERS,
    });
  }

  if (items.length === 0) {
    throw new ParseError('未找到可用的视频流', 'PARSE_FAILED');
  }

  return {
    platform: 'bilibili',
    platformName: '哔哩哔哩',
    type: 'video',
    id: bvid,
    title,
    author: (view.owner && view.owner.name) || '未知UP主',
    cover: view.pic || null,
    duration: view.duration ? Math.round(view.duration) : null,
    pages: pages.length,
    pageNo,
    bvid,
    cid,
    merged,
    items,
  };
}

/**
 * 主入口：解析 B 站分享文本/链接。
 * @param {string} text
 * @returns {Promise<object>}
 */
async function parse(text) {
  if (!match(text)) {
    throw new ParseError('不是B站链接', 'PLATFORM_MISMATCH');
  }
  const { extractUrl } = require('./util');
  const shareUrl = extractUrl(text);
  if (!shareUrl) {
    throw new ParseError('未找到有效链接', 'NO_URL');
  }

  // 短链重定向
  let realUrl = shareUrl;
  if (/b23\.tv|bili2233\.cn/.test(shareUrl)) {
    realUrl = await resolveRedirects(shareUrl, { ua: UA_DESKTOP });
  }

  const u = new URL(realUrl);
  const path = u.pathname;

  // ---- 专栏图片 /read/cv123 ----
  let m = path.match(/\/read\/cv(\d+)/i);
  if (!m && /\/read\/mobile/i.test(path) && u.searchParams.get('id')) {
    m = [null, u.searchParams.get('id')];
  }
  if (m) {
    const id = m[1];
    const j = await apiJson(`https://api.bilibili.com/x/article/view?id=${id}`);
    const data = j && j.data;
    if (!data || !Array.isArray(data.image_urls) || data.image_urls.length === 0) {
      throw new ParseError('专栏图片解析失败（可能已删除或没有图片）', 'PARSE_FAILED');
    }
    const title = data.title || '专栏';
    return {
      platform: 'bilibili',
      platformName: '哔哩哔哩',
      type: 'image',
      id: String(id),
      title,
      author: (data.author && data.author.name) || '未知作者',
      cover: data.image_urls[0] || null,
      items: data.image_urls.map((url, i) => ({
        kind: 'image',
        url,
        ext: 'jpeg',
        filename: `图片${i + 1}.jpeg`,
        headers: API_HEADERS,
      })),
    };
  }

  // ---- 动态 / Opus：t.bilibili.com/<id> 或 /opus/<id> ----
  m = path.match(/^\/(opus)\/(\d+)/) || path.match(/^\/t\.bilibili\.com\/(\d+)/) || (u.hostname === 't.bilibili.com' ? path.match(/^\/(\d+)/) : null);
  if (m) {
    const id = m[2] || m[1];
    const j = await apiJson(
      `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${id}`
    );
    const item = j && j.data && j.data.item;
    if (!item) {
      throw new ParseError('动态解析失败（可能已删除）', 'PARSE_FAILED');
    }
    const major = (item.modules && item.modules.module_dynamic && item.modules.module_dynamic.major) || {};
    // 动态里的视频 → 转成 BV 视频
    if (major.archive && major.archive.bvid) {
      const bvid = major.archive.bvid;
      const view = await getVideoMeta(bvid);
      if (view) return buildVideoResult(view, bvid, 1);
      throw new ParseError('动态中的视频解析失败', 'PARSE_FAILED');
    }
    // 动态图片（draw）
    const draw = major.draw;
    let images = [];
    if (draw && Array.isArray(draw.items)) {
      images = draw.items.map((it) => it.src).filter(Boolean);
    }
    if (images.length === 0) {
      // 老版动态 content 内嵌 JSON
      const content = item.content;
      if (typeof content === 'string') {
        try {
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed.images)) images = parsed.images.map((im) => im.img_src).filter(Boolean);
        } catch {
          /* ignore */
        }
      }
    }
    if (images.length === 0) {
      throw new ParseError('动态中没有可下载的图片/视频', 'PARSE_FAILED');
    }
    const descText =
      (item.modules && item.modules.module_dynamic && item.modules.module_dynamic.desc && item.modules.module_dynamic.desc.text) ||
      '动态图片';
    return {
      platform: 'bilibili',
      platformName: '哔哩哔哩',
      type: 'image',
      id: String(id),
      title: sanitizeFilename(descText, 40) || '动态图片',
      author: (item.modules && item.modules.module_author && item.modules.module_author.name) || '未知作者',
      cover: images[0],
      items: images.map((url, i) => ({
        kind: 'image',
        url,
        ext: 'jpeg',
        filename: `图片${i + 1}.jpeg`,
        headers: API_HEADERS,
      })),
    };
  }

  // ---- 番剧 /bangumi/play/ep123 ----
  m = path.match(/\/bangumi\/play\/ep(\d+)/i);
  if (m) {
    const epId = m[1];
    const j = await apiJson(
      `https://api.bilibili.com/pgc/view/web/season?ep_id=${epId}`
    );
    const result = j && j.result;
    const ep = Array.isArray(result && result.episodes)
      ? result.episodes.find((e) => String(e.id) === String(epId))
      : null;
    if (!ep || !ep.bvid || !ep.cid) {
      throw new ParseError('番剧解析失败', 'PARSE_FAILED');
    }
    const view = {
      title: (result && result.title) || ep.long_title || '番剧',
      pic: (result && result.cover) || null,
      owner: { name: (result && result.up_info && result.up_info.uname) || '未知' },
      duration: ep.duration || 0,
      pages: null,
      cid: ep.cid,
    };
    const play = await fetchPlayUrl({ bvid: ep.bvid, cid: ep.cid });
    // 复用 buildVideoResult 的组装逻辑
    const title = `${view.title} ${ep.long_title || ''}`.trim();
    const base = sanitizeFilename(title, 60);
    const items = [];
    if (play.dash && play.dash.video && play.dash.video.length) {
      const pickBest = (arr) =>
        arr
          .filter((t) => t.baseUrl || (t.backupUrl && t.backupUrl[0]))
          .sort((a, b) => (b.id || 0) - (a.id || 0))[0];
      const v = pickBest(play.dash.video);
      const a = pickBest(play.dash.audio || []);
      if (v) {
        items.push({
          kind: 'video',
          url: v.baseUrl || v.backupUrl[0],
          ext: 'mp4',
          filename: `${base}.mp4`,
          quality: `视频流(qn=${v.id})`,
          headers: API_HEADERS,
          dash: true,
        });
      }
      if (a) {
        items.push({
          kind: 'audio',
          url: a.baseUrl || a.backupUrl[0],
          ext: 'm4a',
          filename: `${base}.m4a`,
          quality: '音频流',
          headers: API_HEADERS,
          dash: true,
        });
      }
    }
    if (items.length === 0 && play.durl && play.durl.length) {
      items.push({
        kind: 'video',
        url: play.durl[0].url,
        ext: 'mp4',
        filename: `${base}.mp4`,
        quality: `qn=${play.quality || 64}`,
        headers: API_HEADERS,
      });
    }
    if (items.length === 0) throw new ParseError('未找到可用的视频流', 'PARSE_FAILED');
    return {
      platform: 'bilibili',
      platformName: '哔哩哔哩',
      type: 'video',
      id: ep.bvid,
      title,
      author: view.owner.name,
      cover: view.pic,
      duration: ep.duration ? Math.round(ep.duration / 1000) : null,
      bvid: ep.bvid,
      cid: ep.cid,
      merged: items.length === 2,
      items,
    };
  }

  // ---- 普通视频 /video/BV... 或 /av... ----
  m = path.match(/\/video\/(BV[0-9A-Za-z]+)/) || path.match(/\/video\/av(\d+)/i);
  if (m) {
    const pageNo = parseInt(u.searchParams.get('p') || u.searchParams.get('page') || '1', 10) || 1;
    const view = await getVideoMeta(m[1]);
    return buildVideoResult(view, view.bvid, pageNo);
  }

  throw new ParseError('暂不支持该B站链接类型', 'UNSUPPORTED_URL', realUrl);
}

module.exports = { name: 'bilibili', match, parse, fetchPlayUrl, buildVideoResult, extractInitialState };
