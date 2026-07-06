# Codex Radio 上线说明

## 发布到 Vercel

1. 登录 Vercel。
2. 在项目目录执行：

```powershell
npx vercel --prod
```

如果 CLI 在中文路径下登录失败，建议用 Vercel 网页控制台导入 GitHub 仓库，或把项目放到纯英文路径后再执行 CLI。

## 绑定自定义域名

1. 先购买并拥有要绑定的域名。
2. 在 Vercel 项目的 Domains 页面添加你自己的域名。
3. 到域名服务商后台按 Vercel 给出的提示添加 DNS。
4. `www` 子域通常使用 CNAME 指向 `cname.vercel-dns.com`，以 Vercel 页面显示为准。

## 搜索引擎收录

项目已经包含：

- `/robots.txt`
- `/sitemap.xml`
- 首页 SEO meta 标签
- `/profile`、`/library`、`/settings` 静态入口

现在可以先分别到 Google Search Console、Bing Webmaster Tools、百度搜索资源平台提交 `https://git-yinbokang3-droids-projects.vercel.app/sitemap.xml`。如果之后绑定了自定义域名，再把 sitemap 和 canonical URL 改成新域名。

## 线上运行限制

Vercel 是无状态运行环境。项目已做只读保护，但本地上传音频、长期保存网易云登录 Cookie、跨设备共享服务端歌单状态，最好接外部数据库或长期运行的后端服务。

为了保护账号安全，`data/netease-session.json` 已被排除在 Vercel 部署包之外，不要把网易云 Cookie 上传到公网项目。
