'use strict';

/**
 * 单元测试：不访问网络，用 mock fetch + 真实数据结构 fixtures 验证各解析器逻辑。
 * 运行：node tests/unit.js
 */

const assert = require('assert');
const util = require('../core/util');
const { setFetcher } = require('../core/http');
const core = require('../core');
const douyin = require('../core/douyin');
const kuaishou = require('../core/kuaishou');
const bilibili = require('../core/bilibili');

/* ================= mock fetch ================= */

function mockResponse(status, body, headers = {}, opts = {}) {
  const h = new Map(Object.entries(headers));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k) => h.get(k.toLowerCase()) ?? h.get(k) ?? null,
      getSetCookie: () => (h.get('set-cookie') ? [h.get('set-cookie')] : []),
    },
    url: '',
    text: async () => body,
    json: async () => {
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    },
    arrayBuffer: async () => Buffer.from(body || ''),
    body: null,
  };
}

function mockFetch(routes) {
  return async (url, opts = {}) => {
    const u = String(url);
    for (const r of routes) {
      const hit =
        r.match instanceof RegExp ? r.match.test(u) : typeof r.match === 'string' ? u.includes(r.match) : false;
      if (hit) {
        if (r.redirect) return mockResponse(302, '', { location: r.redirect }, opts);
        const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        return mockResponse(r.status || 200, body, r.headers || {}, opts);
      }
    }
    throw new Error(`mock: 未匹配的路由 ${u}`);
  };
}

/* ================= fixtures ================= */

const DOUYIN_AWEME_VIDEO = {
  aweme_id: '7000000000000000001',
  desc: '抖音测试视频标题 #测试话题',
  author: { nickname: '测试作者' },
  video: {
    duration: 15000,
    cover: { url_list: ['https://p3-sign.douyinpic.com/tos-cn-p-0015/cover~tplv-dy-360p.jpeg?x=1'] },
    play_addr: {
      uri: 'v0200f100000xx',
      url_list: [
        'https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0200f100000xx&ratio=1080p&line=0',
        'https://aweme.snssdk.com/aweme/v1/play/?video_id=v0200f100000xx&ratio=1080p&line=0',
      ],
    },
  },
};

const DOUYIN_ROUTER_HTML = (id, aweme) =>
  '<html><script>window._ROUTER_DATA = ' +
  JSON.stringify({
    loaderData: {
      [`video_(id)/page`]: {
        videoInfoRes: { item_list: [aweme] },
      },
    },
  }) +
  '</script></html>';

const DOUYIN_DETAIL_NOTE = {
  status_code: 0,
  aweme_detail: {
    aweme_id: '7100000000000000002',
    desc: '抖音图文测试',
    author: { nickname: '图文作者' },
    images: [
      { url_list: ['https://p3-sign.douyinpic.com/tos-cn-i-0813/a.jpeg~tplv-dy-360p.jpeg?x=1', 'https://p3-sign.douyinpic.com/tos-cn-i-0813/a.jpeg'] },
      { url_list: ['https://p3-sign.douyinpic.com/tos-cn-i-0813/b.jpeg'] },
    ],
  },
};

const KS_APOLLO_HTML = (id) =>
  '<html><head></head><body><script>window.__APOLLO_STATE__=' +
  JSON.stringify({
    defaultClient: {
      [`VisionVideoDetailPhoto:${id}`]: {
        caption: '快手测试视频',
        coverUrl: 'https://p1.kwaicdn.com/upic/2024/cover.jpg',
        photoUrl: 'https://v2.kwaicdn.com/upic/2024/abc.mp4',
        duration: 12000,
        realLikeCount: 100,
        timestamp: 1700000000000,
      },
      'VisionVideoDetailAuthor:u123': { id: 'u123', name: '快手作者' },
    },
  }) +
  ';(function(){var s;(s=document.currentScript||document.scripts[document.scripts.length-1]).parentNode.removeChild(s);}());</script></body></html>';

