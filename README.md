# TapMoney

TapTap 小游戏广告收益榜。访客无需登录，点击列头排序、查看真实日报与累计曲线，在浏览器本地导出统计卡、榜单 PNG / CSV、游戏 Logo 和截图。

默认使用 **Cloudflare Pages + GitHub Actions + 仓库 JSON**，也支持可选的 Token 在线管理。Node.js 22.15 或更新版本。

## 本地启动

```bash
npm ci
cp .env.example .env.local
npm run login
npm run collect
npm run preview
```

`login` 打开独立 Chrome，登录 TapTap 开发者后台并进入工作室后，自动保存 Cookie、工作室 ID 到权限 `600` 的 `.env.local`，不打印 Cookie。没有 Chrome 时先运行 `npm exec playwright install chromium`。会话失效后重新登录；Maker PAT 不能替代开发者后台会话。

仓库模式编辑 `config/games.json`：

```json
[
  { "appId": "959305", "name": "增量牧场", "totalStartDate": "2020-01-01" }
]
```

查询默认使用登录工作室 ID，与 TapSulor 相同；必要时用 `queryDeveloperId` 覆盖。Logo、公开截图和制作人会自动获取；作者可在 `config/authors.json` 手动绑定：

```json
[
  {
    "id": "author-example",
    "name": "作者昵称",
    "qq": "",
    "avatarUrl": "",
    "tapUrl": "",
    "gameIds": ["959305"]
  }
]
```

QQ 号优先生成 QQ 头像，头像也可填 HTTPS URL。TapTap / QQ 图片保存到 `site/media/`，随网页同源发布，供本地导图使用。手动作者绑定优先于公开页自动识别。`[]` 可发布空榜。

## Pages 与每日更新

1. Fork / 创建仓库，在 Cloudflare Pages 选择 **导入 Git 仓库**，连接它。生产分支 `main`，构建命令 `npm run build`，输出目录 `dist`，设置 `NODE_VERSION=22`。选择 Git 集成后，数据提交会自动更新网页。
2. 本地完成登录，再配置 Actions Secrets：

   ```bash
   gh auth login
   npm run setup:github -- 你的用户名/仓库名
   ```

   脚本通过标准输入写入 Cookie / 工作室 ID，不打印值、不提交环境文件。默认无需 Cloudflare 部署 Token。
3. 在仓库 Actions 手动运行 **Update ranking**，检查一次真实采集。之后每天北京时间 **10:30** 执行；GitHub 定时任务可能延迟。

```text
本地登录 → Actions Secrets → 每日采集 → 提交公开 JSON / 图片
                                             ↓
                                  Pages Git 自动构建 → 访客
```

`Update ranking` 也会在游戏配置 / 采集代码修改后运行。它先测试，再采集；失败不会提交新快照。部分游戏失败保留原日期和历史，全部失败或登录过期则停止更新。提交仅包含公开配置、收益数据和图片；`.env.local`、浏览器 profile、Token、日志和构建产物都排除在 Git 外。

从全新 runner 查询 TapTap 是否成功取决于会话和上游限制；失败时查看 Actions 状态，必要时重新 `login`、`setup:github`，再手动运行。

本地独立部署也可用：

```bash
npm exec wrangler login
# 新项目：npm exec wrangler pages project create 你的项目名 -- --production-branch main
npm run deploy
```

`deploy` 共用构建入口并发布 Pages；只把公开产物交给 Wrangler，不传 TapTap / 管理凭证。它不创建 Git 集成：准备长期自动部署时优先在 Pages 导入仓库。

## 可选：在线管理

默认 `TAPMONEY_CONFIG_SOURCE=repository`，游戏 / 作者配置来自仓库，页面隐藏管理入口，不运行后端。已有管理 Token 不会自动改变模式。

需要网页管理时：

