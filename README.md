<div align="center">

# Media Parser · 批量无水印下载器

抖音 / 快手 / 哔哩哔哩 视频、图片 **无水印批量下载** 工具

零第三方依赖 · 无需登录 · Windows 本地 + 网页版 + REST API 三种形态

</div>

## ✨ 功能特性

- 🪟 **Windows 本地运行**：双击 `start.bat` 即用；或命令行 `node cli.js` / `dl.bat`
- 🌐 **可嵌入个人网站**：自带零依赖 Web 服务（`node:http`）+ REST API，前端单文件可直接 `<iframe>` 嵌入
- 🚫 **无需登录、无需付费**：自动处理抖音 ttwid cookie、B站反爬限流重试等
- 🎬 **视频 + 图文全支持**
  - 抖音：视频、图文笔记（短链 / 长链 / 完整分享文本）
  - 快手：视频、图集（`v.kuaishou.com` / `short-video`）
  - B站：视频（多P / av / 番剧 / b23.tv 短链）、专栏图片、动态/Opus 图片
- 🔄 **批量下载**：txt 文件批量导入、多链接并发、进度显示
- 🎵 **B站 DASH 自动合并**：安装 [FFmpeg](https://ffmpeg.org/) 后自动把音视频流无损合并为单 mp4（未安装自动降级）
- 🧪 **自带测试**：21 项单元测试（离线 mock）+ 5 项在线实测（真实链接）

## 🚀 快速开始

环境要求：**仅需 [Node.js ≥ 18](https://nodejs.org/)**（零 npm 依赖，无需 `npm install`）。
可选：安装 FFmpeg 以获得 B站 DASH 自动合并能力。

### 方式 1：网页版（Windows 推荐）

双击 `start.bat`，自动启动服务并打开浏览器：

```
http://127.0.0.1:8765
```

粘贴抖音/快手/B站 的分享链接或完整分享文本 → 点击「解析」→ 下载。

![local web](local_web.png)

> `start.bat` 内部调用 `start.ps1`（UTF-8 带 BOM，含欢迎横幅/用途说明/环境检查），想自定义欢迎语改 `start.ps1` 即可。

### 方式 2：命令行

```bash
# 单个下载（支持完整分享文本，自动提取链接）
node cli.js "7.43 复制打开抖音... https://v.douyin.com/xxxx/"

# 指定输出目录
node cli.js "https://v.kuaishou.com/xxxx" -o D:/videos

# B站视频（自动下载音视频流；装了 ffmpeg 则自动合并）
node cli.js "https://www.bilibili.com/video/BV1xx411c7mD" -o ./downloads

# 批量下载（txt 每行一个链接/分享文本，可混合平台）
node cli.js --batch links.txt -o ./downloads -c 5

# 只解析看信息 / 输出 JSON
node cli.js --info "https://www.bilibili.com/video/BV1xx411c7mD"
node cli.js --json "https://www.bilibili.com/read/cv12345"
```

Windows 下也可用 `dl.bat "链接" [输出目录]` 快速下载。

### 命令行参数

| 参数 | 说明 |
|------|------|
| `-o, --out <目录>` | 输出目录（默认 `./downloads`） |
| `-b, --batch <文件>` | 批量下载，文件每行一个链接 |
| `-c, --concurrency <N>` | 批量并发数（默认 3） |
| `--info` | 只解析打印信息，不下载 |
| `--json` | 只输出 JSON 解析结果 |
| `--no-merge` | B站 DASH 不尝试 ffmpeg 合并 |

## 🌐 嵌入个人网站

### 方式 1：iframe 嵌入（最简单）

```html
<iframe
  src="http://你的服务器IP:8765"
  width="100%" height="700" style="border:1px solid #e4e7ef;border-radius:12px">
</iframe>
```

前端页面为单文件（内联 CSS/JS，无外部依赖），任何站点直接引用即可。

### 方式 2：REST API 对接

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/parse` | POST | `{"text":"链接或分享文本"}` → 解析结果 |
| `/api/batch` | POST | `{"texts":["链接1","链接2"],"concurrency":3}` → 批量结果 |
| `/api/download` | GET | `?url=<直链>&filename=<文件名>&platform=<平台>` → 代理下载 |
| `/api/download/merged` | GET | `?bvid=&cid=&title=` → B站 DASH 合并下载（无 ffmpeg 时自动降级单文件 mp4） |
| `/api/health` | GET | 健康检查 |

所有接口返回 JSON，均带 `Access-Control-Allow-Origin: *`，可跨域调用。

```bash
# 解析
curl -X POST http://127.0.0.1:8765/api/parse \
  -H "Content-Type: application/json" \
  -d '{"text":"https://v.douyin.com/xxxx/"}'

# 下载某个媒体直链
curl -OJ "http://127.0.0.1:8765/api/download?url=<直链>&filename=video.mp4&platform=douyin"
```

**解析结果结构**：

```json
{
  "platform": "douyin | kuaishou | bilibili",
  "platformName": "抖音 | 快手 | 哔哩哔哩",
  "type": "video | image",
  "id": "内容ID",
  "title": "标题",
  "author": "作者",
  "cover": "封面图URL",
  "duration": 32,
  "items": [
    { "kind": "video|image|audio", "url": "无水印直链", "filename": "建议文件名", "headers": {"User-Agent":"...","Referer":"..."} }
  ],
  "bvid": "B站视频号", "cid": 123, "pages": 3
}
```

### 修改端口 / 局域网访问

```bash
# 方式 1：环境变量
set PORT=9000 && node server.js

# 方式 2：命令行参数
node server.js --port 9000
```

默认监听 `0.0.0.0:8765`，同一局域网内手机/其他电脑可访问 `http://<本机IP>:8765`。

## 📦 支持的平台与链接格式

| 平台 | 支持内容 | 链接格式 |
|------|---------|---------|
| 抖音 | 视频、图文(笔记) | `v.douyin.com/xxx`、`www.douyin.com/video/<id>`、`www.douyin.com/note/<id>`、完整分享文本 |
| 快手 | 视频、图集 | `v.kuaishou.com/xxx`、`www.kuaishou.com/f/xxx`、`www.kuaishou.com/short-video/<id>`、`kuaishou.cn/...` |
| B站 | 视频(含多P/番剧)、专栏图片、动态/Opus 图片 | `bilibili.com/video/BVxxx`、`bilibili.com/video/avxxx`、`b23.tv/xxx`、`bilibili.com/bangumi/play/epxxx`、`bilibili.com/read/cvxxx`、`t.bilibili.com/<id>`、`bilibili.com/opus/<id>` |

> 粘贴**完整分享文本**（含"复制打开抖音"等文案）也能自动提取链接，无需手动清理。

## 🔧 无水印原理

| 平台 | 方法 |
|------|------|
| 抖音 | 短链重定向 → 提取 aweme_id → 多级解析（iesdouyin 分享页 `_ROUTER_DATA` → douyin 页 `RENDER_DATA` → detail JSON API，自动注册 ttwid cookie）；取 `play_addr`/`douyinvod.com` 无水印直链，`playwm` 自动改写为 `play` |
| 快手 | 作品页解析 `__APOLLO_STATE__` 或移动端 `photo` 对象；视频取 `photoUrl`/`mainMvUrls`（无水印原片），图集取 `atlas` 原图 |
| B站 | 视频页 `__INITIAL_STATE__` 取元数据（绕开 view API 反爬），`x/player/playurl` DASH 接口取最高可用画质（未登录通常 1080p 以内）；专栏/动态走官方内容 API |

**说明**：
- 抖音/快手的水印是平台在播放地址上附加的，解析器直接取无水印源地址（play_addr / photoUrl / mainMvUrls），不涉及视频二次处理。
- B站 DASH 为"视频流+音频流"分离格式：装了 FFmpeg 时自动无损合并（`-c copy`）；未装则分别下载两个文件，可手动合并：

  ```bash
  ffmpeg -i video.mp4 -i audio.m4a -c copy -movflags +faststart out.mp4
  ```

## 🧪 测试

```bash
# 全部测试（单元 + 在线实测）
node tests/run.js

# 仅单元测试（mock 数据，不访问网络，可离线运行）
node tests/unit.js

# 仅在线实测（真实链接，平台限流时单项可能失败，不影响其他项）
node tests/live.js
```

覆盖：链接提取、文件名清洗、平台识别、抖音（分享页/详情API/图文）、快手（Apollo/移动端 photo/图集）、B站（视频/多P/专栏/动态）、批量并发、下载链路等。

## 📁 项目结构

```
├── core/                 # 核心库（零依赖，可独立 require 使用）
│   ├── index.js          # 平台注册表 + parse()/parseBatch()
│   ├── http.js           # fetch 封装、重定向、ttwid 注册、UA 管理
│   ├── util.js           # 链接提取、文件名清洗等工具
│   ├── douyin.js         # 抖音解析器
│   ├── kuaishou.js       # 快手解析器
│   ├── bilibili.js       # B站解析器（视频/番剧/专栏/动态）
│   └── download.js       # 流式下载、重试、ffmpeg 合并、并发
├── cli.js                # 命令行工具
├── server.js             # Web 服务（node:http，零依赖）+ REST API
├── web/index.html        # 可嵌入前端（单文件，内联 CSS/JS）
├── tests/                # 单元测试 + 在线实测
├── start.bat             # Windows 启动入口（纯 ASCII，防乱码）
├── start.ps1             # 启动脚本（UTF-8 BOM，欢迎横幅 + 环境检查）
└── dl.bat                # Windows 命令行下载入口
```

在代码中直接使用核心库：

```js
const { parse } = require('./core');
const result = await parse('7.43 复制打开抖音... https://v.douyin.com/xxxx/');
console.log(result.title, result.items[0].url); // 无水印直链
```

## ❓ 常见问题

**Q：双击 start.bat 出现中文乱码/报错？**
A：新版 `start.bat` 已改为纯 ASCII，中文全部在 `start.ps1`（UTF-8 带 BOM）中输出，任何 Windows 代码页下都不会乱码。

**Q：B站视频只下载了"视频流"和"音频流"两个文件？**
A：未安装 FFmpeg。安装后重新下载即可自动合并；或按上文命令手动合并。

**Q：抖音解析失败提示"被限速或内容不可用"？**
A：多为抖音服务端间歇性 WAF 限速，稍等几分钟重试即可；也请确认视频未删除/未设为私密。

**Q：能否商用？**
A：本工具仅供个人学习研究，请遵守平台规则与相关法律法规。

## ⚖️ 免责声明

本工具仅供个人学习、研究使用。请遵守各平台服务条款与《中华人民共和国著作权法》等法律法规，勿用于商业用途或侵犯他人版权。平台接口可能随时变更，解析失败时请稍后重试或更新代码。

## 📄 许可证

[MIT](LICENSE)