const KS_APOLLO_ATLAS_HTML = (id) =>
  '<html><script>window.__APOLLO_STATE__=' +
  JSON.stringify({
    defaultClient: {
      [`VisionVideoDetailPhoto:${id}`]: {
        caption: '快手图集测试',
        coverUrl: 'https://p1.kwaicdn.com/upic/cover.jpg',
        ext_params: { atlas: { cdn: ['p1.kwaicdn.com'], list: ['/upic/1.jpg', '/upic/2.jpg'] } },
      },
      'VisionVideoDetailAuthor:u123': { id: 'u123', name: '图集作者' },
    },
  }) +
  ';(function(){var s;(s=document.currentScript||document.scripts[document.scripts.length-1]).parentNode.removeChild(s);}());</script></html>';

const BILI_VIEW = {
  code: 0,
  message: '0',
  data: {
    bvid: 'BV1xx411c7mD',
    aid: 170001,
    title: 'B站测试视频',
    pic: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
    duration: 300,
    owner: { mid: 1, name: '测试UP主' },
    pages: [
      { cid: 1001, part: 'P1 测试' },
      { cid: 1002, part: 'P2 测试' },
    ],
  },
};

const BILI_PLAYURL_DASH = {
  code: 0,
  data: {
    quality: 80,
    dash: {
      video: [
        { id: 64, baseUrl: 'https://upos-sz-mirrorcos.bilivideo.com/upgcx/video_720.m4s', backupUrl: [] },
        { id: 80, baseUrl: 'https://upos-sz-mirrorcos.bilivideo.com/upgcx/video_1080.m4s', backupUrl: [] },
      ],
      audio: [{ id: 30280, baseUrl: 'https://upos-sz-mirrorcos.bilivideo.com/upgcx/audio.m4s', backupUrl: [] }],
    },
  },
};

const BILI_ARTICLE = {
  code: 0,
  data: {
    title: 'B站专栏测试',
    image_urls: ['https://i0.hdslb.com/bfs/article/1.jpg', 'https://i0.hdslb.com/bfs/article/2.jpg'],
    author: { name: '专栏作者' },
  },
};

const BILI_DYNAMIC_DRAW = {
  code: 0,
  data: {
    item: {
      modules: {
        module_dynamic: {
          major: { draw: { items: [{ src: 'https://i0.hdslb.com/bfs/dynamic/1.jpg' }, { src: 'https://i0.hdslb.com/bfs/dynamic/2.jpg' }] } },
          desc: { text: '动态图片测试' },
        },
        module_author: { name: '动态作者' },
      },
    },
  },
};

const BILI_PAGE_HTML = (bvid) =>
  '<html><script>window.__INITIAL_STATE__=' +
  JSON.stringify({
    videoData: {
      bvid,
      aid: 170001,
      cid: 1001,
      title: 'B站测试视频',
      pic: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
      duration: 300,
      owner: { mid: 1, name: '测试UP主' },
      pages: [
        { cid: 1001, part: 'P1 测试' },
        { cid: 1002, part: 'P2 测试' },
      ],
    },
  }) +
  ';(function(){var s;(s=document.currentScript||document.scripts[document.scripts.length-1]).parentNode.removeChild(s);}());</script></html>';

const KS_MOBILE_PHOTO_HTML = (id) =>
  '<html><body><div id="app"></div>' +
  '<script>window.__KCONF__ = {}</script>' +
  '<script>window.INIT_STATE = {"obfuscated":"yes"}</script>' +
  '<script>' +
  'window.__SSR_DATA__ = {' +
  '"photo":' +
  JSON.stringify({
    singlePicture: false,
    type: 1,
    caption: '快手移动端测试视频',
    userName: '移动端作者',
    photoId: id,
    photoType: 'VIDEO',
    duration: 8000,
    coverUrls: [{ url: 'https://p1.kwaicdn.com/mobile_cover.jpg' }],
    mainMvUrls: [{ cdn: 'tymov2.a.kwimgs.com', url: 'https://tymov2.a.kwimgs.com/upic/mobile_video.mp4' }],
  }) +
  ',"trendingInfo":{"title":"热榜"},"serialInfo":{"valid":false}}' +
  '</script></body></html>';

/* ================= tests ================= */

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/* ---- util ---- */
test('util.extractUrl 从分享文本提取链接', () => {
  const text = '7.43 复制打开抖音，看看【作者的视频】 https://v.douyin.com/AbCdEf/ 复制此链接，打开Dou音搜索';
  assert.strictEqual(util.extractUrl(text), 'https://v.douyin.com/AbCdEf/');
  assert.strictEqual(util.extractUrl('https://www.bilibili.com/video/BV1xx411c7mD?p=2'), 'https://www.bilibili.com/video/BV1xx411c7mD?p=2');
  assert.strictEqual(util.extractUrl('没有链接'), null);
});

