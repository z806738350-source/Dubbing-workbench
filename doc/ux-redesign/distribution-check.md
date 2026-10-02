# macOS 内部试用分发检查

日期：2026-10-02。范围为本机 macOS 内部试用包；未公开上线，未向他人发送。此检查不构成 Windows / Linux 交付或真实模型效果验收。

## 交付物

- `data/ux-redesign-20261002/distribution/配音工作台-体验升级-macOS.zip`，980,272 字节（桌面台词返回编辑及旧 single/dry 听评兼容补修后重建）。此前 980,225 字节为补修前阶段包，已替换。
- 独立入口：`scripts/start-release.mjs`。原 `scripts/launch.mjs` 的开发启动语义未改。
- 包内：已构建的 `dist/`、Node 内置模块实现的 `server/`、独立启动脚本、可双击的 `启动体验版.command`、最简 README、四步入门与升级说明、无安装依赖的 package 元数据、前端组件及字体许可证。共 63 个文件；教程位于 `doc/quick-start.md` 与 `doc/release-notes.md`。
- 包内不含 `.env*`、用户库、保存位置配置、运行 PID 记录、备份、参考录音、用户音频和 `node_modules`。唯一音频为获准保留的自拟免费演示，位于 `dist/demo.mp3`。

Node.js 22.13 或更新版本、FFmpeg 与 FFprobe **未打包**。README 和启动失败提示明确说明这些前置条件。启动直接使用已有 `dist/`，不运行 npm 安装或构建。音频工具复用现有 `toolsAvailable`，支持 PATH、`~/.local/bin` 及已有可执行文件路径配置；没有安装新依赖。

## 实际验证

在本机 `darwin / arm64 / Node 22.13.0` 解压到独立临时目录，用随机本机端口启动。清除子进程继承的供应商配置和 DATA_DIR / PORT / 音频工具覆盖值，未替换或改写系统 HOME。所有新资料、保存位置配置和迁移目标均在该隔离目录内，未接入原 4318 服务或原用户库；无供应商请求、无 API 费用。

| 检查 | 结果与证据 |
| --- | --- |
| 分发白名单 | 63 文件；无符号链接、凭据文件、用户库、运行标记或 node_modules；双击入口可执行 |
| 最终构建与源码一致 | 先执行 `npm run build`；包内 59 个界面、后端、启动脚本与两份使用文档逐文件字节比较一致；`.command` zsh 语法通过 |
| 直接启动与免费演示 | 无 node_modules 直接启动；`configured=false`、音频工具可用；首页及引用资源 HTTP 200 |
| 演示音频 | `/demo.mp3` 返回音频 MIME、67,532 字节，与包内文件一致；FFprobe 识别音轨，时长 16.824 秒 |
| 默认保存位置 | 初始位置为解压文件夹的 `data/`；自拟项目、章节和实际 SQLite 文件存在 |
| 重复启动 | 同一工作区第二次启动复用原 PID 和端口，不替换运行记录 |
| 保存位置迁移 | 独立空目录迁移成功；原资料保留；新位置启用同名项目文件夹、`.project-id` 与实际项目一致；运行标记移交 |
| 安全停止 | SIGTERM 等待 `app.close()` 完成并退出 0；新位置运行标记清理，数据库保留 |
| 配置续用 | 解压目录的 `.workspace-local.json` 指向独立保存位置并生效 |
| 环境覆盖 | DATA_DIR 优先于保存位置配置，指向指定独立目录 |
| 旧运行记录 | 已退出的旧 PID 记录可安全重新启动，原自拟项目仍在 |
| 缺音频工具 | 指定不存在的 FFmpeg / FFprobe 时清楚报错、退出 1，不创建工作区 |
| Node 版本不足 | 在真实 Node 22.13 子进程中模拟版本属性 22.12，最低版本守卫拒绝启动并给出升级提示 |
| 端口错误 | PORT=0 明确拒绝；其他服务占用端口时明确提示并清理本次运行标记 |

最终 **14 项自动检查通过**（此前 13 项加最终包逐文件一致性检查）；Node 脚本语法检查和包内 `.command` 的 zsh 语法检查通过。最新界面产物为 `index-BmGzuum8.js` 与 `index-BGGeuOzc.css`；构建日志为 `data/ux-redesign-20261002/automation/build-final-distribution.log`。本次构建包含点击台词回到编辑，以及复用原 reviewBasis 的旧 single/dry 已听评资格兼容补修；后端负责人已完成 293 项回归，本包在此补修完成后重建、解压及复验。浏览器播放由主执行者另行完成（如下），HTTP 读取、音频解码与播放器验证均不能替代模型样本听评。原环境已具备 Node 和音频工具，本检查没有验证全新 macOS 的依赖安装过程。

补修后的 ZIP 另行解压到干净目录，以 `gitleaks dir --redact=100` 复扫：退出 0、发现 0；63 文件、无符号链接和禁止路径。包内 59 份界面、后端、启动与教程文件再次和当前工作区字节比较一致，演示 MP3 经 FFmpeg 全量解码退出 0。当前脱敏安全报告为 `automation/credentials-release-final.log` / `.json`，明确记录补修阶段、时间与 980,272 字节实物；此前同名报告另存为 `credentials-release-before-legacy-fix.log` / `.json`，不能用于证明本次最新包。扫描未读取原用户库、原环境文件或 key，未发供应商请求。

完整证据：`data/ux-redesign-20261002/distribution/verification.json`、`verification.log`。临时解压位置记录于 JSON。首次两轮验证夹具分别发现 macOS `/var` 与 `/private/var` 别名差异，以及错误假定默认旧存储已启用同名项目目录；修正为真实路径比较、通过既有迁移接口验证同名目录，保留 `verification-first.log` 与 `verification-second.log`，未修改产品保护或放宽业务断言。

另从最后两处补修前的解压包启动 `http://127.0.0.1:4322/`，指定独立的 `browser/free-demo-workspace`，供主执行者用浏览器验收免费演示。演示音频和无密钥启动路径未在这两处补修改动，最终包又做了文件一致性及启动解码检查。子进程仅继承本机 PATH / HOME / TMPDIR 和明确的端口、保存位置，不读取原项目的环境文件或供应商 key；只读状态确认 `configured=false`、项目 0、章 0、音频工具可用。入口及状态保存在 `free-demo-service.json`、`free-demo-state.json`。该服务未进入原4318用户库，验收完成后安全停止。

主执行者已用 CUA 实际点击免费演示：无key的空工作区中，音频源为 `/demo.mp3`，播放器 `paused=false`、浏览器读取时长16.775秒；截图 `data/ux-redesign-20261002/visual/free-demo-final-1280.jpg`。此记录证明免费演示播放器路径可用，不将本机语音演示算作真实模型效果或用户听评通过。

## 重打包与复验

分发包来自打包时的实际 `dist/` 与 `server/`。前端重新构建或后端后续修改后，应先重打包，再运行同一隔离验证；不会自动将后续源码变化写入既有 ZIP。

```sh
node data/ux-redesign-20261002/distribution/package-release.mjs
node data/ux-redesign-20261002/distribution/verify-release.mjs
```

验证只创建独立临时资料并在完成后关闭服务，不发送分发包、不写入原用户工作区。收件人需要本机已有 Node 22.13+ 和 FFmpeg / FFprobe；实际模型使用仍需自行配置接口并按界面授权费用。
