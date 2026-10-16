# 开源部署方案

TapMoney 使用纯静态发布：`config/boards.json` 和 `site/data/ranking.json` 进入 Git，GitHub Actions 手动采集并提交公开快照，静态主机在提交后运行 `npm run build` 并发布 `dist`。

页面默认从 jsDelivr 读取：

```text
https://cdn.jsdelivr.net/gh/dogxii/tapmoney@main/site/data/ranking.json
```

也可以在构建环境设置 `TAPMONEY_DATA_URL` 使用固定 commit 或其他公开 HTTPS 镜像。页面不包含服务器代码、管理入口、D1、数据库绑定或管理 Token。访客不需要登录；只有本地采集和 GitHub Actions 使用 TapTap 开发者 Cookie。

Actions 只需要两个 Secrets：`TAPTAP_COOKIE` 和 `TAPTAP_DEVELOPER_ID`。采集失败、登录过期或触发限流时不会覆盖上一份公开快照。静态文件和公开 JSON 可以部署到 Cloudflare Pages、GitHub Pages、Nginx 或其他静态托管，不依赖某个云厂商的运行时。
