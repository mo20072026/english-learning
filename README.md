# 英语学习工作台

**在线使用：https://mo20072026.github.io/english-learning/**

一个**纯静态**的英语学习页面：单词库、情景对话、随机复习、英文朗读。
没有后端、没有账号体系、不加载任何云服务 SDK，断网也能用。

## 目录结构

```
index.html    页面骨架（无外部依赖，只有一个自绘 favicon）
style.css     样式
app.js        全部逻辑：筛选、复习、朗读、进度、Gist 同步
data.js       词条数据（16487 条，构建时烘焙成 JS，约 4 MB）
.nojekyll     告诉 GitHub Pages 不要走 Jekyll 处理
```

## 本地打开

- 直接双击 `index.html` 即可（`data.js` 是同目录相对引用，`file://` 下可用）。
- 或者起一个本地服务：

```bash
python -m http.server 8000
# 然后访问 http://localhost:8000
```

## 发布到 GitHub Pages（约 2 分钟）

### 方式 A：网页上传（不需要任何命令，最安全）

1. 在 GitHub 新建一个仓库，例如 `english-workspace`，**Public**。
   （Private 仓库要开 Pages 需要付费计划，静态站建议直接用 Public。）
2. 打开仓库 → **Add file → Upload files**，把 `index.html`、`style.css`、`app.js`、`data.js`、`.nojekyll` 拖进去，Commit。
3. 进入仓库 **Settings → Pages**：
   - Source 选 **Deploy from a branch**
   - Branch 选 **main**，目录选 **/ (root)**，Save。
4. 等 1 分钟左右，访问：

```
https://<你的用户名>.github.io/english-workspace/
```

### 方式 B：一条命令推送

```powershell
powershell -ExecutionPolicy Bypass -File publish.ps1 -Repo https://github.com/<你的用户名>/english-workspace.git
```

认证由本机 Git Credential Manager 弹窗完成——每次推送都会弹窗让你确认，脚本本身不接收、不保存任何密码或 Token。
推送成功后再按上面第 3 步开一次 Pages 即可。

> 注意：GitHub 自 2021 年 8 月起**不再支持用账号密码做 git 认证**，只能用浏览器授权、Personal Access Token 或 SSH key。

### 绑定自己的域名（可选）

1. 仓库 **Settings → Pages → Custom domain** 填 `en.example.com`，Save。
2. 在你的域名 DNS 里加一条记录：类型 `CNAME`，名称 `en`，值 `<你的用户名>.github.io`。
3. 仓库根目录会多出一个 `CNAME` 文件，保留它即可。
4. 勾选 **Enforce HTTPS**（证书通常几分钟内签发）。

## 学习进度怎么存

| 方式 | 说明 |
| --- | --- |
| 默认 | 存本机浏览器 `localStorage`，换浏览器/清缓存会丢 |
| 导出/导入 | 设置页可导出 `english-progress.json`，在另一台设备导入 |
| GitHub Gist 同步 | 设置页填 Personal Access Token（只需 `gist` 权限），进度写进你账号下的**私有 Gist**。开启「自动同步」后每次打开页面自动拉取合并、标记后自动回传；换设备把 Gist 地址（或 ID）粘贴到「Gist ID」输入框即可接着学 |

Token 只保存在本机浏览器，不上传任何服务器；请求直接发往 `api.github.com`。

### 多设备/多端口怎么保持一致

进度按「浏览器源」（协议+主机+端口）隔离，所以换端口、换地址、换设备都各存一份。
开启 Gist 同步后：

- **打开页面**：自动拉取云端进度并与本地按单条时间戳合并，新者胜；
- **标记单词**：约 2.5 秒后回传，回传前会再拉一次云端合并，**不会覆盖另一台设备**；
- **两端一致**：不产生多余写入；
- **清空进度**：会记录一个 `resetAt` 时间戳，云端更早的旧标记不会被同步回来。

## 更新词条

`data.js` 里是一个 `window.EN_DATA` 对象：

```js
window.EN_DATA = {
  v: 1,
  cats: { "电气专业词汇": ["A", "B", ...] },   // 分类 → 子类
  items: [
    { i: "唯一id", t: "标题", sc: "场景", k: "单词", c: "分类", s: "子类",
      en: "英文", cn: "中文", n: "备注", lv: "未学", d: "2026-10-02" }
  ]
}
```

改完直接提交，Pages 会自动重新构建。

## 已知边界

- 朗读改为使用有道在线语音接口（`dict.youdao.com/dictvoice`）。若环境无法播放音频（如某些 App 内置浏览器限制自动播放/外网资源），朗读按钮会自动隐藏，不会报错。
- 页面一次性加载全部词条（约 4 MB，gzip 后约 1 MB），首屏会先出框架再铺数据。
