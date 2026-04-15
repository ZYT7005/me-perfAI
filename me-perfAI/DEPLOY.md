# 部署到公网（GitHub + 云平台）

本项目是 **Node.js + Express** 应用（`/api/analyze` 等接口），**不能**只靠 GitHub Pages 托管静态文件来运行完整功能。推荐把代码放在 **GitHub**，再用下面任一平台部署 **Web 服务**。

## 1. 准备仓库

```bash
git init
git add .
git commit -m "Initial commit"
```

在 GitHub 新建仓库后：

```bash
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git branch -M main
git push -u origin main
```

勿将 `.env` 提交进仓库（已在 `.gitignore` 中忽略）。

## 2. 环境变量

在部署平台控制台配置：

| 变量 | 说明 |
|------|------|
| `PAGE_SPEED_API_KEY` | [Google PageSpeed Insights API](https://developers.google.com/speed/docs/insights/v5/get-started?hl=zh-cn) 密钥；静态扫描模式可不填，但线上 PSI 需要 |
| `PORT` | 多数平台会自动注入，一般无需手动设置 |
| `PSI_FETCH_TIMEOUT_MS` | 可选，单次 PSI 等待毫秒数（默认在 2～5 分钟区间内） |

本地可复制 `.env.example`（若存在）为 `.env` 自测。

## 3. Render（示例）

1. 登录 [Render](https://render.com)，**New → Web Service**，连接你的 GitHub 仓库。  
2. **Runtime**: Node；**Build Command**: `npm install`；**Start Command**: `npm start`。  
3. 在 **Environment** 里添加 `PAGE_SPEED_API_KEY`。  
4. 部署完成后使用 Render 提供的 `https://xxx.onrender.com` 访问。

仓库根目录的 `render.yaml` 可作为 Blueprint 参考（需在控制台关联并填写密钥）。

## 4. Railway / Fly.io / 其他

- **Railway**: New Project → Deploy from GitHub → 选仓库，Start 命令 `npm start`，同样配置环境变量。  
- **Fly.io**: `fly launch` 后配置 `Dockerfile` 或使用 Node 官方镜像，暴露 `PORT`。  

核心都是：**Node 18+**、安装依赖、`npm start`、配置 `PAGE_SPEED_API_KEY`。

## 5. 自定义域名

在对应平台的 **Custom Domain** 里绑定你的域名，并按提示配置 DNS（CNAME 或 A 记录）。

## 6. 分析历史说明

前端「分析历史」使用浏览器 **localStorage**，仅保存在访客自己设备上，**不会**同步到服务器或其他电脑。公网部署后行为相同。

## 7. 常见问题

- **冷启动慢**：免费套餐实例休眠后首次访问会较慢，属正常现象。  
- **API 配额**：PageSpeed API 有每日配额，超限需在 Google Cloud 控制台查看或申请提额。  
- **HTTPS**：公网站点需 HTTPS，上述平台默认提供。
