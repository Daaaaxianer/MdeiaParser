'use strict';

/**
 * 快手（快手短视频 / 图集）无水印解析器。
 *
 * 解析流程：
 *  1. 支持 v.kuaishou.com/<码>、www.kuaishou.com/f/<码>（重定向）、
 *     www.kuaishou.com/short-video/<作品ID>、kuaishou.cn/short-video/<作品ID>
 *  2. 抓取作品页，解析 window.__APOLLO_STATE__ JSON
 *  3. 从 defaultClient 中取 VisionVideoDetailPhoto:<id> 节点：
 *       - 视频：photoUrl（无水印直链）
 *       - 图集：ext_params.atlas.cdn + ext_params.atlas.list
 *  4. 兜底：解析 window.__INITIAL_STATE__（APP 页）或 "photo" 正则
 */

const crypto = require('crypto');
const { request, resolveRedirects, UA_MOBILE, UA_DESKTOP } = require('./http');
const { ParseError, pickBestImage, sanitizeFilename } = require('./util');

const HOSTS = ['kuaishou.com', 'kuaishou.cn'];

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

function randomDid() {
  return 'web_' + crypto.randomBytes(8).toString('hex');
}

function defaultCookie() {
  return `did=${randomDid()}; kpf=PC_WEB; kpn=KUAISHOU_VISION`;
}

/** 从页面 HTML 中提取 __APOLLO_STATE__ JSON 字符串 */
function extractApolloState(html) {
  const keyword = 'window.__APOLLO_STATE__=';
  const start = html.indexOf(keyword);
  if (start < 0) return null;
  let end = html.indexOf(';(function(){var s', start);
  if (end < 0) end = html.indexOf('</script>', start);
  if (end < 0) return null;
  const raw = html.slice(start + keyword.length, end).trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 深度搜索值（用于兜底路径） */
function deepFind(obj, predicate, maxDepth = 8, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > maxDepth) return null;
  if (predicate(obj)) return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const f = deepFind(item, predicate, maxDepth, depth + 1);
      if (f) return f;
    }
    return null;
  }
  for (const k of Object.keys(obj)) {
    const f = deepFind(obj[k], predicate, maxDepth, depth + 1);
    if (f) return f;
  }
  return null;
}

/** 从 Apollo state 中找作品节点 */
function findPhotoNode(state, id) {
  const dc = state && state.defaultClient;
  if (!dc || typeof dc !== 'object') return null;
  // 1) 精确 key
  for (const key of [`VisionVideoDetailPhoto:${id}`, `VisionVideoDetailAtlas:${id}`]) {
    if (dc[key] && typeof dc[key] === 'object') return { node: dc[key], key };
  }
  // 2) 任意 VisionVideoDetailPhoto:* 节点（ID 不匹配时兜底）
  const candidates = Object.keys(dc).filter((k) => k.startsWith('VisionVideoDetailPhoto:'));
  for (const key of candidates) {
    const node = dc[key];
    if (node && typeof node === 'object') {
      // 优先 photoUrl 或 atlas 节点
      if (node.photoUrl || (node.ext_params && node.ext_params.atlas)) {
        return { node, key };
      }
    }
  }
  return null;
}

/** 查找作者节点 */
function findAuthorNode(state) {
  const dc = state && state.defaultClient;
  if (!dc || typeof dc !== 'object') return null;
  const key = Object.keys(dc).find((k) => k.startsWith('VisionVideoDetailAuthor:'));
  return key ? dc[key] : null;
}

/** 从 Apollo 节点构建结果 */
function buildFromApollo(state, id) {
  const found = findPhotoNode(state, id);
  if (!found) return null;
  const node = found.node;
  const authorNode = findAuthorNode(state);
  const author = (authorNode && (authorNode.name || authorNode.user_name)) || '未知作者';

  const cover = node.coverUrl || (node.coverUrls && node.coverUrls[0]) || null;
  const caption = node.caption || '无标题';
  const duration = node.duration ? Math.round(node.duration / 1000) : null;

  // ---- 图集 ----
  const atlas = node.ext_params && node.ext_params.atlas;
  if (atlas && Array.isArray(atlas.cdn) && Array.isArray(atlas.list) && atlas.list.length > 0) {
    const cdn = atlas.cdn[0] || '';
    const items = atlas.list
      .map((p, i) => {
        if (typeof p !== 'string' || !p) return null;
        const url = /^https?:/.test(p) ? p : `https://${cdn}${p}`;
        return {
          kind: 'image',
          url,
          ext: 'jpeg',
          filename: `图片${i + 1}.jpeg`,
          headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.kuaishou.com/' },
        };
      })
      .filter(Boolean);
    if (items.length === 0) return null;
    return {
      platform: 'kuaishou',
      platformName: '快手',
      type: 'image',
      id: String(id),
      title: caption,
      author,
      cover,
      items,
    };
  }

  // ---- 视频 ----
  const videoUrl = node.photoUrl || node.playUrl || (node.photo && node.photo.photoUrl);
  if (!videoUrl) return null;
  const safeTitle = sanitizeFilename(caption, 40);
  return {
    platform: 'kuaishou',
    platformName: '快手',
    type: 'video',
    id: String(id),
    title: caption,
    author,
    cover,
    duration,
    items: [
      {
        kind: 'video',
        url: videoUrl,
        ext: 'mp4',
        filename: `${safeTitle}_${id}.mp4`,
        headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.kuaishou.com/' },
      },
    ],
  };
}

