# 按动作就绪与恢复事实

这是当前源码的工程记录，接口以 [domain](../../server/domain.mjs)、[experience](../../server/experience.mjs) 和 [HTTP出口](../../server/index.mjs) 为准。计划第7节的建议字段没有被当作一套新增接口照抄。

章节返回的声音单元含 `readiness.generate/play/export`；每项有 `allowed`、`blockers` 和 `warnings`，问题带 `code/scope/resolution`，scope对应实际 `unitId/memberIds/mode`。顶部、筛选与问题卡读取同一实际单元范围，组仍按一次请求计算。

|事实|新生成|已有音频试听|正式导出|
|---|---|---|---|
|停用参考、已有匹配原音频完整|改参考或阻断|允许|其余资格满足时允许|
|有关目标存在unknown|下一次请求需对应明确决定|允许并标实际音频|按选版与听评判断|
|matched且rework|进入明确重做计划|允许复听|阻断|
|决定记录与当前实际值不符|阻断并定位|原历史可查看|阻断|
|仅缺派生母版，原件与完整配方存在|不付费补录|本地重建|本地重建|
|当前提示超限、合法旧声音存在|阻断当前生成|原文件可听|候选恢复匹配后再按正式条件判断|

`POST /api/operations/plan` 为只读计划，返回 `actionKind`、实际 `units/unitIds/memberIds`、`rejectedUnits`、去重的 `outstandingAttemptIds`、`textRequests/audioRequests` 和章节/编排版本。支持 `fillMissing/updateSelected/redoRejected/forceRegenerate`；计划不增加授权。worker在入队和最终发送事务复核实际未决集合、停止及授权。

持久 `operationId` 解决同一次动作是否执行，播放/导航意图解决迟到返回是否仍需展示，内容/编排/编译版本解决制作依据是否匹配。三者分别使用。unknown决定记录实际目标、mode和下一次已发送命令；排队后停止不消耗决定，单一拆分子项不替兄弟消耗。

通用 HTTP错误及持久动作回执带 `code/scope/retryClass`。409重新核对，403核对权限，503等待服务；连接丢失、不可读回执或500先查原操作，不能据此自动重发模型请求。已有成功音频、unknown事实和可能费用账本保持独立。

证据为 [core230项](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)、[unknown9项](../../data/ux-hardening-20261003/automation/core-unknown-final.log)、[实际HTTP/客户端4项](../../data/ux-hardening-20261003/error-metadata-regression.log)及 [前端回调](../../data/ux-hardening-20261003/frontend-regression.log)。完整浏览器与最终全量范围另列，不能由这些计数代签。
