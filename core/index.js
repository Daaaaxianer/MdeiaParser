'use strict';

/**
 * Media Parser 核心入口：平台注册表 + parse()。
 *
 * 用法：
 *   const { parse, detectPlatform } = require('./core');
 *   const result = await parse('7.43 复制打开抖音... https://v.douyin.com/xxx/');
 */

const douyin = require('./douyin');
const kuaishou = require('./kuaishou');
const bilibili = require('./bilibili');
const { extractUrl, extractAllUrls, ParseError, platformName } = require('./util');

const PLATFORMS = [douyin, kuaishou, bilibili];

/** 已注册平台列表（含名称） */
function listPlatforms() {
  return PLATFORMS.map((p) => p.name || '');
}/** 检测输入属于哪个平台（按注册顺序返回第一个匹配） */
function detectPlatform(text) {
  for (const p of PLATFORMS) {
    if (p.match(text)) return p;
  }
  return null;
}

/**
 * 解析单条分享文本/链接。
 * @param {string} text
 * @returns {Promise<object>} 标准结果结构
 */
async function parse(text) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new ParseError('请输入链接或分享文本', 'EMPTY_INPUT');
  }
  const url = extractUrl(text);
  if (!url) {
    throw new ParseError('输入中没有找到 http(s) 链接', 'NO_URL');
  }
  const platform = detectPlatform(text);
  if (!platform) {
    throw new ParseError(
      `暂不支持该平台链接：${url}（当前支持：${PLATFORMS.map((p) => p.name).join('、')}）`,
      'UNSUPPORTED_PLATFORM'
    );
  }
  return platform.parse(text);
}

/**
 * 批量解析（多条文本，可含换行）。
 * @param {string[]} texts
 * @param {number} [concurrency=3]
 * @returns {Promise<Array<{ok:boolean, result?:object, error?:string, input:string}>>}
 */
async function parseBatch(texts, concurrency = 3) {
  const out = new Array(texts.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const idx = next++;
      if (idx >= texts.length) break;
      const input = texts[idx];
      try {
        const result = await parse(input);
        out[idx] = { ok: true, input, result };
      } catch (e) {
        out[idx] = { ok: false, input, error: e.message };
      }
    }
  };
  const n = Math.min(concurrency, texts.length);
  const workers = [];
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

module.exports = {
  PLATFORMS,
  listPlatforms,
  detectPlatform,
  parse,
  parseBatch,
  extractUrl,
  extractAllUrls,
  platformName,
  ParseError,
  douyin,
  kuaishou,
  bilibili,
};