/**
 * 从 HTML 中用平衡括号扫描提取 "photo":{...} 对象。
 * 移动端 m.gifshow.com 分享页包含该明文 JSON（photo 与 trendingInfo/serialInfo 平级）。
 * 校验：JSON 可解析且包含视频/图集字段。
 */
function extractPhotoObject(html) {
  let searchFrom = 0;
  for (;;) {
    const start = html.indexOf('"photo":{', searchFrom);
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = start + '"photo":'.length; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) return null;
    try {
      const photo = JSON.parse(html.slice(start + '"photo":'.length, end + 1));
      if (
        photo &&
        typeof photo === 'object' &&
        ((Array.isArray(photo.mainMvUrls) && photo.mainMvUrls.length) ||
          photo.photoUrl ||
          (photo.ext_params && photo.ext_params.atlas) ||
          (photo.manifest && photo.manifest.adaptationSet))
      ) {
        return photo;
      }
    } catch {
      /* try next occurrence */
    }
    searchFrom = end + 1;
  }
}

/** 从移动端 photo 对象构建结果 */
function buildFromMobilePhoto(photo, id) {
  if (!photo || typeof photo !== 'object') return null;
  const caption = photo.caption || '无标题';
  const author = photo.userName || photo.userEid || '未知作者';
  const cover =
    (Array.isArray(photo.coverUrls) && photo.coverUrls[0] && photo.coverUrls[0].url) ||
    photo.coverUrl ||
    (Array.isArray(photo.webpCoverUrls) && photo.webpCoverUrls[0] && photo.webpCoverUrls[0].url) ||
    null;

  // ---- 图集 ----
  const atlas = photo.ext_params && photo.ext_params.atlas;
  if (atlas && Array.isArray(atlas.list) && atlas.list.length > 0) {
    const cdn = (Array.isArray(atlas.cdn) && atlas.cdn[0]) || '';
    const items = atlas.list
      .map((p, i) => {
        if (typeof p !== 'string' || !p) return null;
        const url = /^https?:/.test(p) ? p : `https://${cdn}${p}`;
        return {
          kind: 'image',
          url,
          ext: 'jpeg',
          filename: `图片${i + 1}.jpeg`,
          headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.kuaishou.com/' },
        };
      })
      .filter(Boolean);
    if (items.length > 0) {
      return {
        platform: 'kuaishou',
        platformName: '快手',
        type: 'image',
        id: String(photo.photoId || id),
        title: caption,
        author,
        cover,
        items,
      };
    }
  }

  // ---- 视频：mainMvUrls 为无水印原片，其次 photoUrl / manifest ----
  let videoUrl = null;
  if (Array.isArray(photo.mainMvUrls) && photo.mainMvUrls.length && photo.mainMvUrls[0].url) {
    videoUrl = photo.mainMvUrls[0].url;
  } else if (photo.photoUrl) {
    videoUrl = photo.photoUrl;
  } else if (photo.manifest && Array.isArray(photo.manifest.adaptationSet)) {
    const rep = photo.manifest.adaptationSet.find((s) => Array.isArray(s.representation) && s.representation.length);
    if (rep && rep.representation[0].url) videoUrl = rep.representation[0].url;
  }
  if (!videoUrl) return null;

  return {
    platform: 'kuaishou',
    platformName: '快手',
    type: 'video',
    id: String(photo.photoId || id),
    title: caption,
    author,
    cover,
    duration: photo.duration ? Math.round(photo.duration / 1000) : null,
    items: [
      {
        kind: 'video',
        url: videoUrl,
        ext: 'mp4',
        filename: `${sanitizeFilename(caption, 40)}_${photo.photoId || id}.mp4`,
        headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.kuaishou.com/' },
      },
    ],
  };
}