1. 在 Pages 构建环境设置 `TAPMONEY_CONFIG_SOURCE=cloud`，本地 `.env.local` 也设为 `cloud`。
2. 运行 `npm run admin:setup` 创建 / 沿用 D1、初始化表结构、设置管理 Token 哈希。按命令提示在 Pages 将数据库绑定为 **DB**；生产与预览环境分别配置，预览建议使用独立数据库。
3. 在 `.env.local` 设置实际 Pages 域名 `TAPMONEY_API_URL`；重新部署后运行 `npm run admin:seed` 首次导入配置和快照，已有配置不会被重置。
4. 重新执行 `npm run setup:github -- 用户名/仓库名`，将云模式、API 地址和管理 Token 配置到 Actions。

在线管理模式用 Pages Functions + D1，只有 `/api/*` 请求进入 Functions，其余文件静态托管。点击右下角淡色 `+` 输入管理 Token，可编辑游戏、作者、QQ 头像、TapTap 主页和绑定；Token 只保存在当前标签页的会话存储，Cloudflare 保存 SHA-256 哈希。写入有认证与配置版本冲突保护。

**云模式以 D1 为配置来源**；采集时将云配置备份到 `config/`。此时不要直接修改仓库配置，它会被云配置覆盖。新增游戏等下一次采集获得收益，管理前台不即时查询后台报表。静态 JSON 是公开镜像，实时 API 可立即反映作者 / 游戏配置变化。

本机每日运行仍可用 `npm run daily`，仅采集用 `npm run daily -- --collect-only`。macOS 可用 `npm run schedule -- install --time 10:30`；启用 Actions 后用 `npm run schedule -- remove` 移除本机重复任务。

## JSON / jsDelivr

主站默认读取 Pages 同源 `data/ranking.json`，云模式读取同源 `/api/ranking`。公开快照也保存在 Git 仓库，第三方可读取固定 commit 的镜像：

```text
https://cdn.jsdelivr.net/gh/dogxii/tapmoney@<commit>/site/data/ranking.json
```

`@main` 有 CDN 缓存延迟，不保证每日立即更新；主站不依赖它。仓库模式可在构建环境设置 `TAPMONEY_DATA_URL` 使用公开 HTTPS 镜像，图片仍需同步发布到网站。

## 数据与导出

- 收益来自 `/api/mini-app/v1/ad/payout-report-data`，人民币广告收益，使用报表合计与真实日报，不擅自乘除 100。
- 北京时间，昨日 / 累计截至昨日，本月从 1 日起；缺失日报不补零或插值。旧日期不会混入昨日排行。
- 点击昨日 / 本月 / 累计列头从高到低排序，合计与导出跟随；三列同时显示各自可计算的增长。昨日、累计较前日，本月较上月同期；基准为零或数据不完整时不推算百分比。
- 曲线支持每日 / 累计，30 天 / 90 天 / 全部；累计从完整历史累加，切换窗口不重置。可通过鼠标、触摸和方向键查看日报。
- 名次变化仅比较已收录的同一组游戏，不代表全 TapTap 排行。
- TapSulor 的日活接口读取活跃设备数 `active_device_num`，曝光读取商店转化漏斗 `impression_cnt`。现有示例收益查询成功，但日活 / 曝光返回 403，暂未开放对应榜单；请求失败不会填真实零，不能将商店曝光用于广告 eCPM。
- 游戏统计卡 / 榜单 PNG 用 Canvas 本地生成；超过 20 款可导出分页 ZIP，CSV 包含当前筛选全部结果。素材支持单图和全部 ZIP，部分失败会列出未成功项。导出不调用服务器生成图片、不上传文件。

```bash
npm test
npm run build
npm run preview -- --built
```

`npm test` 验证收益解析、失败保留、历史曲线、认证与配置冲突、公开字段、两种模式的配置和静态构建边界。

[迁移记录](docs/open-source-deployment-plan.md) · [指标与导出方案](docs/stats-and-export-plan.md) · [TapSulor 源码参考](https://github.com/liusu239113/TapSulor-Android/blob/165d2583b31ccbe5887d8d2d9c4b253a0282edbd/web-src/js/main.js#L408)

MIT。第三方图标版权见 `site/THIRD-PARTY-NOTICES.txt`；公开游戏资料与素材不属于本项目代码许可证。
