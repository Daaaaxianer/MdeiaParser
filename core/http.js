'use strict';

/**
 * HTTP 层封装：基于 Node 内置 fetch（Node >= 18）。
 * - 统一的 UA / Referer 头
 * - 手动跟随重定向（拿到真实链接）
 * - ttwid 注册（抖音 detail API 需要）
 * - 可注入自定义 fetcher（用于单元测试）
 */

const { HttpError } = require('./util');

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

/** 可注入的 fetch（测试时替换为 mock） */
let fetcher = null;

function getFetcher() {
  return fetcher || globalThis.fetch;
}

/**
 * 注入自定义 fetch（仅测试用）。
 * @param {Function|null} fn
 */
function setFetcher(fn) {
  fetcher = fn || null;
}

/**
 * 通用 GET，返回 { status, headers, text, json, url, cookies }
 */
async function request(url, options = {}) {
  const {
    headers = {},
    ua = UA_DESKTOP,
    redirect = 'follow',
    timeoutMs = 20000,
    referer,
    cookie,
  } = options;

  const finalHeaders = { 'User-Agent': ua, ...headers };
  if (referer) finalHeaders['Referer'] = referer;
  if (cookie) finalHeaders['Cookie'] = cookie;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await getFetcher()(url, {
      headers: finalHeaders,
      redirect,
      signal: controller.signal,
      ...(options.body !== undefined ? { method: options.method || 'POST', body: options.body } : {}),
    });
  } catch (e) {
    clearTimeout(timer);
    const err = new HttpError(`网络请求失败: ${e.message}`, 0);
    err.cause = e;
    throw err;
  }
  clearTimeout(timer);

  const cookies =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const text = await res.text().catch(() => '');
  const result = {
    status: res.status,
    headers: res.headers,
    text,
    url: res.url || url,
    cookies,
  };
  try {
    result.json = text ? JSON.parse(text) : null;
  } catch {
    result.json = null;
  }
  if (res.status >= 400) {
    throw new HttpError(`HTTP ${res.status}: ${url}`, res.status, text);
  }
  return result;
}

/**
 * 手动跟随重定向（redirect: 'manual'），返回最终 URL（不去请求 3xx 之后的内容）。
 * @param {string} url
 * @param {object} options
 * @param {number} maxRedirects
 * @returns {Promise<string>}
 */
async function resolveRedirects(url, options = {}, maxRedirects = 10) {
  let current = url;
  const ua = options.ua || UA_MOBILE;
  const cookie = options.cookie;
  for (let i = 0; i < maxRedirects; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await getFetcher()(current, {
        headers: { 'User-Agent': ua, ...(cookie ? { Cookie: cookie } : {}) },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw new HttpError(`重定向请求失败: ${e.message}`, 0);
    }
    clearTimeout(timer);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return current;
      current = new URL(loc, current).toString();
      // 读 body 以便释放连接
      await res.arrayBuffer().catch(() => {});
      continue;
    }
    return current;
  }
  return current;
}

/**
 * 注册抖音匿名 ttwid cookie。
 * @returns {Promise<string|null>} ttwid cookie 值
 */
async function registerTtwid() {
  try {
    const body = JSON.stringify({
      region: 'cn',
      aid: 1768,
      needFid: false,
      service: 'www.ixigua.com',
      migrate_info: {},
      cbUrlProtocol: 'https',
      union: true,
    });
    const r = await request('https://ttwid.bytedance.com/ttwid/union/register/', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
      ua: UA_MOBILE,
      timeoutMs: 15000,
    });
    // 主来源：register 响应本身就会 Set-Cookie ttwid
    let value = extractTtwid(r.cookies);
    const redirectUrl = r.json && r.json.redirect_url;
    if (!value && redirectUrl) {
      // 次来源：访问 callback 地址（必须用手机 UA，桌面 UA 不下发 cookie）
      const cb = await request(redirectUrl, {
        ua: UA_MOBILE,
        redirect: 'manual',
        timeoutMs: 15000,
      });
      value = extractTtwid(cb.cookies);
    }
    return value;
  } catch {
    return null;
  }
}

function extractTtwid(cookies) {
  const hit = (cookies || []).find((c) => c.startsWith('ttwid='));
  if (!hit) return null;
  return hit.split(';')[0]; // ttwid=<值>
}

module.exports = {
  UA_DESKTOP,
  UA_MOBILE,
  setFetcher,
  getFetcher,
  request,
  resolveRedirects,
  registerTtwid,
};