/** 兜底：从 INIT_STATE / photo 正则解析（APP 版页面） */
function buildFromInitState(html, id) {
  // 方式 A：window.INIT_STATE = {...}
  const mInit = html.match(/window\.INIT_STATE\s*=\s*(\{.*?\});?\s*<\/script>/s);
  let root = null;
  if (mInit) {
    try {
      root = JSON.parse(mInit[1]);
    } catch {
      root = null;
    }
  }
  if (root) {
    const photo = deepFind(root, (o) => o && typeof o === 'object' && (o.photoUrl || (o.atlas && o.atlas.list)));
    if (photo) {
      const caption = photo.caption || '无标题';
      if (photo.atlas && Array.isArray(photo.atlas.list) && photo.atlas.list.length) {
        const cdn = (photo.atlas.cdn || [''])[0] || '';
        return {
          platform: 'kuaishou',
          platformName: '快手',
          type: 'image',
          id: String(id),
          title: caption,
          author: (photo.userName || '未知作者'),
          cover: (photo.coverUrls && photo.coverUrls[0]) || null,
          items: photo.atlas.list.map((p, i) => ({
            kind: 'image',
            url: /^https?:/.test(p) ? p : `https://${cdn}${p}`,
            ext: 'jpeg',
            filename: `图片${i + 1}.jpeg`,
            headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.kuaishou.com/' },
          })),
        };
      }
      const videoUrl = photo.photoUrl || photo.playUrl;
      if (videoUrl) {
        return {
          platform: 'kuaishou',
          platformName: '快手',
          type: 'video',
          id: String(id),
          title: caption,
          author: photo.userName || '未知作者',
          cover: (photo.coverUrls && photo.coverUrls[0]) || null,
          items: [
            {
              kind: 'video',
              url: videoUrl,
              ext: 'mp4',
              filename: `${sanitizeFilename(caption, 40)}_${id}.mp4`,
              headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.kuaishou.com/' },
            },
          ],
        };
      }
    }
  }

  // 方式 B：正则 "photo":({...}),"serialInfo"
  const mPhoto = html.match(/"photo":(\{.*?\}),"serialInfo"/s);
  if (mPhoto) {
    try {
      const photo = JSON.parse(mPhoto[1]);
      if (photo && photo.photoUrl) {
        return {
          platform: 'kuaishou',
          platformName: '快手',
          type: 'video',
          id: String(id),
          title: photo.caption || '无标题',
          author: photo.userName || '未知作者',
          cover: (photo.coverUrls && photo.coverUrls[0]) || null,
          items: [
            {
              kind: 'video',
              url: photo.photoUrl,
              ext: 'mp4',
              filename: `${sanitizeFilename(photo.caption || '无标题', 40)}_${id}.mp4`,
              headers: { 'User-Agent': UA_MOBILE, Referer: 'https://www.kuaishou.com/' },
            },
          ],
        };
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 主入口：解析快手分享文本/链接。
 * @param {string} text
 * @returns {Promise<object>}
 */
async function parse(text) {
  if (!match(text)) {
    throw new ParseError('不是快手链接', 'PLATFORM_MISMATCH');
  }
  const { extractUrl } = require('./util');
  const shareUrl = extractUrl(text);
  if (!shareUrl) {
    throw new ParseError('未找到有效链接', 'NO_URL');
  }

  // 1. 真实 URL + ID
  let realUrl = shareUrl;
  if (/v\.kuaishou\.com\//.test(shareUrl) || /\/f\/[A-Za-z0-9]+/.test(shareUrl)) {
    realUrl = await resolveRedirects(shareUrl, { ua: UA_MOBILE });
  }
  let id = null;
  let m = realUrl.match(/short-video\/([A-Za-z0-9]+)/);
  if (m) id = m[1];
  if (!id) {
    m = realUrl.match(/\/fw\/photo\/([A-Za-z0-9]+)/);
    if (m) id = m[1];
  }
  if (!id) {
    m = realUrl.match(/photoId=([A-Za-z0-9]+)/);
    if (m) id = m[1];
  }
  if (!id) {
    m = realUrl.match(/(\d{10,})/);
    if (m) id = m[1];
  }
  if (!id) {
    throw new ParseError('无法从快手链接中提取作品 ID', 'NO_ID', realUrl);
  }

  // 2. 抓取作品页（尝试手机/桌面两种 UA）
  let html = null;
  for (const ua of [UA_MOBILE, UA_DESKTOP]) {
    try {
      const r = await request(realUrl, { ua, cookie: defaultCookie(), referer: 'https://www.kuaishou.com/' });
      html = r.text;
      if (html && html.length > 1000) break;
    } catch {
      /* try next */
    }
  }
  if (!html) {
    throw new ParseError('快手页面请求失败', 'NETWORK_FAIL', realUrl);
  }

  // 3. 解析
  const apollo = extractApolloState(html);
  let result = apollo ? buildFromApollo(apollo, id) : null;
  if (!result) {
    const photo = extractPhotoObject(html);
    result = photo ? buildFromMobilePhoto(photo, id) : null;
  }
  if (!result) result = buildFromInitState(html, id);

  if (!result) {
    throw new ParseError(
      '解析失败：未在快手页面中找到作品数据（作品可能已删除或需要登录）。',
      'PARSE_FAILED',
      realUrl
    );
  }
  return result;
}

module.exports = {
  name: 'kuaishou',
  match,
  parse,
  extractApolloState,
  extractPhotoObject,
  buildFromApollo,
  buildFromMobilePhoto,
};
