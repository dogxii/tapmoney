# TapMoney

TapTap 小游戏与作者作品广告收益榜。访客无需登录，可以查看收益日报、累计曲线、作者榜并在浏览器本地导出统计卡、榜单 PNG / CSV、Logo 和截图。

[在线演示](https://tapmoney.pages.dev/) · [源码](https://github.com/dogxii/tapmoney)

项目现在是纯静态站点：榜单配置和公开快照保存在 Git 仓库，页面使用公开 JSON，默认通过 jsDelivr 读取最新主分支快照。没有 Pages Functions、D1、管理 Token 或在线管理入口。Node.js 22.15 或更新版本。

## 本地启动

```bash
npm ci
cp .env.example .env.local
npm run login
npm run collect
npm run build
npm run preview -- --built
```

`login` 打开独立 Chrome，登录 TapTap 开发者后台并进入工作室后，将 Cookie 和工作室 ID 保存到权限为 `600` 的 `.env.local`，不会打印 Cookie。没有 Chrome 时先运行 `npm exec playwright install chromium`。会话失效后重新登录；Maker PAT 不能替代开发者后台会话。

## 多个独立榜单

首页 `/` 是群友榜，`/hot` 是热门榜。每个榜单独立收录游戏，提供游戏 / 作者视图；排序、搜索、名次比较、合计、统计详情和导出只使用当前榜的数据。同一款游戏可以加入多个榜单，各榜收益与历史独立，官方名称、Logo 和制作人资料跨榜复用。

榜单配置在 `config/boards.json`：

```json
{
  "boards": [
    {
      "id": "home",
      "slug": "",
      "name": "群友榜",
      "games": [{ "appId": "959305", "name": "增量牧场", "totalStartDate": "2020-01-01" }],
      "authors": []
    },
    { "id": "hot", "slug": "hot", "name": "热门榜", "games": [], "authors": [] }
  ]
}
```

必须有且只有一个空 `slug` 对应首页；每榜最多 10,000 款游戏。作者归属由 TapTap 官方资料自动识别，不再配置手动作者。Logo、截图和头像只保存 TapTap 原链接，由浏览器按需加载，不预下载图片或详情 HTML。

热门榜已收录 2026-10-15 完整遍历 TapTap Maker 公开游戏列表得到的 6,183 款游戏：PC、iOS、Android 分别遍历并按游戏 ID 去重。新增的 1,249 款已完成首轮收益尝试，其中 883 款取得有效数值。该数量只代表 Maker 接口可见列表，不代表整个 TapTap；采集任务只更新已加入游戏的数据，不会自动扩充名单。

发现完整公开名单：

```bash
npm run discover
# 中断后重复执行可续跑；重新抓取使用 --fresh
```

发现不需要登录，结果保存于 `.local/maker-platforms/`，不会自动修改榜单或触发收益采集。

收益采集默认串行、请求间隔 3 秒。`TAPMONEY_CONCURRENCY` 可设置 1–10 个并发，但所有请求仍共用 `TAPTAP_REQUEST_DELAY_MS`。遇到 HTTP 429 或登录失效会停止派发新请求并保留上一份快照。

## 纯静态发布与更新

构建命令为 `npm run build`，输出目录为 `dist`。现有 Pages 项目只需要静态托管这个目录，不需要 Functions、D1 绑定、环境变量或密钥。也可以把 `dist` 部署到任意静态主机。

构建后的运行配置默认使用：

```text
https://cdn.jsdelivr.net/gh/dogxii/tapmoney@main/site/data/ranking.json
```

可以在构建时用 `TAPMONEY_DATA_URL` 指定其他公开 HTTPS JSON 镜像。页面仍会保留构建目录中的榜单摘要和详情文件作为静态资源；使用完整 JSON 时，详情直接从快照读取。jsDelivr 的 `@main` 可能有缓存延迟，要求固定版本时使用具体 commit 地址。

GitHub Actions 的 **Update ranking** 只在手动触发时运行：读取仓库 `config/boards.json`，使用 `TAPTAP_COOKIE` / `TAPTAP_DEVELOPER_ID` 采集，提交 `site/data/ranking.json`，随后由 Pages Git 集成重新构建。配置 Actions Secrets：

```bash
gh auth login
npm run setup:github -- dogxii/tapmoney
```

这个命令只写入两个 TapTap Secrets，不配置 Cloudflare、D1 或管理凭证。也可以在本机运行 `npm run daily -- --collect-only`；`npm run daily` 会采集并生成静态构建，但不会调用任何云端 API。

## JSON / jsDelivr

完整公开快照位于 `site/data/ranking.json`，固定 commit 的镜像地址为：

```text
https://cdn.jsdelivr.net/gh/dogxii/tapmoney@<commit>/site/data/ranking.json
```

快照使用 `schemaVersion: 2`，顶层包含公共日期字段，`boards[]` 包含各榜的 `id`、`slug`、`name`、`games` 和 `authors`。静态页面首屏读取公开 JSON，表格搜索、排序、合计、作者视图和导出都在浏览器完成；统计详情按需读取快照或构建目录中的 JSON。

## 导出静态离线包

接口不可用时，可以把公开快照和完整静态页面一次性打包：

```bash
npm run package:static
```

默认从线上公开 JSON 读取，生成 `output/tapmoney-static-YYYY-MM-DD/`。如果已经核对本地快照与线上文件一致，可使用：

```bash
npm run package:static -- --local
```

输出目录本身就是静态站点根目录，`backup/ranking.json` 保存打包快照，`backup/tapmoney.sql` 和 `backup/tapmoney.sqlite` 是便携式备份，`backup/MANIFEST.json` 记录来源和 SHA-256。`--board hot` 可只打包热门榜并把它改为首页 `/`。

## 数据与导出

- 收益来自 TapTap 广告收益报表，人民币金额使用报表合计与真实日报，不擅自乘除 100。
- 北京时间，昨日 / 累计截至昨日，本月从 1 日起；缺失日报不补零或插值。
- 点击昨日、本月、累计列头排序，三列同时显示可计算的增长率；曲线支持每日 / 累计、30 天 / 90 天 / 全部。
- 作者榜只汇总当前榜已收录作品的广告收益，不代表作者实际分成；合作作品分别计入各作者。
- 游戏 / 作者统计卡和榜单 PNG 由浏览器 Canvas 本地生成，CSV 和素材 ZIP 也不上传服务器。
- TapSulor 的日活与曝光接口目前返回 403，项目不会把失败结果伪造为真实零值。

```bash
npm test
npm run build
npm run preview -- --built
```

MIT。第三方图标版权见 `site/THIRD-PARTY-NOTICES.txt`；公开游戏资料与素材不属于本项目代码许可证。
