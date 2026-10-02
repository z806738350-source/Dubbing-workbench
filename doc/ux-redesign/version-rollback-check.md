# 隔离旧资料版本回退读取验收

2026-10-02。对应 RG08 / U4-04 的最小版本回退读取检查；不替代新体验状态的旧版制作兼容承诺，也不替代全新 macOS 依赖安装验收。

## 实际版本与隔离资料

旧版本从 Git `4e40f329807936918fbc00f9844ec8bfc6f3f1b5` 重建，再应用 `baseline/pre-existing.patch`，完整覆回 `baseline/local-files` 中保存的 21 份真实本机文件并逐文件比较一致。这保留了当时的目录、一键启动及后台保护补丁，没有把纯远端版本冒充旧本机版本。源码与构建均位于独立临时目录，复用现有 node_modules 符号链接，`npm run build` 通过，未安装新依赖。

通过既有 `scripts/backup.mjs restore` 将 `baseline/workspace-backup` 恢复到新的临时资料目录。没有开启、复制或恢复原 4318 正在使用的目录。恢复后，SQLite 完整记录、主键、父级和结构与基线一致；24 份重要素材的相对路径、大小及内容一致。

新版使用最终体验 ZIP 的解压代码，全部 server 文件与当前源码逐字节一致。两版依次使用同一个临时恢复目录及 `127.0.0.1:4323`，前版关闭后再启动后版；原 4318 服务保持运行，没有请求其 API。

## 检查结果

| 阶段 | 实际结果 |
| --- | --- |
| 旧版构建 | 通过；产物 `index-CG5mK_Nf.js` / `index-JP5JFFOv.css` |
| 备份恢复 | 既有 restore 成功；恢复目录不存在时才写入 |
| 禁止覆盖 | 再次向同一已存在目录恢复，明确拒绝“目标目录已存在”，数据不变 |
| 旧版读取 | 首页和引用资源 HTTP 200；工作区 3 项目、5 章；5 个章节 API 全部读取成功 |
| 旧版关闭后 | 全部业务记录差异 0、结构一致、完整性 ok；24 文件不变，运行标记清理 |
| 新版读取 | 同一恢复目录：首页与资源 HTTP 200、3 项目、5 章，5 章 API 读取成功 |
| 新版关闭后 | 对恢复前基线全部业务记录差异 0、结构一致、完整性 ok；24 文件不变，运行标记清理 |

往返保留 5 角色、313 片段、313 single、6 音色、10 音频、11 任务、10 请求记录、4 母版、4 导出、6 旧建议及 4 条 settings。原文、角色 / 声音引用、旧来源和模板包含在完整 JSON 比较中。24 个重要文件合计 20,957,036 字节，未替换原音频或修改路径。

两版均确认只绑定本机 `127.0.0.1`、无 key；子进程仅继承运行工具路径等必要环境，独立目录不带 `.env*`。模型接口明确指向不可用的本机地址，并禁止子进程 fetch；实际模型 / 外部 fetch 数为 0，未发付费请求。仅使用只读 HTTP GET，不调用保存、生成、采用或清理接口。两个服务最终都通过 `app.close()` 退出 0，测试 4323 服务已关闭。

## 证据和范围

- `data/ux-redesign-20261002/version-rollback-check.json`：旧版本来源、21 文件、临时位置、两版入口与 5 章 ID、计数、逐记录差异和 24 素材比较。
- `automation/version-rollback-check.log`：实际汇总。
- `automation/version-rollback-build.log`、`version-rollback-restore.log`、`version-rollback-refused-overwrite.log`：旧版构建、恢复和拒绝覆盖。
- `automation/version-rollback-old-service.log` / `version-rollback-new-service.log`：两个本机启动与安全退出记录，均为 `blockedFetches=0`。
- 执行脚本：`data/ux-redesign-20261002/version-rollback-check.py`。

这是**真实旧基线数据在隔离目录中的旧版读取 → 新版读取**验证。未创建带新授权、自动采用来源、操作回执等 experience 状态的数据，再交给旧版制作；不能据此宣称旧 UI 可以安全制作所有新版状态。本次以 API 及静态入口检查为准，没有做旧版浏览器操作或旧 / 新版付费制作。现有 Node / FFmpeg 和依赖均复用，全新 macOS 的安装与首次配置仍待验证。