test('util.extractAllUrls 提取全部链接', () => {
  const urls = util.extractAllUrls('a https://v.douyin.com/x/ b https://b23.tv/abc c');
  assert.deepStrictEqual(urls, ['https://v.douyin.com/x/', 'https://b23.tv/abc']);
});

test('util.sanitizeFilename 清洗非法字符', () => {
  assert.strictEqual(util.sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij');
  assert.strictEqual(util.sanitizeFilename('  hello  world  '), 'hello world');
  assert.strictEqual(util.sanitizeFilename('...hidden'), 'hidden');
  assert.strictEqual(util.sanitizeFilename(''), 'untitled');
});

test('util.rewriteDouyinNoWatermark', () => {
  const u = 'https://aweme.snssdk.com/aweme/v1/playwm/?video_id=abc';
  assert.strictEqual(util.rewriteDouyinNoWatermark(u), 'https://aweme.snssdk.com/aweme/v1/play/?video_id=abc');
});

test('util.pickBestImage 优选 jpeg', () => {
  const list = ['https://x.webp', 'https://x.jpeg?size=large', 'https://x.jpg'];
  assert.strictEqual(util.pickBestImage(list), 'https://x.jpeg?size=large');
  assert.strictEqual(util.pickBestImage([]), null);
});

test('util.extFromUrl', () => {
  assert.strictEqual(util.extFromUrl('https://x.com/a.mp4?t=1'), 'mp4');
  assert.strictEqual(util.extFromUrl('https://x.com/a'), 'bin');
});

/* ---- 平台检测 ---- */
test('detectPlatform', () => {
  assert.strictEqual(core.detectPlatform('https://v.douyin.com/x/').name, 'douyin');
  assert.strictEqual(core.detectPlatform('https://v.kuaishou.com/x').name, 'kuaishou');
  assert.strictEqual(core.detectPlatform('https://www.bilibili.com/video/BV1xx411c7mD').name, 'bilibili');
  assert.strictEqual(core.detectPlatform('https://example.com/x'), null);
});

/* ---- 抖音 ---- */
test('douyin.extractIdFromRealUrl', () => {
  assert.deepStrictEqual(douyin.extractIdFromRealUrl('https://www.douyin.com/video/7000000000000000001?previous_page=app_code_link'), {
    id: '7000000000000000001',
    type: 'video',
  });
  assert.deepStrictEqual(douyin.extractIdFromRealUrl('https://www.douyin.com/note/7100000000000000002?modal_id=7100000000000000002'), {
    id: '7100000000000000002',
    type: 'note',
  });
  assert.deepStrictEqual(douyin.extractIdFromRealUrl('https://www.douyin.com/discover?modal_id=7200000000000000003'), {
    id: '7200000000000000003',
    type: 'video',
  });
});

test('douyin.parse 短链 → iesdouyin ROUTER_DATA → 无水印视频', async () => {
  const id = '7000000000000000001';
  setFetcher(
    mockFetch([
      { match: /v\.douyin\.com\/test\//, redirect: `https://www.douyin.com/video/${id}?previous_page=app_code_link` },
      { match: `www.douyin.com/video/${id}`, body: '<html>ok</html>' },
      { match: `iesdouyin.com/share/video/${id}`, body: DOUYIN_ROUTER_HTML(id, DOUYIN_AWEME_VIDEO) },
    ])
  );
  const r = await douyin.parse('https://v.douyin.com/test/');
  assert.strictEqual(r.platform, 'douyin');
  assert.strictEqual(r.type, 'video');
  assert.strictEqual(r.title, '抖音测试视频标题 #测试话题');
  assert.strictEqual(r.author, '测试作者');
  assert.strictEqual(r.items.length, 1);
  // playwm → play（无水印）
  assert.ok(!r.items[0].url.includes('playwm'), 'URL 不应包含 playwm');
  assert.ok(r.items[0].url.includes('/play/'), '应重写为 play 无水印地址');
  assert.ok(r.items[0].filename.endsWith('.mp4'));
});

test('douyin.parse 图文 note → detail API images', async () => {
  const id = '7100000000000000002';
  setFetcher(
    mockFetch([
      { match: /v\.douyin\.com\/test2\//, redirect: `https://www.douyin.com/note/${id}` },
      { match: /iesdouyin\.com\/share\/(note|video)\//, body: '<html>shell only</html>' },
      { match: `www.douyin.com/note/${id}`, body: '<html>shell only</html>' },
      { match: 'aweme/v1/web/aweme/detail', body: DOUYIN_DETAIL_NOTE },
    ])
  );
  const r = await douyin.parse('https://v.douyin.com/test2/');
  assert.strictEqual(r.type, 'image');
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.items[0].filename, '图片1.jpeg');
  assert.ok(r.items[0].url.includes('a.jpeg'));
});

test('douyin.parse 非抖音链接报错', async () => {
  await assert.rejects(() => douyin.parse('https://www.bilibili.com/video/BV1xx411c7mD'), /不是抖音链接/);
});

/* ---- 快手 ---- */
test('kuaishou.parse 短链 → APOLLO photoUrl 无水印视频', async () => {
  const id = '3xabc123';
  setFetcher(
    mockFetch([
      { match: /v\.kuaishou\.com\/abc/, redirect: `https://www.kuaishou.com/short-video/${id}?fid=123` },
      { match: 'kuaishou.com/short-video', body: KS_APOLLO_HTML(id) },
    ])
  );
  const r = await kuaishou.parse('https://v.kuaishou.com/abc');
  assert.strictEqual(r.platform, 'kuaishou');
  assert.strictEqual(r.type, 'video');
  assert.strictEqual(r.title, '快手测试视频');
  assert.strictEqual(r.author, '快手作者');
  assert.strictEqual(r.items[0].url, 'https://v2.kwaicdn.com/upic/2024/abc.mp4');
  assert.strictEqual(r.duration, 12);
});

test('kuaishou.parse 图集 atlas', async () => {
  const id = '3xatlas01';
  setFetcher(
    mockFetch([
      { match: 'kuaishou.com/short-video', body: KS_APOLLO_ATLAS_HTML(id) },
    ])
  );
  const r = await kuaishou.parse(`https://www.kuaishou.com/short-video/${id}`);
  assert.strictEqual(r.type, 'image');
  assert.strictEqual(r.items.length, 2);
  assert.ok(r.items[0].url.startsWith('https://p1.kwaicdn.com/'));
});

test('kuaishou.parse 移动端 gifshow 页 photo 对象（无水印 mainMvUrls）', async () => {
  const id = '3xmobile01';
  setFetcher(
    mockFetch([
      { match: /v\.kuaishou\.com\/mob/, redirect: `https://m.gifshow.com/fw/photo/${id}` },
      { match: 'gifshow.com/fw/photo', body: KS_MOBILE_PHOTO_HTML(id) },
    ])
  );
  const r = await kuaishou.parse('https://v.kuaishou.com/mob');
  assert.strictEqual(r.platform, 'kuaishou');
  assert.strictEqual(r.type, 'video');
  assert.strictEqual(r.title, '快手移动端测试视频');
  assert.strictEqual(r.author, '移动端作者');
  assert.strictEqual(r.items[0].url, 'https://tymov2.a.kwimgs.com/upic/mobile_video.mp4');
  assert.strictEqual(r.duration, 8);
});

test('kuaishou.extractApolloState 容错', () => {
  const html = KS_APOLLO_HTML('3xabc123');
  const state = kuaishou.extractApolloState(html);
  assert.ok(state && state.defaultClient['VisionVideoDetailPhoto:3xabc123']);
  assert.strictEqual(kuaishou.extractApolloState('<html>no state</html>'), null);
});

/* ---- B站 ---- */
test('bilibili.parse BV视频 → 视频页 INITIAL_STATE + DASH 音视频流', async () => {
  setFetcher(
    mockFetch([
      { match: 'www.bilibili.com/video/BV1xx411c7mD', body: BILI_PAGE_HTML('BV1xx411c7mD') },
      { match: 'api.bilibili.com/x/player/playurl', body: BILI_PLAYURL_DASH },
      // 兜底路径（view API 被反爬时不应走到这里）
      { match: 'api.bilibili.com/x/web-interface/view', body: BILI_VIEW },
    ])
  );
  const r = await bilibili.parse('https://www.bilibili.com/video/BV1xx411c7mD');
  assert.strictEqual(r.platform, 'bilibili');
  assert.strictEqual(r.type, 'video');
  assert.strictEqual(r.title, 'B站测试视频');
  assert.strictEqual(r.author, '测试UP主');
  assert.strictEqual(r.bvid, 'BV1xx411c7mD');
  assert.strictEqual(r.cid, 1001);
  assert.strictEqual(r.items.length, 2);
  const v = r.items.find((i) => i.kind === 'video');
  const a = r.items.find((i) => i.kind === 'audio');
  assert.ok(v && v.dash && v.url.includes('1080'));
  assert.ok(a && a.dash && a.url.includes('audio'));
});

test('bilibili.parse 多P选择 p=2', async () => {
  setFetcher(
    mockFetch([
      { match: 'www.bilibili.com/video/BV1xx411c7mD', body: BILI_PAGE_HTML('BV1xx411c7mD') },
      { match: 'api.bilibili.com/x/player/playurl', body: BILI_PLAYURL_DASH },
    ])
  );
  const r = await bilibili.parse('https://www.bilibili.com/video/BV1xx411c7mD?p=2');
  assert.strictEqual(r.cid, 1002);
  assert.strictEqual(r.pageNo, 2);
});

test('bilibili.parse 专栏图片 cv', async () => {
  setFetcher(
    mockFetch([{ match: 'api.bilibili.com/x/article/view?id=123', body: BILI_ARTICLE }])
  );
  const r = await bilibili.parse('https://www.bilibili.com/read/cv123');
  assert.strictEqual(r.type, 'image');
  assert.strictEqual(r.title, 'B站专栏测试');
  assert.strictEqual(r.items.length, 2);
});

test('bilibili.parse 动态图片 t.bilibili.com', async () => {
  setFetcher(
    mockFetch([{ match: 'api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=456', body: BILI_DYNAMIC_DRAW }])
  );
  const r = await bilibili.parse('https://t.bilibili.com/456');
  assert.strictEqual(r.type, 'image');
  assert.strictEqual(r.items.length, 2);
  assert.ok(r.title.includes('动态'));
});

/* ---- 主入口 ---- */
test('core.parse 入口与错误处理', async () => {
  const id = '7000000000000000001';
  setFetcher(
    mockFetch([
      { match: /v\.douyin\.com\/test\//, redirect: `https://www.douyin.com/video/${id}?previous_page=app_code_link` },
      { match: `www.douyin.com/video/${id}`, body: '<html>ok</html>' },
      { match: `iesdouyin.com/share/video/${id}`, body: DOUYIN_ROUTER_HTML(id, DOUYIN_AWEME_VIDEO) },
    ])
  );
  const r = await core.parse('看看 https://v.douyin.com/test/ 这个视频');
  assert.strictEqual(r.platform, 'douyin');

  await assert.rejects(() => core.parse('https://www.youtube.com/watch?v=abc'), /暂不支持/);
  await assert.rejects(() => core.parse('没有链接的文字'), /没有找到/);
});

test('core.parseBatch 部分成功部分失败', async () => {
  setFetcher(
    mockFetch([
      { match: /v\.douyin\.com\/test\//, redirect: `https://www.douyin.com/video/7000000000000000001` },
      { match: `www.douyin.com/video/7000000000000000001`, body: '<html>ok</html>' },
      { match: `iesdouyin.com/share/video/7000000000000000001`, body: DOUYIN_ROUTER_HTML('7000000000000000001', DOUYIN_AWEME_VIDEO) },
    ])
  );
  const out = await core.parseBatch(['https://v.douyin.com/test/', 'https://bad.example/x']);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].ok, true);
  assert.strictEqual(out[1].ok, false);
});

/* ================= runner ================= */

async function run() {
  let pass = 0;
  const fails = [];
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      fails.push({ name: t.name, error: e });
      console.log(`  ✗ ${t.name}`);
      console.log(`      ${e.message.split('\n')[0]}`);
    }
  }
  console.log(`\n单元测试: ${pass}/${tests.length} 通过`);
  if (fails.length) {
    console.log('\n失败详情:');
    for (const f of fails) {
      console.log(`--- ${f.name} ---`);
      console.log(f.error.stack || f.error.message);
    }
    process.exit(1);
  }
}

run();
