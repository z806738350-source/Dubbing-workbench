# a291 基线与资料边界

整改基线为 `a291fe3e4ec220d6300ff7f36a935901002d2ce5`，分支为 `codex/ux-redesign-v1-1`。原基线源码保存在 Git 与本机隔离目录；[baseline.json](baseline.json) 记录计划指定的12份 Git blob、备份 schema 和材料来源。本记录用于追溯，不增加运行时门槛。

本次逐项读取 Git 中的12份 blob，均与 v2.0 附录一致。原外部两个审核 ZIP、38项测试原 fixture 和13红灯完整原件本地未找到；新增探针不冒称等价重跑该38项。

[完整真实资料副本](../../data/ux-hardening-20261003/real-workspace-backup/backup-info.json)由既有备份程序创建，程序校验来源和副本数据库及被引用文件后才报告成功，[原日志](../../data/ux-hardening-20261003/backup.log)保留。只读查询该副本的 `data-schema` 为2；整改程序使用 schema3及相应写入能力。真实副本不用于故障注入，不纳入发行包。

新增回归、故障注入和性能测试使用临时 SQLite、合成素材及 Mock。实际本机 HTTP、FFmpeg 和前端 Node/AST 各按原日志范围记录，不能代替浏览器、听评或干净Mac安装。[自动化归档说明](../../data/ux-hardening-20261003/automation/README.md)明确区分业务红灯、夹具/环境错误、过渡结果和最终绿灯。

当前用户另行授权后，主任务通过正常 worker 完成 K0/K1 首对各一次真实联合生成；本计划原先的0调用边界已由当前授权更新。首对共2次，供应商返回和原件均入私有账本；用户听评仍为 pending，不自动跑满建议次数。G/J/旧K、真实D unknown及本次首对分别记录。

本机私有正文、参考、音频、完整请求和完整数据库仍留在 `data/`；工程交接只引用摘要与路径。最终提交、全量回归、包与扫描状态见 [release-status.md](release-status.md)，全部任务和验收见 [regression-map.md](regression-map.md)。
