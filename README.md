# TapMoney

TapTap 小游戏与作者作品广告收益榜。访客无需登录，点击列头排序、查看真实日报与累计曲线，在浏览器本地导出统计卡、榜单 PNG / CSV、游戏 Logo 和截图。

[在线演示](https://tapmoney.pages.dev/) · [源码](https://github.com/dogxii/tapmoney)

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

## 多个独立榜单

首页 `/` 是群友榜，`/hot` 是热门榜。顶部可切换；每个榜单独立收录游戏，提供「游戏 / 作者」视图。排序、搜索、名次比较、合计、统计详情和导出只使用当前榜的数据。同一款游戏可加入多个榜单；各榜收益与历史独立，官方名称、Logo 和制作人资料跨榜复用。

仓库模式编辑 `config/boards.json`：

```json
{
  "boards": [
    {
      "id": "home",
      "slug": "",
      "name": "群友榜",
      "games": [
        { "appId": "959305", "name": "增量牧场", "totalStartDate": "2020-01-01" }
      ],
      "authors": []
    },
    { "id": "hot", "slug": "hot", "name": "热门榜", "games": [], "authors": [] }
  ]
}
```

`id` 保持稳定，`slug` 决定子路径；必须有且只有一个空 `slug` 对应首页。其余路径用小写字母、数字和短横线，不能与 `api`、`data`、`media`、`shared` 等保留路径冲突。最多 20 个榜单，每榜最多 10,000 款游戏。游戏 ID 在各自榜内唯一；作者归属自动识别，不再配置手动作者。

查询默认使用登录工作室 ID，与 TapSulor 相同；必要时在游戏上用 `queryDeveloperId` 覆盖。相同游戏、工作室和日期区间的报表请求在一次采集中复用；各榜的累计起始日期和失败历史独立保存。游戏名称、Logo、公开截图、制作人昵称、头像和主页均来自 TapTap 官方页面。资料缓存一周，公开快照可在全新 Actions runner 上复用资料，无须每天重新抓取；改名不会拆分身份。用户与工作室使用不同的 ID 命名空间，有明确制作人时采用制作人，否则展示工作室。

作者榜只汇总**当前榜已收录作品的广告收益**，不代表作者实际分成或未收录作品收入。合作作品给每位制作人计入完整作品金额，可能重复归属，因此作者榜不提供跨作者总计。某期任一作品数据缺失或日期过期时，该作者的该期合计显示 `—`，不将未知值当作零。增长率以各作品基准之和计算，不平均百分比；曲线只显示各作品日报齐全的日期，累计曲线包含各作品此前已有的收益。

Logo、截图和头像只保存 TapTap 原链接，由浏览器按需加载，不预下载图片或保存详情 HTML。图片导出在浏览器完成；不支持跨域读取的图片会使用文字占位，素材可打开原链接保存。空 `games` 可发布空榜。

在线管理可添加、移除游戏，并新建、改名、修改子路径或删除非首页榜单。添加游戏只输入 TapTap 链接或 ID，先预览官方资料再加入；不提供游戏或作者资料编辑。旧手动作者、QQ 头像和绑定配置不再生效。旧单榜 D1 配置、快照以及 `config/games.json` 可读取并迁移到群友榜；新配置只写入 `config/boards.json`，以新文件为准。

热门榜已收录 2026-10-15 完整遍历 TapTap Maker 公开游戏列表得到的 6,183 款游戏：PC、iOS、Android 分别遍历并按游戏 ID 去重。新增的 1,249 款已完成首轮收益尝试，其中 883 款取得有效数值。该接口只有前后页链接，没有总数字段；统计总量需要沿分页遍历并按游戏 ID 去重，范围仅限该接口的 Maker 可见列表，不代表整个 TapTap。采集任务只更新已加入游戏的数据，不会自动扩充名单。公开列表的顺序不代表收益排名。

本地发现 PC、iOS、Android 的完整公开名单：

```bash
npm run discover
# 中断后执行同一命令续跑；重新完整抓取使用 --fresh
# npm run discover -- --platforms ios,android --output .local/mobile-games
```

无需登录，串行请求、启动间隔至少 3 秒，严格沿接口下一页链接遍历，遇 HTTP 错误立即停止并保留断点。结果保存于 `.local/maker-platforms/`：`pc.json`、`ios.json`、`android.json` 为各平台断点与名单，`games.json` 为跨平台去重结果，`new-games.json` 为相对本地热门榜配置新增的游戏，`report.json` 为数量与完成状态。只保存公开 JSON 和图片链接，不抓详情页或图片，不触发收益采集，不自动修改榜单。发现名单没有每榜 10,000 款的限制；导入榜单时仍需遵守配置上限。动态列表在抓取期间可能变化，各平台总量以当次完整遍历结果为准。

收益采集默认串行、请求间隔 3 秒。`TAPMONEY_CONCURRENCY` 可设置同时处理 1–10 款游戏，所有收益请求（包括重试）仍共用 `TAPTAP_REQUEST_DELAY_MS` 控制启动间隔；仅提高并发不会突破该间隔。用一个进程并发处理并统一落盘，不要让多个进程写同一份快照。公开资料默认串行、间隔 3 秒，缓存一周；补齐工具内部支持最多 5 个受控并发，所有请求仍共用启动间隔。遇到 HTTP 429 或登录失效会停止派发新请求，等已发出的请求结束后保留上一份快照，不继续提交后续游戏。

## Pages 与每日更新

1. Fork / 创建仓库，在 Cloudflare Pages 选择 **导入 Git 仓库**，连接它。生产分支 `main`，构建命令 `npm run build`，输出目录 `dist`，设置 `NODE_VERSION=22`。选择 Git 集成后，数据提交会自动更新网页。
2. 本地完成登录，再配置 Actions Secrets：

   ```bash
   gh auth login
   npm run setup:github -- 你的用户名/仓库名
   ```

   脚本通过标准输入写入 Cookie / 工作室 ID，不打印值、不提交环境文件。默认无需 Cloudflare 部署 Token。
3. 在仓库 Actions 手动运行 **Update ranking**。采集仅支持手动触发，定时和代码推送均不会启动采集。默认每次最多处理 40 款，先跳过已取得昨日数据的游戏，再按最久未尝试的顺序续采；同一游戏当天失败后让出队列，次日可手动重试。群友榜先于热门榜安排，两个榜单的数据和作者仍独立。

```text
本地登录 → Actions Secrets → 手动分批采集 → 提交公开 JSON
                                             ↓
                                  Pages Git 自动构建 → 访客
```

`Update ranking` 仅手动运行。它先测试，再采集；未轮到的游戏不会请求收益或资料页。每批保留其他游戏的金额、历史、作者和图片链接，旧日期的数据标记为历史数据，新游戏显示待采集。失败游戏记录尝试时间并保留原金额与日期，不会阻塞后续游戏；登录过期或 HTTP 429 则停止整轮且不覆盖快照。当日全部处理完后，后续任务不再请求 TapTap，次日重新轮转。提交仅包含公开配置、收益数据、公开尝试时间和图片链接；`.env.local`、浏览器 profile、Token、日志和构建产物都排除在 Git 外。

`TAPMONEY_BATCH_SIZE` 可调整每批数量（默认 40，范围 1–500）；`npm run collect -- --force` 可在批次上限内重采已处理过的游戏。4,934 款名单约需 124 批完成首轮，不会每天自动重爬。各游戏显示自己的统计日期，不能把尚未采集的数据当作零收益。

从全新 runner 查询 TapTap 是否成功取决于会话和上游限制；失败时查看 Actions 状态，必要时重新 `login`、`setup:github`，再手动运行。

本地独立部署也可用：

```bash
npm exec wrangler login
# 新项目：npm exec wrangler pages project create 你的项目名 -- --production-branch main
npm run deploy
```

`deploy` 共用构建入口并发布 Pages；只把公开产物交给 Wrangler，不传 TapTap / 管理凭证。它不创建 Git 集成：准备长期自动部署时优先在 Pages 导入仓库。

## 可选：在线管理

默认 `TAPMONEY_CONFIG_SOURCE=repository`，榜单和收录游戏来自仓库，页面隐藏管理入口，不运行后端。已有管理 Token 不会自动改变模式。

需要网页管理时：

1. 在 Pages 构建环境设置 `TAPMONEY_CONFIG_SOURCE=cloud`，本地 `.env.local` 也设为 `cloud`。
2. 运行 `npm run admin:setup` 创建 / 沿用 D1、初始化表结构、设置管理 Token 哈希。按命令提示在 Pages 将数据库绑定为 **DB**；生产与预览环境分别配置，预览建议使用独立数据库。
3. 在 `.env.local` 设置实际 Pages 域名 `TAPMONEY_API_URL`；重新部署后运行 `npm run admin:seed` 首次导入配置和快照，已有配置不会被重置。
4. 重新执行 `npm run setup:github -- 用户名/仓库名`，将云模式、API 地址和管理 Token 配置到 Actions。

在线管理模式用 Pages Functions + D1，只有 `/api/*` 请求进入 Functions，其余文件静态托管。点击右下角淡色 `+` 输入管理 Token，可按榜单添加或移除游戏、管理榜单和触发采集；游戏和作者资料自动同步 TapTap；Token 只保存在当前标签页的会话存储，Cloudflare 保存 SHA-256 哈希。写入有认证与配置版本冲突保护。

采集脚本将快照按完整记录拆成约 256 KiB 的小批次上传，Worker 逐批校验和保存，无须在单次请求中解析、清洗整份收益历史。上传时计算排行基准，管理页和榜单不读取历史日报，游戏与作者详情只取对应作品的历史。D1 分批读取，全部记录和身份校验通过后才原子切换版本；上传中断时旧快照继续生效，下次成功发布会清理过期分片。新格式旧版本保留半小时，供正在进行的读取完成；旧单文档和事务分片快照仍可直接读取。配置上传限制为 2 MiB，分批上传每片最多 2 MiB，每榜最多 10,000 款游戏、10,000 位作者。

**云模式以 D1 为配置来源**；采集时将云配置备份到 `config/`。此时不要直接修改仓库配置，它会被云配置覆盖。新增游戏后手动触发下一批获得收益，批次队列覆盖全部榜单。静态 JSON 是公开镜像，实时 API 可立即反映榜单收录范围变化。

管理页工具栏的采集图标可触发同一套 **Update ranking** 工作流，并显示排队、运行、成功或失败状态。关闭管理页不影响任务，完成后自动刷新榜单；已有任务运行时复用该任务，多标签页提交也不会重复派发。

启用手动采集：在 GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens 创建专用 Token，Repository access 仅选择此仓库，Repository permissions 只添加 **Actions: Read and write**（Metadata 只读自动授予）。将 Token 保存到本地 `.local/github-actions-token.txt`，然后运行：

```bash
npm run collect:setup -- 你的用户名/仓库名 --token-file .local/github-actions-token.txt
```

脚本将仓库名和专用 Token 配置为 Pages 的 `COLLECT_REPOSITORY` / `COLLECT_TOKEN` 服务端 Secret；重新部署后生效。也可在 Pages 控制台直接配置这两项。Token 到期后替换 Secret 并重新部署。浏览器只发送管理 Token，TapTap Cookie 仍由 Actions 使用。

本机每日运行仍可用 `npm run daily`，仅采集用 `npm run daily -- --collect-only`。macOS 可用 `npm run schedule -- install --time 10:30`；启用 Actions 后用 `npm run schedule -- remove` 移除本机重复任务。

## JSON / jsDelivr

主站首屏按榜单读取摘要：静态模式为 `/data/boards/index.json`、`/data/boards/hot.json`，云模式为 `/api/ranking?view=summary&path=...`。摘要只包含当前榜单的排行字段，作者视图复用同份摘要，点击游戏或作者时再加载相应日报、作品列表和素材链接；重复打开复用当前页面缓存。表格每页 100 款，全榜搜索、排序、合计与导出在本地完成，翻页不请求后端。统计、导出和管理模块按需加载。

构建后的 JS / CSS 使用内容指纹及一年不可变缓存，版本更新会自动换 URL。公开 JSON / API 缓存 60 秒并支持条件请求；云端使用边缘缓存，边缘未命中时优先读取 D1 中与配置、快照版本对应的摘要，避免每次读取完整历史。管理接口不缓存，手动刷新及管理保存后主动重新验证；其他访客可能在短暂缓存期内看到旧数据。API 不可用时回退构建时的静态数据。

完整快照仍保留在 `/data/ranking.json`、`/api/ranking` 和 Git 仓库，第三方可读取固定 commit 的镜像：

```text
https://cdn.jsdelivr.net/gh/dogxii/tapmoney@<commit>/site/data/ranking.json
```

快照采用 `schemaVersion: 2`，公共日期字段在顶层，`boards[]` 包含各榜的 `id`、`slug`、`name`、`games` 和 `authors`。域名根目录托管，使用 Pages 默认的 SPA 回退（不添加顶层 `404.html`），直接访问或刷新 `/hot/` 也能加载。其他托管平台需要配置未匹配的页面路径回退到 `index.html`。

`@main` 有 CDN 缓存延迟，不保证每日立即更新；主站不依赖它。仓库模式可在构建环境设置 `TAPMONEY_DATA_URL` 使用完整快照的公开 HTTPS 镜像，此时读取该镜像的完整 JSON。图片使用快照中的 TapTap 原链接。

## 导出静态离线包

接口不可用时，可以把当前公开快照和完整静态页面一次性打包：

```bash
npm run package:static
```

默认从线上 `/data/ranking.json` 读取快照，生成 `output/tapmoney-static-YYYY-MM-DD/`。如果线上接口只能通过代理访问，或已经核对本地快照与线上文件一致，可使用：

```bash
npm run package:static -- --local
```

输出目录本身就是静态站点根目录，上传到 Cloudflare Pages、Nginx 或其他静态托管即可；页面只读取 `data/` 下的 JSON，不依赖 `/api`。`backup/ranking.json` 保存打包快照，`backup/tapmoney.sql` 是可导入 SQLite / D1 `documents` 表的备份，`backup/tapmoney.sqlite` 是同一份数据的 SQLite 文件，`backup/MANIFEST.json` 记录来源和 SHA-256。也可以指定 `--source URL|文件`、`--board 榜单ID` 和 `--output 目录`；指定 `--board hot` 会只保留热门榜并把它改为首页 `/`，旧 `/hot` 路径会重定向到首页。

## 数据与导出

- 收益来自 `/api/mini-app/v1/ad/payout-report-data`，人民币广告收益，使用报表合计与真实日报，不擅自乘除 100。
- 北京时间，昨日 / 累计截至昨日，本月从 1 日起；缺失日报不补零或插值。旧日期不会混入昨日排行。
- 点击昨日 / 本月 / 累计列头从高到低排序，合计与导出跟随；三列同时显示各自可计算的增长。昨日、累计较前日，本月较上月同期；基准为零或数据不完整时不推算百分比。
- 曲线支持每日 / 累计，30 天 / 90 天 / 全部；累计从完整历史累加，切换窗口不重置。可通过鼠标、触摸和方向键查看日报。
- 名次变化仅比较已收录的同一组游戏，不代表全 TapTap 排行。
- TapSulor 的日活接口读取活跃设备数 `active_device_num`，曝光读取商店转化漏斗 `impression_cnt`。现有示例收益查询成功，但日活 / 曝光返回 403，暂未开放对应榜单；请求失败不会填真实零，不能将商店曝光用于广告 eCPM。
- 游戏 / 作者统计卡、游戏 / 作者榜单 PNG 用 Canvas 本地生成；超过 20 款可导出分页 ZIP，CSV 包含当前筛选全部结果。素材支持单图和全部 ZIP，部分失败会列出未成功项。导出不调用服务器生成图片、不上传文件。

```bash
npm test
npm run build
npm run preview -- --built
```

`npm test` 验证收益解析、失败保留、历史曲线、认证与配置冲突、公开字段、多榜隔离、旧数据迁移、报表复用、两种模式的配置和静态构建边界。

[迁移记录](docs/open-source-deployment-plan.md) · [指标与导出方案](docs/stats-and-export-plan.md) · [TapSulor 源码参考](https://github.com/liusu239113/TapSulor-Android/blob/165d2583b31ccbe5887d8d2d9c4b253a0282edbd/web-src/js/main.js#L408)

MIT。第三方图标版权见 `site/THIRD-PARTY-NOTICES.txt`；公开游戏资料与素材不属于本项目代码许可证。
