# 历史恢复与原生模板决定

既有 `scene-v1/v2/v3-native` 实现保留；新意图使用不可变 `scene-v4-presence-1`。`native3-frozen-cd` 与 `native3-paragraph-k` 仅在保存的 input 与 prompt能由对应实现逐字重现时分类，不按日期猜。真实D仍是原unknown；419代码点提示精确分类不是把D修成成功产物。

原 `audio.input/prompt` 不改。精确分类另记 `resolvedCompilerId/migrationProvenance`，待恢复单元选择相应 compiler。未知实现仅保留历史试听与原因，不开放原prompt裸执行。

恢复顺序为读取归属和受保护身份、从历史构造候选、验证候选提示/模型/参考/配置、预览影响、复核版本、事务写入、检查实际 matched/current。当前将被替换的坏指导超限不挡合法历史候选；正文、参考、成员或文件真的不匹配仍拒绝。

`POST /api/enhancement-preview` 的 restore返回 `candidateInput`、`resolvedCompilerId/targetCompilerIdentity`、`changedAdoptedEvents`、`preservedDraftIds`、`conflicts/blockers`、`baseRevisions`、`resultWouldMatch`及差异。执行 `unit.restore` 重新构造同一计划，复核预览范围；持久后置条件失败整笔回滚。

仅替换参与生成的采用事件，保留未采用draft；ID/来源冲突拒绝而不覆盖无关草稿。并发新增draft不被旧预览授权。恢复前指导、采用集合与模板保存在 `restoreProvenance.before`，原声音及返工/听评事实保留。

新模板的 `variants.scene.backgroundPresence` 为 `clear/natural/subtle/unspecified`。未设置时保持原v3提示；设置时仅替换presence块，正文、参考、事件和其范围不变。它是模型意图，不是Seed新顶层数值参数或本地混音旋钮；当前默认不全局切换v4。

描述上限为1500 Unicode代码点，完整提示3000；AI、编辑、采用和编译共用合同，不截断。可选音乐转折使用 `memberId/quote/occurrence/development/volumeChange`，核对真实引文及出现序号；音乐发展与音量变化分开，不按字数编造秒数。只聚合明确配置冲突，不扫描朗读正文猜禁用背景。

证据见 [native/history77项](../../data/ux-hardening-20261003/automation/native-history-final.log)、[AI与候选worker51项](../../data/ux-hardening-20261003/automation/enhancement-worker-final.log)、[Unicode边界](../../data/ux-hardening-20261003/automation/unicode-contract-check.json)。K首对实际输出见私有 [ledger](../../data/ux-hardening-20261003/k-presence/live/ledger.json)；正文、音色、首中尾背景及转折仍需用户听评。

回退必须保留对应编译器和schema3写入能力。真实库结构决定修复只可按有父证据的预览scope执行；核心修复者的只读检查报告可修目标为0，未写生产库；这不是本文件作者独立运行真库修复。
