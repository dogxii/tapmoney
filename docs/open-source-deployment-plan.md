# 开源部署与代码检查

2026-10-14，按讨论方案实施。主架构为 Pages Git 集成 + GitHub Actions + 公开 JSON，jsDelivr 为可选镜像。

## 本次检查与简化

- 合并重复的 Wrangler 子进程封装；部署、数据库初始化共用 scripts/cloud.mjs。统一禁止自动读取 dotenv，并移除子进程中的 TapTap / 管理凭证。
- 配置来源改为明确的 repository / cloud，不再根据是否存在管理 Token 自动切换。
- 默认网页直接读同源静态 JSON，移除先请求不存在的 API 再回退的路径；仅云模式使用 API 与快照回退。
- 配置校验不再从服务器实现导入，采集脚本与 Pages API 共用 shared/，依赖没有循环。
- Pages Functions 只处理 /api/*；默认静态构建不编译服务器、不发布管理脚本。保留一个 API 实现，不复制 Worker / Pages 两套逻辑。
- 管理 API 直接用 esbuild 打包为 Pages 高级模式 _worker.js，移除 Functions 路由包装与二次 Wrangler 编译产生的 Node 兼容依赖。
- 账号专用 Worker / D1 部署配置移出源码；运行时只生成公开 URL 与管理是否启用，不嵌入凭证。
- 新增 Actions 凭证配置命令；使用标准输入写入 Secrets。Pages Git 集成自动发布，不在 Actions 里另放 Cloudflare 部署 Token。
- 收益的昨日、本月、累计区间查询保留：接口合计与稀疏日报不能在未证实完整时相互替代，不为减少请求而改变金额口径。

## 两种模式

| 模式 | 配置来源 | 数据展示 | 后端 |
| --- | --- | --- | --- |
| repository（默认） | config/ | 同源公开 JSON | 无 |
| cloud（可选） | D1，config/ 为备份 | 同源 API + 静态镜像 | Pages Functions + D1 |

当前站点保留现有在线管理、Token 和 D1 配置；fork 后默认使用仓库模式，Secrets 和绑定不随 fork 复制。

每日 workflow 的 schedule 为 UTC 02:30，即北京时间 10:30，另有手动运行入口。先成功采集，再提交公开数据，由 Pages Git 集成自动构建。定时任务可能延迟，Cookie 过期后需要本地重新登录并更新 Secrets。

## JSON 镜像

主站优先同源数据。固定 commit 的 jsDelivr URL 明确版本；@main 有缓存延迟，不保证每日实时更新。设置 TAPMONEY_DATA_URL 可使用公开 HTTPS 镜像，不能与在线管理模式同时启用。

## 登录

npm run login 自动保存本地 Cookie / 工作室 ID，不打印值；npm run setup:github -- 用户名/仓库名 将采集所需变量写入目标仓库 Secrets。开源只发布 .env.example，不发布真实环境文件、浏览器 profile、Token 或运行日志。

源码：https://github.com/dogxii/tapmoney

首次安装、Pages Git 构建参数、在线管理与数据库绑定操作见 README.md。
