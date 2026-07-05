# Codex Radio

本地个人 AI 电台原型：支持 Codex DJ 对话、今日电台计划、本地曲库、手动音频导入，以及直接连接你的网易云音乐账号。

## 启动

```bash
npm start
```

打开 `http://localhost:8080`。

启动 Codex Radio 时会自动带起内置的 `NeteaseCloudMusicApi`。你不需要再单独开一个网易云 API 服务。

## 连接网易云账号

进入 **曲库** 页：

1. 点击 **扫码登录**。
2. 用网易云音乐 App 扫码确认。
3. 点击 **读取歌单**。
4. 选择你的歌单，再点歌曲右侧的 **播放**。

扫码登录后，本地会保存网易云 cookie 到 `data/netease-session.json`。这个文件已加入忽略列表，不会显示在界面里。

实际播放取决于网易云歌曲版权和你的账号可播放权限；不可播放时会保持静音并提示原因。

## 手动导入

曲库页的 **手动添加** 可以选择本地音频文件，或填写一个音频链接。只有手动导入的本地音频、或网易云账号里能拿到播放链接的歌曲，才会真正发声；示例歌曲不会发出合成音。

## 可选配置

如果你想使用自己已经运行的 `NeteaseCloudMusicApi`，可以指定地址：

```powershell
$env:NETEASE_API_BASE="http://localhost:3000"
npm start
```
