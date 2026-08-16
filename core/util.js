'use strict';

/**
 * 公共工具函数：链接提取、文件名清洗、URL 重写等。
 * 所有函数保持纯函数，便于单元测试。
 */

const URL_RE = /https?:\/\/[^\s"'<>，。；、）】\]]+/g;

/**
 * 从用户粘贴的分享文本/链接中提取第一个 http(s) 链接。
 * @param {string} text
 * @returns {string|null}
 */
function extractUrl(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(URL_RE);
  return m ? m[0].replace(/[),.;!?，。；]*$/, '') : null;
}

/**
 * 提取文本中所有 http(s) 链接（用于批量）。
 * @param {string} text
 * @returns {string[]}
 */
function extractAllUrls(text) {
  if (!text || typeof text !== 'string') return [];
  return [...new Set((text.match(URL_RE) || []).map((u) => u.replace(/[),.;!?，。；]*$/, '')))];
}

/**
 * 清洗文件名：去掉非法字符、emoji、多余空白，截断长度。
 * @param {string} name
 * @param {number} maxLen
 * @returns {string}
 */
function sanitizeFilename(name, maxLen = 60) {
  if (!name) return 'untitled';
  let s = String(name);
  // 去掉 Windows 文件名非法字符
  s = s.replace(/[\\/:*?"<>|\r\n\t]/g, '');
  // 去掉控制字符与 emoji（按区间粗略过滤）
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '');
  // 合并空白
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, ''); // 防止隐藏文件
  if (!s) return 'untitled';
  return s.slice(0, maxLen).trim() || 'untitled';
}

/**
 * 从 URL 推断扩展名（不含查询串）。
 * @param {string} url
 * @returns {string}
 */
function extFromUrl(url) {
  if (!url) return 'bin';
  try {
    const path = new URL(url).pathname.toLowerCase();
    const m = path.match(/\.([a-z0-9]{2,5})$/);
    return m ? m[1] : 'bin';
  } catch {
    return 'bin';
  }
}

/**
 * 抖音无水印处理：将播放地址中的 playwm 替换为 play。
 * @param {string} url
 * @returns {string}
 */
function rewriteDouyinNoWatermark(url) {
  if (!url) return url;
  return url.replace('/playwm/', '/play/').replace('playwm?', 'play?');
}

/**
 * 优选 jpeg/jpg 图片 URL（清晰度最高），否则取第一个。
 * @param {string[]} urlList
 * @returns {string|null}
 */
function pickBestImage(urlList) {
  if (!Array.isArray(urlList) || urlList.length === 0) return null;
  return urlList.find((u) => /\.jpe?g[?/]|image\/jpeg/i.test(u)) || urlList[0];
}

/**
 * 平台的中文名称
 */
const PLATFORM_NAMES = {
  douyin: '抖音',
  kuaishou: '快手',
  bilibili: '哔哩哔哩',
  weibo: '微博',
  pipixia: '皮皮虾',
  unknown: '未知平台',
};

function platformName(key) {
  return PLATFORM_NAMES[key] || key || '未知平台';
}

/**
 * 简单的 HTTP 状态错误
 */
class HttpError extends Error {
  constructor(message, statusCode, body) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

/**
 * 解析错误（用户可读）
 */
class ParseError extends Error {
  constructor(message, code = 'PARSE_FAILED', detail = null) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
    this.detail = detail;
  }
}

module.exports = {
  URL_RE,
  extractUrl,
  extractAllUrls,
  sanitizeFilename,
  extFromUrl,
  rewriteDouyinNoWatermark,
  pickBestImage,
  platformName,
  HttpError,
  ParseError,
};
