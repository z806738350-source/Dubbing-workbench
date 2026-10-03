# v2.0 任务与验收证据映射

记录时间：2026-10-03T10:44:37.272296+00:00。方案：[完整 v2.0 执行计划](../../doc/配音工作台-a291fe3全链路复审与原生背景整改执行计划-v2.0-2026-10-03.md)。

基线 HEAD：`a291fe3e4ec220d6300ff7f36a935901002d2ce5`；整改处于未提交工作树，本表不宣称存在固定最终实现 SHA。逐项机器数据见 [regression-map.json](regression-map.json)。

本表使用“已实现并验证 / 已实现未验证 / 缺失 / 偏离 / 按计划延期”。已验严格限于列明层级；外部签收延期只是计划后置阶段仍待完成，不能解释为已接受效果或已交付。部分项的未测组合继续列出。

原外部 38 项测试 ZIP 本地未找到，因此原 13 红灯完整重放仍缺失。新增 a291 合同回放 16 子项中 14 失败仅证明该组新增探针，不替代原 38 项。跨流程 27 失败包含缺新函数与调试/环境错误，不按 27 个业务缺陷结算。

补后完整工作树回归534/534与build通过；当前范围 final：native/history 77/77、candidate Mock worker 51/51、core 六套 230/230、unknown 范围 9/9、前端 Node/AST 140/140；这些 suite 有重叠，不能相加当独立验收数量。真实 K 首对收到 89.8s/81.68s 原始 WAV 和正常母版，`humanListening=pending`；真实 D 419 字符仍是 unknown，只做精确分类，不伪造旧成功。

## 29 个任务

|任务|状态|已观察到的实现/证据范围|对应验收|
|---|---|---|---|
|T00 固定a291与材料账本|缺失|真实资料副本与新增红灯归档完成；外部38项附件未找到。|A01, A02, A03|
|T01 未决请求资格|已实现并验证|范围内unknown账本、一次决定、最终发送事务及历史本地使用工程已验。|A04, A05, A06, A07, A08, A09, A31, B24|
|T02 导入命令幂等|已实现未验证|持久幂等/导航分离有Node实测；切项目真实浏览器组合待验。|A10, A11, A12, A13, A14, A15|
|T03 结构编辑决定转换|已实现并验证|新结构决定转换及有父证据旧对象scope绑定事务修复/快照已隔离验证；真库未应用。|A16, A17, A18, A19, A20, A21, A34|
|T04 播放意图控制|已实现未验证|Node回调修复已验；实际媒体Promise及完整迟到浏览器组合待验。|A22, A23, A24, A25, A26, A27|
|T05 候选内容与列表解耦|已实现并验证|内容修订与列表取舍分離，排队/在途真实Mock验证。|A28, A29, A30, A31|
|T06 按动作统一就绪投影|已实现并验证|按动作投影与通用code/scope/retryClass错误合同已工程验证。|A32, A33, A34, A35, A36, A78, A79, A80, A81|
|T07 返工成为主任务|已实现并验证|句/组/scene否决重做计划及请求计数工程已验。|A37, A38, A39, A40|
|T08 统一输入合同|已实现并验证|统一1500 Unicode代码点和3000提示预算，AI/编辑/采用/编译验证。|A41, A42, A43, A44, B13, B14|
|T09 导入草稿和最后文件优先|已实现并验证|非空导入草稿和最后文件优先回调验证。|A45, A46, A47, A48|
|T10 其余异步/保存边界|已实现未验证|屏障/取消/迟到持久动作已验；真人IME和全路径浏览器组合未齐。|A49, A50, A51, A52, A53|
|T11 原生输入与存在感编译|已实现并验证|独立不可变presence模板及来源/差异快照已验。|A54, A55, A56, A57, B15, B16, B17, B18|
|T12 K原案例最小对照|已实现未验证|首对真实K0/K1已收2份产物；本次用户听评尚未提交。|A58, A59, A60, B19, B20, B21, B22, B23, B24|
|T13 缓存分级与本地修复|已实现并验证|完整配方派生母版免费重建、原件缺失准确诊断、历史清理保护已验。|A61, A62, A63, A64|
|T14 删除/迁移/WAL/磁盘专项|已实现未验证|删除scope、事务与文件回滚已验；低空间/权限/进程中断专项待验。|A65, A66, A67, A68, A69|
|T15 长期性能与启动健康|已实现未验证|实际300/1000章投影定位并修瓶颈；浏览器输入/轮询/全解码与p95未验。|A70, A71, A72, A73|
|T16 导出完成与结果发现|已实现并验证|成品卡/实际编排下载地址/关闭迟到回调及本地编码链已验。|A74, A75, A76, A77|
|T17 错误恢复和授权文案|已实现并验证|统一HTTP/持久操作回执code/scope/retryClass已真实HTTP和客户端验证，丢响应查原操作。|A78, A79, A80, A81|
|T18 视觉最后统一|已实现未验证|组件与标签工程检查通过；真实全状态宽度/键盘读屏/缩放签收待验。|A82, A83, A84, A85|
|T19 工作区身份与客户端缓存|已实现并验证|同路径备份身份/state出口/原稿找回与正式删除后的3份遗留稿隔离均工程已验；实体浏览器剪贴板未代签。|A86, A87, A88, A89, A90|
|T20 干净Mac首次使用|按计划延期|位置失联工程缺口已修且9/9通过；干净Mac安装签收仍后置，开发机启动不能代替。|A91, A92, A93, A94|
|T21 最小化日志与分享|已实现并验证|公开源/dist与实际ZIP范围扫描、最小诊断真实HTTP、坏runtime与正PID不匹配启动拒绝均已验。|A95, A96, A97, A98|
|T22 完整回归与浏览器|已实现未验证|补后最终全量534/534与build及修后实际包14/14已过；待本地commit版本关联，浏览器完整长尾与真人签收另列。|A99, A100, A101, A102|
|T23 真人/视觉/听评签收|按计划延期|计划产品签收阶段5新手+2熟手、声音/视觉/安装分别待验。|A103, A104, A105, A106|
|T24 不可变编译器与历史修复|已实现并验证|旧同ID精确识别、未知只读、candidate matched后置及schema旧writer保护已验。|B01, B02, B03, B04|
|T25 历史恢复草稿范围|已实现并验证|draft保留、采用集合恢复、并发新draft/ID及来源冲突范围已验。|B05, B06, B07, B08|
|T26 候选恢复与后置条件|已实现并验证|坏当前提示不阻合法candidate；严格身份和原子后置条件已验。|B09, B10, B11, B12|
|T27 声音意图冲突及引用转折|已实现并验证|发展/淡出分离，真实引文出现序号，明确冲突聚合，0新增文本/音频模式已验。|B15, B16, B17, B18|
|T28 证据、历史迁移与阶段核销|已实现未验证|29任务/130矩阵已逐项映射且红灯/最终分列；外部证据与最终签收仍未关闭。|A01—A106, B01—B24|

## 130 条验收

“待验”列保留未运行组合；原预期逐字保存在 JSON 的 expected 字段，方案不在本表改写。

|ID / 场景|状态|实际结果 / 验证层级|原始证据|仍待验证|
|---|---|---|---|---|
|A01 基线和真实库副本|已实现并验证|baseline.json已实际核对12份Git blob与a291附录一致，真实完整副本经既有create程序校验来源与目标，只读schema2对应；整改schema3另有写能力回归。|[baseline](../../doc/ux-hardening/baseline.json)<br>[backup](../../data/ux-hardening-20261003/real-workspace-backup/backup-info.json)|原外部两个审计ZIP仍缺失，原红灯重放缺口单列A03|
|A02 故障注入环境|已实现并验证|新增探针使用独立临时库和Mock；本轮真人/真实API实验与故障注入隔离。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[K-mock](../../data/ux-hardening-20261003/k-presence/mock/ledger.json)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A03 修前红灯|缺失|N/S新增合同14个红灯及两项存储红灯有原日志；F/N/S完整原38项重放仍缺附件，不以调试失败充数。|[red-native](../../data/ux-hardening-20261003/automation/native-history-red-a291.log)<br>[red-cross](../../data/ux-hardening-20261003/crossflow-before.log)<br>[red-storage](../../data/ux-hardening-20261003/storage-before.log)|原F01—F07 38项fixture/13红灯逐项等价重放|
|A04 unknown后选历史当前版|已实现并验证|unknown由持久attempt账本判断，决定绑定实际目标/mode/已发送命令；停止排队不消费，新unknown重验；旧返回只归正确历史。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[unknown](../../data/ux-hardening-20261003/automation/core-unknown-final.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A05 unknown后换dry/scene/restore|已实现并验证|unknown由持久attempt账本判断，决定绑定实际目标/mode/已发送命令；停止排队不消费，新unknown重验；旧返回只归正确历史。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[unknown](../../data/ux-hardening-20261003/automation/core-unknown-final.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A06 unknown明确重试一次|已实现并验证|unknown由持久attempt账本判断，决定绑定实际目标/mode/已发送命令；停止排队不消费，新unknown重验；旧返回只归正确历史。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[unknown](../../data/ux-hardening-20261003/automation/core-unknown-final.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A07 新操作ID/新页/重启|已实现并验证|unknown由持久attempt账本判断，决定绑定实际目标/mode/已发送命令；停止排队不消费，新unknown重验；旧返回只归正确历史。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[unknown](../../data/ux-hardening-20261003/automation/core-unknown-final.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A08 旧结果晚到|已实现并验证|unknown由持久attempt账本判断，决定绑定实际目标/mode/已发送命令；停止排队不消费，新unknown重验；旧返回只归正确历史。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[unknown](../../data/ux-hardening-20261003/automation/core-unknown-final.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A09 未决请求与本地播放导出|已实现并验证|实际本地导出在参考停用/unknown且匹配通过时完成，额外provider调用为0；生成仍需决定。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A10 导入响应丢失|已实现并验证|持久导入operationId回原章，同ID异载荷拒绝；显式新ID允许同文新章；客户端存储失败0发送、DB回执失败全回滚。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A11 同ID异载荷|已实现并验证|持久导入operationId回原章，同ID异载荷拒绝；显式新ID允许同文新章；客户端存储失败0发送、DB回执失败全回滚。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A12 同内容两个明确新导入|已实现并验证|持久导入operationId回原章，同ID异载荷拒绝；显式新ID允许同文新章；客户端存储失败0发送、DB回执失败全回滚。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A13 导入后导航失败|已实现并验证|组件真实回调夹具验证已创建但导航失败只恢复原导航，不重复POST。|[front](../../data/ux-hardening-20261003/frontend-regression.log)|实体浏览器路由失败另待验证|
|A14 导入等待切项目/关页|已实现未验证|等待关闭后保留原创建回执且不导航有AST实测；切项目过程中原返回ID不误导向新项目尚无实际浏览器记录。|[front](../../data/ux-hardening-20261003/frontend-regression.log)|导入在途切项目+新面板组合|
|A15 创建命令存储失败|已实现并验证|持久导入operationId回原章，同ID异载荷拒绝；显式新ID允许同文新章；客户端存储失败0发送、DB回执失败全回滚。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A16 同音色默认+覆盖合并|已实现并验证|结构转换重建最终实际决定/父操作来源，未确认不提权、双方保护并集；不同first/second方向及AI拆短覆盖。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A17 不同音色选first/second|已实现并验证|结构转换重建最终实际决定/父操作来源，未确认不提权、双方保护并集；不同first/second方向及AI拆短覆盖。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A18 一侧未确认合并|已实现并验证|结构转换重建最终实际决定/父操作来源，未确认不提权、双方保护并集；不同first/second方向及AI拆短覆盖。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A19 拆分不同表演/人工保护|已实现并验证|结构转换重建最终实际决定/父操作来源，未确认不提权、双方保护并集；不同first/second方向及AI拆短覆盖。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A20 新对象旧音频/听评|已实现并验证|结构转换重建最终实际决定/父操作来源，未确认不提权、双方保护并集；不同first/second方向及AI拆短覆盖。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A21 有证明/无证明的存量修复|已实现并验证|有父证据/无父证据dry-run与scope/revision/eligible事务应用均已测；保留before快照，只改structural决定；音频/input/review/编排不变，反向与回滚通过。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[repair](../../data/ux-hardening-20261003/automation/core-repair-apply-final.log)<br>[red-repair](../../data/ux-hardening-20261003/automation/core-repair-apply-red.log)|真实库仅dry-run，尚未执行真实对象修复|
|A22 点A后点B，A响应更晚|已实现并验证|实际浏览器旧章节预检被hold后点参考B，60秒释放迟到A，媒体来源仍为B直至正常播放结束；Node覆盖候选等其余来源。|[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[browser-reference](../../data/ux-hardening-20261003/browser/README.md)|实际候选/整章/自动母版的全部长尾浏览器组合另待验，不能由参考单例扩为全套|
|A23 旁白检查中试听参考/候选|已实现并验证|实际浏览器旧章节预检被hold后点参考B，60秒释放迟到A，媒体来源仍为B直至正常播放结束；Node覆盖候选等其余来源。|[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[browser-reference](../../data/ux-hardening-20261003/browser/README.md)|实际候选/整章/自动母版的全部长尾浏览器组合另待验，不能由参考单例扩为全套|
|A24 检查期间停止/切章往返|已实现未验证|playIntent已覆盖各来源、准备/媒体Promise/母版与停止；Node/AST迟到和立即暂停通过，本机已有背景暂停图。|[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[browser-pause](../../data/ux-hardening-20261003/browser/background-local-pause.jpg)|真实浏览器A慢B快/参考优先/母版迟到/切章往返<br>浏览器拒播及真实音频文件失败<br>完整键盘、媒体Promise与自动母版组合|
|A25 母版就绪前选择其他声音|已实现未验证|playIntent已覆盖各来源、准备/媒体Promise/母版与停止；Node/AST迟到和立即暂停通过，本机已有背景暂停图。|[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[browser-pause](../../data/ux-hardening-20261003/browser/background-local-pause.jpg)|真实浏览器A慢B快/参考优先/母版迟到/切章往返<br>浏览器拒播及真实音频文件失败<br>完整键盘、媒体Promise与自动母版组合|
|A26 真版本变化/无害标签更新|已实现未验证|playIntent已覆盖各来源、准备/媒体Promise/母版与停止；Node/AST迟到和立即暂停通过，本机已有背景暂停图。|[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[browser-pause](../../data/ux-hardening-20261003/browser/background-local-pause.jpg)|真实浏览器A慢B快/参考优先/母版迟到/切章往返<br>浏览器拒播及真实音频文件失败<br>完整键盘、媒体Promise与自动母版组合|
|A27 浏览器拒播/文件错误|已实现未验证|playIntent已覆盖各来源、准备/媒体Promise/母版与停止；Node/AST迟到和立即暂停通过，本机已有背景暂停图。|[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[browser-pause](../../data/ux-hardening-20261003/browser/background-local-pause.jpg)|真实浏览器A慢B快/参考优先/母版迟到/切章往返<br>浏览器拒播及真实音频文件失败<br>完整键盘、媒体Promise与自动母版组合|
|A28 B排队时放弃A|已实现并验证|实际Mock worker覆盖B排队/在途放弃A、入库A、放弃B、改描述/放弃会话和同会话unknown；输入不改写。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[candidate](../../data/ux-hardening-20261003/automation/enhancement-worker-final.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A29 B在途时放弃A|已实现并验证|实际Mock worker覆盖B排队/在途放弃A、入库A、放弃B、改描述/放弃会话和同会话unknown；输入不改写。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[candidate](../../data/ux-hardening-20261003/automation/enhancement-worker-final.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A30 描述真的改变/放弃会话|已实现并验证|实际Mock worker覆盖B排队/在途放弃A、入库A、放弃B、改描述/放弃会话和同会话unknown；输入不改写。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[candidate](../../data/ux-hardening-20261003/automation/enhancement-worker-final.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A31 实际同会话unknown|已实现并验证|实际Mock worker覆盖B排队/在途放弃A、入库A、放弃B、改描述/放弃会话和同会话unknown；输入不改写。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[candidate](../../data/ux-hardening-20261003/automation/enhancement-worker-final.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A32 组/scene最新失败|已实现并验证|实际unit/variant事实统一readiness与失败/问题/主动作；活动组抑制被替代成员失败，坏决定可见，停用参考不误拦本地成品。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A33 成功组覆盖历史失败单句|已实现并验证|实际unit/variant事实统一readiness与失败/问题/主动作；活动组抑制被替代成员失败，坏决定可见，停用参考不误拦本地成品。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A34 布尔true但决定不成立|已实现并验证|实际unit/variant事实统一readiness与失败/问题/主动作；活动组抑制被替代成员失败，坏决定可见，停用参考不误拦本地成品。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A35 参考停用且成品完整|已实现并验证|实际unit/variant事实统一readiness与失败/问题/主动作；活动组抑制被替代成员失败，坏决定可见，停用参考不误拦本地成品。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A36 排除/隐藏成员、组计数|已实现并验证|实际unit/variant事实统一readiness与失败/问题/主动作；活动组抑制被替代成员失败，坏决定可见，停用参考不误拦本地成品。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A37 匹配且rework|已实现并验证|matched+rework进入按单元重做计划，组一次请求，其他好结果复用；仅标返工0调用且正式导出阻断。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A38 普通matched且未否决|已实现并验证|matched+rework进入按单元重做计划，组一次请求，其他好结果复用；仅标返工0调用且正式导出阻断。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A39 组返工与混合选中|已实现并验证|matched+rework进入按单元重做计划，组一次请求，其他好结果复用；仅标返工0调用且正式导出阻断。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A40 仅标返工|已实现并验证|matched+rework进入按单元重做计划，组一次请求，其他好结果复用；仅标返工0调用且正式导出阻断。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A41 1500/1501/2000事件长度|已实现并验证|共享sceneContract按Unicode代码点1500描述/3000提示；AI超限partial，1500合法、1501/2000拒绝，emoji及组合字符原文保留。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[unicode](../../data/ux-hardening-20261003/automation/unicode-contract-check.json)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|实际输入法续写属于A49，不由validator证明|
|A42 Unicode/emoji/组合字符|已实现并验证|共享sceneContract按Unicode代码点1500描述/3000提示；AI超限partial，1500合法、1501/2000拒绝，emoji及组合字符原文保留。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[unicode](../../data/ux-hardening-20261003/automation/unicode-contract-check.json)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|实际输入法续写属于A49，不由validator证明|
|A43 总提示超限|已实现并验证|共享sceneContract按Unicode代码点1500描述/3000提示；AI超限partial，1500合法、1501/2000拒绝，emoji及组合字符原文保留。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[unicode](../../data/ux-hardening-20261003/automation/unicode-contract-check.json)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|实际输入法续写属于A49，不由validator证明|
|A44 合法边界/真非法字段|已实现并验证|共享sceneContract按Unicode代码点1500描述/3000提示；AI超限partial，1500合法、1501/2000拒绝，emoji及组合字符原文保留。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[unicode](../../data/ux-hardening-20261003/automation/unicode-contract-check.json)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|实际输入法续写属于A49，不由validator证明|
|A45 导入非空草稿关闭重开|已实现并验证|导入非空草稿持久化和关页恢复、A慢B快、4MB预检、UTF8/读取错误区分、编辑保留原文件来源均有组件回调夹具。|[front](../../data/ux-hardening-20261003/frontend-regression.log)|真实系统选文件和浏览器存储配额组合|
|A46 选A再选B，A较晚返回|已实现并验证|导入非空草稿持久化和关页恢复、A慢B快、4MB预检、UTF8/读取错误区分、编辑保留原文件来源均有组件回调夹具。|[front](../../data/ux-hardening-20261003/frontend-regression.log)|真实系统选文件和浏览器存储配额组合|
|A47 大文件/非UTF8/读取失败|已实现并验证|导入非空草稿持久化和关页恢复、A慢B快、4MB预检、UTF8/读取错误区分、编辑保留原文件来源均有组件回调夹具。|[front](../../data/ux-hardening-20261003/frontend-regression.log)|真实系统选文件和浏览器存储配额组合|
|A48 改预览与原始导入文件|已实现并验证|导入非空草稿持久化和关页恢复、A慢B快、4MB预检、UTF8/读取错误区分、编辑保留原文件来源均有组件回调夹具。|[front](../../data/ux-hardening-20261003/frontend-regression.log)|真实系统选文件和浏览器存储配额组合|
|A49 保存等待继续中文输入|已实现未验证|composition保护及保存屏障实现，原回调逻辑有Node检查；未进行真人中文输入法/光标续写验证。|[front](../../data/ux-hardening-20261003/frontend-regression.log)|真实IME、光标位置、保存等待期间继续中文输入|
|A50 同章多对象保存与相关依赖|已实现并验证|确切回执串联不相交保存、重叠freeze计数、同ID恢复/新目标先写后清，以及取消后迟到计划/授权/错误有Node回调验证。|[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A51 两条屏障重叠和取消|已实现并验证|确切回执串联不相交保存、重叠freeze计数、同ID恢复/新目标先写后清，以及取消后迟到计划/授权/错误有Node回调验证。|[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A52 丢响应与新对象ID移交|已实现并验证|确切回执串联不相交保存、重叠freeze计数、同ID恢复/新目标先写后清，以及取消后迟到计划/授权/错误有Node回调验证。|[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A53 迟到授权/错误/建议回调|已实现并验证|确切回执串联不相交保存、重叠freeze计数、同ID恢复/新目标先写后清，以及取消后迟到计划/授权/错误有Node回调验证。|[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A54 scene共同指导进入建议【已实现，保留回归】|已实现并验证|scene整体指导、修订、已采用/移除事件进入AI建议；旧建议在指导变化后不可采用，dry/extract保持原政策。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A55 系统默认与人工要求冲突|已实现并验证|保留旧v1/v2/v3，新presence独立ID，来源记录及明确冲突聚合；普通编译/诊断0额外文本调用、0真实调用。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[K-mock](../../data/ux-hardening-20261003/k-presence/mock/ledger.json)|未确定自然语义保留原文；非自动NLP判定|
|A56 干声/scene模板隔离|已实现并验证|保留旧v1/v2/v3，新presence独立ID，来源记录及明确冲突聚合；普通编译/诊断0额外文本调用、0真实调用。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[K-mock](../../data/ux-hardening-20261003/k-presence/mock/ledger.json)|未确定自然语义保留原文；非自动NLP判定|
|A57 0真实授权|已实现并验证|保留旧v1/v2/v3，新presence独立ID，来源记录及明确冲突聚合；普通编译/诊断0额外文本调用、0真实调用。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[K-mock](../../data/ux-hardening-20261003/k-presence/mock/ledger.json)|未确定自然语义保留原文；非自动NLP判定|
|A58 A/B/C/D原生条件【已有历史证据】|已实现未验证|原A/B/C/D条件档案存在，D精确分类已只读复核；未本轮重跑全部历史样本，未取得外部审计ZIP完整比对。|[old-native](../../data/native-scene-20261003/frozen-experiment.json)<br>[D](../../data/native-scene-20261003/D-workbench.json)<br>[old-GJ](../../data/native-scene-20261003/joint-capability-followup/human-listening-correction.json)|全部外部原档案对应关系|
|A59 原343字场景K|已实现未验证|旧343字78.4秒K只作为既往基准；新首对真实收到原始WAV和正常母版，背景与首中尾文字身份仍待听评。|[old-K](../../data/native-scene-20261003/original-long-followup/human-listening-assessment.json)<br>[K-frozen](../../data/ux-hardening-20261003/k-presence/live/frozen.json)<br>[K-live](../../data/ux-hardening-20261003/k-presence/live/ledger.json)|提交用户首/中/尾、转折、正文和背景存在感听评<br>实际raw/母版/导出播放链的保真听辨|
|A60 原文件与应用/导出|已实现未验证|旧343字78.4秒K只作为既往基准；新首对真实收到原始WAV和正常母版，背景与首中尾文字身份仍待听评。|[old-K](../../data/native-scene-20261003/original-long-followup/human-listening-assessment.json)<br>[K-frozen](../../data/ux-hardening-20261003/k-presence/live/frozen.json)<br>[K-live](../../data/ux-hardening-20261003/k-presence/live/ledger.json)|提交用户首/中/尾、转折、正文和背景存在感听评<br>实际raw/母版/导出播放链的保真听辨|
|A61 缺派生母版但原音频齐|已实现并验证|完整配方缺派生母版可免费本地重建再迁移；缺原始素材列准确缺项、变化重新解码，历史导出/unknown原件不被清理。|[storage](../../data/ux-hardening-20261003/storage-final.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[schema-backup](../../data/ux-hardening-20261003/automation/native-schema-backup-tests.log)<br>[location](../../data/ux-hardening-20261003/workspace-location-client.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A62 缺原始音频/参考|已实现并验证|完整配方缺派生母版可免费本地重建再迁移；缺原始素材列准确缺项、变化重新解码，历史导出/unknown原件不被清理。|[storage](../../data/ux-hardening-20261003/storage-final.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[schema-backup](../../data/ux-hardening-20261003/automation/native-schema-backup-tests.log)<br>[location](../../data/ux-hardening-20261003/workspace-location-client.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A63 文件变化与缓存失效|已实现并验证|完整配方缺派生母版可免费本地重建再迁移；缺原始素材列准确缺项、变化重新解码，历史导出/unknown原件不被清理。|[storage](../../data/ux-hardening-20261003/storage-final.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[schema-backup](../../data/ux-hardening-20261003/automation/native-schema-backup-tests.log)<br>[location](../../data/ux-hardening-20261003/workspace-location-client.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A64 多份历史导出|已实现并验证|完整配方缺派生母版可免费本地重建再迁移；缺原始素材列准确缺项、变化重新解码，历史导出/unknown原件不被清理。|[storage](../../data/ux-hardening-20261003/storage-final.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[schema-backup](../../data/ux-hardening-20261003/automation/native-schema-backup-tests.log)<br>[location](../../data/ux-hardening-20261003/workspace-location-client.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A65 删除确认后项目范围变化|已实现并验证|删除预览绑定实际资料范围，新章/修改/新export使旧scope 409；共享音色、候选及在途授权保护，面板原处重核对。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A66 删除涉及共享音色/候选|已实现并验证|删除预览绑定实际资料范围，新章/修改/新export使旧scope 409；共享音色、候选及在途授权保护，面板原处重核对。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A67 迁移低空间/权限/途中中断|已实现未验证|复制/暂存/配置失败源库保留、DB和文件中途失败回滚有测试；实际低空间/权限/进程途中中断专项尚未齐。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[storage](../../data/ux-hardening-20261003/storage-final.log)|ENOSPC、权限拒绝、复制中进程终止恢复|
|A68 WAL/事务与文件改名交界|已实现并验证|SQLite一致WAL副本、升级事务回滚、删除stage重启对账、产物追回0重发，以及软链/越界/不空目录严格保护有隔离验证。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[storage](../../data/ux-hardening-20261003/storage-final.log)<br>[schema-backup](../../data/ux-hardening-20261003/automation/native-schema-backup-tests.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A69 符号链接/越界/同名目录|已实现并验证|SQLite一致WAL副本、升级事务回滚、删除stage重启对账、产物追回0重发，以及软链/越界/不空目录严格保护有隔离验证。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[storage](../../data/ux-hardening-20261003/storage-final.log)<br>[schema-backup](../../data/ux-hardening-20261003/automation/native-schema-backup-tests.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A70 300/1000条及长历史|已实现未验证|300/1000×5历史domain投影有机器/p50/内存；索引和本请求复用实测显著改进，未测浏览器输入/轮询及解码。|[perf-before](../../data/ux-hardening-20261003/performance-before.json)<br>[perf-index](../../data/ux-hardening-20261003/performance-after.json)<br>[profile-final](../../data/ux-hardening-20261003/automation/native-history-profile-final.json)<br>[perf-final](../../data/ux-hardening-20261003/performance-final.json)|浏览器输入/轮询/完整载荷、请求数、p95<br>长历史实际全音频解码与前端内存|
|A71 初启很多原音频|已实现未验证|启动按已有音频逐个实际校验并输出计数，原件历史保留；很多真实音频首启时长/用户看到的健康状态未专项测量。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|多音频真实冷启动与用户等待诊断|
|A72 长列表筛选/播放/定位|已实现未验证|组筛选作用域、任务焦点及同记录轮询不抢焦点有AST；长列表真实滚动/焦点保持未完成。|[front](../../data/ux-hardening-20261003/frontend-regression.log)|1000条真实滚动/定位/切筛选和播放|
|A73 长期缓存/记录增长|已实现未验证|只读库存及面板按四类列数量/引用字节、缺原件/可免费重建母版，清理保留历史；长期增长数据演练仍未跑。|[schema-backup](../../data/ux-hardening-20261003/automation/native-schema-backup-tests.log)<br>[location](../../data/ux-hardening-20261003/workspace-location-client.log)<br>[storage](../../data/ux-hardening-20261003/storage-final.log)|长期增长数据的空间诊断及清理演练|
|A74 导出成功|已实现并验证|Node夹具验证成品卡与关面板迟到回执不夺窗口；实际浏览器WAV/MP3卡与下载已完成，bytes/实际masterId核对。|[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[browser-reference](../../data/ux-hardening-20261003/browser/README.md)<br>[delivery](../../data/ux-hardening-20261003/delivery-verification.json)|全部切章/关窗口的真实浏览器下载组合未扩大签收|
|A75 导出期间切章/关窗口|已实现并验证|Node夹具验证成品卡与关面板迟到回执不夺窗口；实际浏览器WAV/MP3卡与下载已完成，bytes/实际masterId核对。|[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[browser-reference](../../data/ux-hardening-20261003/browser/README.md)<br>[delivery](../../data/ux-hardening-20261003/delivery-verification.json)|全部切章/关窗口的真实浏览器下载组合未扩大签收|
|A76 同母版WAV/MP3|已实现并验证|本地FFmpeg母版映射/帧数及WAV/MP3路径测试通过；损坏源/过期编排拒绝，不把unknown当现有音频损坏。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A77 导出过期/源损坏/结果不明|已实现并验证|本地FFmpeg母版映射/帧数及WAV/MP3路径测试通过；损坏源/过期编排拒绝，不把unknown当现有音频损坏。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A78 409、unknown和服务503|已实现并验证|统一HTTP与200持久操作回执code/scope/retryClass已通过真实HTTP：409核对、503等待、500/断连接查原操作、unknown仍明确费用决定。|[error](../../data/ux-hardening-20261003/error-metadata-regression.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A79 授权到期/撤回/路由变化|已实现并验证|未授权0调用，撤回/过期/模型或路由变化终发送事务重查；已授权普通请求不增加通用责任确认。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A80 普通重跑在已授权范围|已实现并验证|未授权0调用，撤回/过期/模型或路由变化终发送事务重查；已授权普通请求不增加通用责任确认。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A81 错误定位与恢复|已实现并验证|readiness/问题按unit聚合，通用错误保留code+scope+retryClass；保存协调保持原operationId并查原回执，确定冲突回原处核对，无供应商自动重发。|[error](../../data/ux-hardening-20261003/error-metadata-regression.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A82 新正常/错误/空/禁用状态|已实现未验证|沿用组件和信息层级，按钮可用性/名称/焦点有AST及build；整页视觉宽度/键盘读屏/200%缩放不由源码或截图单例证明。|[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[front-build](../../data/ux-hardening-20261003/frontend-build.log)<br>[browser-pause](../../data/ux-hardening-20261003/browser/background-local-pause.jpg)|960/1280/1440同数据全状态<br>键盘/读屏/200%全界面缩放真人验收|
|A83 同数据960/1280/1440及长标题|已实现未验证|沿用组件和信息层级，按钮可用性/名称/焦点有AST及build；整页视觉宽度/键盘读屏/200%缩放不由源码或截图单例证明。|[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[front-build](../../data/ux-hardening-20261003/frontend-build.log)<br>[browser-pause](../../data/ux-hardening-20261003/browser/background-local-pause.jpg)|960/1280/1440同数据全状态<br>键盘/读屏/200%全界面缩放真人验收|
|A84 键盘/读屏/缩放|已实现未验证|沿用组件和信息层级，按钮可用性/名称/焦点有AST及build；整页视觉宽度/键盘读屏/200%缩放不由源码或截图单例证明。|[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[front-build](../../data/ux-hardening-20261003/frontend-build.log)<br>[browser-pause](../../data/ux-hardening-20261003/browser/background-local-pause.jpg)|960/1280/1440同数据全状态<br>键盘/读屏/200%全界面缩放真人验收|
|A85 成品选择与历史试听|已实现并验证|组件回调与标签检查区分实际正在使用、历史试听、恢复旧设置和生成新版；不把请求记录当可选成品。|[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A86 同origin换工作区/同ID备份|已实现并验证|真实红灯后改为canonical path+原生DB dev/ino身份；独立probe实际共享helper证明同路径新备份不读旧稿、B保留、原A移回可找原稿；真实state HTTP出口及39/39/build通过。|[backup-fork-red](../../data/ux-hardening-20261003/automation/same-path-backup-red.json)<br>[backup-fork-final](../../data/ux-hardening-20261003/automation/same-path-backup-probe.json)<br>[workspace-identity](../../data/ux-hardening-20261003/automation/workspace-identity-final.log)<br>[workspace-identity-build](../../data/ux-hardening-20261003/automation/workspace-identity-build.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|不同origin仍隔离；旧path-only namespace只查看/复制不自动迁入，用户说明见A89|
|A87 复制页/关闭多份遗留|已实现并验证|复制页/关闭页认领，以及坏存储原稿/未确认operation保留均有Node夹具；工作区同路径备份缺口单列A86。|[front](../../data/ux-hardening-20261003/frontend-regression.log)|真实浏览器配额耗尽单独待测|
|A88 浏览器存储失败|已实现并验证|复制页/关闭页认领，以及坏存储原稿/未确认operation保留均有Node夹具；工作区同路径备份缺口单列A86。|[front](../../data/ux-hardening-20261003/frontend-regression.log)|真实浏览器配额耗尽单独待测|
|A89 新旧版本origin/端口变化|已实现并验证|使用说明和quick-start已明确4318/5173、改主机或端口先回原入口保存/复制；归属未知legacy仅看/复制/弃，不承诺跨origin自动迁移。|[front](../../data/ux-hardening-20261003/frontend-regression.log)|实际跨origin找回操作未运行；本条验证的是说明与真实隔离政策|
|A90 正式删除与遗留草稿|已实现并验证|实际HTTP正式删除项目/章后新建独立对象，旧台词/导入/背景3稿仍可查看复制；真实RecoveryCenter回调投影恢复按钮禁用，新对象0自动套稿、新正文未改。|[supplemental-http](../../data/ux-hardening-20261003/automation/deleted-draft-diagnostics-probe.json)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|实体浏览器与系统剪贴板未操作；本行验证实际HTTP和回调投影|
|A91 全新Mac缺依赖/首次连接|按计划延期|计划的外部新机验收尚未执行；开发机已有Node/FFmpeg不能代替新用户安装。|暂无运行证据|干净Mac、缺依赖、首次连接/路径/停止实录|
|A92 包双击/已有服务/端口占用|已实现未验证|本机隔离启动脚本已有复用PID/工作区、端口保护、安全停止；Finder双击与全新机组合未签收。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[launch](../../data/ux-hardening-20261003/storage-launch-clean.log)|当前发行包Finder双击及占用端口恢复实录|
|A93 更新与回退|已实现未验证|schema3拒绝旧写入器、只读备份/升级回滚有实测；完整发行包更新和回退数据/音频保留还需复验。|[storage](../../data/ux-hardening-20261003/storage-final.log)<br>[native](../../data/ux-hardening-20261003/automation/native-history-final.log)|当前包更新/回退端到端演练|
|A94 保存位置不可用|已实现并验证|已保存目录断开、原DB缺失/空文件拒绝且不建空库；隔离测试覆盖首次默认、显式DATA_DIR及有效目录别名仍可用，9/9与构建通过。|[saved-location-red](../../data/ux-hardening-20261003/automation/saved-workspace-location-red.log)<br>[saved-location](../../data/ux-hardening-20261003/automation/saved-workspace-location-final.log)<br>[saved-location-build](../../data/ux-hardening-20261003/automation/saved-workspace-location-build.log)|物理外接盘断开+Finder启动属于真实环境组合，未冒称运行|
|A95 发布文件/日志/缓存|已实现并验证|159公开候选源及dist实际配置key匹配0，gitleaks当前公开快照与16可达已有commit无发现，3处同一fake fixture人工核对；修后实际ZIP65文件独立扫描0禁入/0symlink/0密钥格式，私有K/备份不入包。|[credential-review](../../data/ux-hardening-20261003/credential-review.json)<br>[package-scan](../../data/ux-hardening-20261003/distribution/package-content-scan.json)|扫描范围仅报告列出的公开源、dist、16已有commit与当前实际ZIP；最终本地commit由release-revision关联，不冒称未列历史|
|A96 本机HTTP边界与上传|已实现并验证|真实本机HTTP隔离测试覆盖Host/Origin、密钥不入state、路径与上传大小/格式、供应商错误脱敏。|[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A97 运行标记损坏/PID复用|已实现并验证|坏runtime/零负PID和升级失败回滚通过；复用实际解包启动记录，存活正PID与服务PID不符时拒绝，原服务/别名正常复用，之后HTTP迁移成功；不盲杀或删库。|[storage](../../data/ux-hardening-20261003/storage-final.log)<br>[distribution](../../data/ux-hardening-20261003/distribution/verification.json)<br>[supplemental-http](../../data/ux-hardening-20261003/automation/deleted-draft-diagnostics-probe.json)|使用distribution原进程与HTTP证据，没有重复启动；不扩为所有物理PID回收时序|
|A98 分享诊断|已实现并验证|实际HTTP非空scene-v3兼容诊断仅返回7个白名单字段；key/正文/表演/背景/参考路径/Base64/生成路径/库路径哨兵均未外露，原audio记录未改，0供应商。|[supplemental-http](../../data/ux-hardening-20261003/automation/deleted-draft-diagnostics-probe.json)<br>[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅验证实际最小HTTP诊断；不自动授权外发私有素材或全部工作区快照|
|A99 固定最终SHA全量测试|已实现未验证|原有效断言与阶段失败原因保留；A94/A86修后最终工作树534/534及build通过。最后本地提交的源/blob与既测source/build关联由release-revision.json记录，同一生产源码不为提交号重跑。|[full](../../data/ux-hardening-20261003/regression-release.log)<br>[build](../../data/ux-hardening-20261003/build-release.log)|当前观察时尚未本地commit；提交后release-revision关联534/534同一源码与实际包；不push/merge|
|A100 build与包一致|已实现并验证|最终TypeScript/Vite构建通过；修后实际包65文件、61份source/dist/start/docs逐字节一致，14/14启动/恢复检查，7/7本地文档目标及标题anchor有效。原64文件包断链红灯与旧报告保留。|[front-build](../../data/ux-hardening-20261003/frontend-build.log)<br>[build](../../data/ux-hardening-20261003/build-release.log)<br>[distribution](../../data/ux-hardening-20261003/distribution/verification.json)<br>[package-links-red](../../data/ux-hardening-20261003/automation/package-guide-links-red.json)<br>[package-links](../../data/ux-hardening-20261003/automation/package-guide-links-final.json)<br>[package-scan](../../data/ux-hardening-20261003/distribution/package-content-scan.json)|开发机独立解包不代表干净Mac安装或真人听评；ZIP版本由release-revision关联|
|A101 正常+失败真实浏览器|已实现并验证|真实浏览器10项正常/迟到/只读历史操作已记录：播放暂停、参考优先、WAV/MP3实际下载、导入关闭重开创建一次、单层取消删除、历史预览Escape焦点及真实4318旧历史恢复差异预览、返回未apply；0新增模型调用。|[browser-reference](../../data/ux-hardening-20261003/browser/README.md)<br>[delivery](../../data/ux-hardening-20261003/delivery-verification.json)|真实IME/200%缩放/媒体拒播/权限低空间及全部多页长尾仍未验，不由10项代替|
|A102 旧关闭项跨流程回归|已实现并验证|当前native/core/frontend及Mock worker保留旧生成、草稿、组、导出保护断言；独立历史查询与新未知范围回归补齐。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[candidate](../../data/ux-hardening-20261003/automation/enhancement-worker-final.log)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|A103 5新手核心任务|按计划延期|按计划进入独立产品签收阶段；尚无5新手+2熟手、严重风险逐项判定及声音/视觉/安装签署，自动化不代签。|暂无运行证据|5新手各关键任务>=4/5独立完成<br>2熟手精修回归<br>数据/正文/付费/错版单独零容忍判断<br>工程/声学/新人/视觉/安装分别签收|
|A104 2熟手精修任务|按计划延期|按计划进入独立产品签收阶段；尚无5新手+2熟手、严重风险逐项判定及声音/视觉/安装签署，自动化不代签。|暂无运行证据|5新手各关键任务>=4/5独立完成<br>2熟手精修回归<br>数据/正文/付费/错版单独零容忍判断<br>工程/声学/新人/视觉/安装分别签收|
|A105 严重风险判定|按计划延期|按计划进入独立产品签收阶段；尚无5新手+2熟手、严重风险逐项判定及声音/视觉/安装签署，自动化不代签。|暂无运行证据|5新手各关键任务>=4/5独立完成<br>2熟手精修回归<br>数据/正文/付费/错版单独零容忍判断<br>工程/声学/新人/视觉/安装分别签收|
|A106 最终签收|按计划延期|按计划进入独立产品签收阶段；尚无5新手+2熟手、严重风险逐项判定及声音/视觉/安装签署，自动化不代签。|暂无运行证据|5新手各关键任务>=4/5独立完成<br>2熟手精修回归<br>数据/正文/付费/错版单独零容忍判断<br>工程/声学/新人/视觉/安装分别签收|
|B01 相同native ID的旧冻结提示|已实现并验证|不可变compiler registry按原input/prompt精确分类；未知只读，恢复candidate逐字相同；原D unknown保留，schema3拒绝旧writer。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[storage](../../data/ux-hardening-20261003/storage-final.log)<br>[D](../../data/native-scene-20261003/D-workbench.json)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|B02 精确可复现历史模板|已实现并验证|不可变compiler registry按原input/prompt精确分类；未知只读，恢复candidate逐字相同；原D unknown保留，schema3拒绝旧writer。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[storage](../../data/ux-hardening-20261003/storage-final.log)<br>[D](../../data/native-scene-20261003/D-workbench.json)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|B03 无法重现或缺少编译器|已实现并验证|不可变compiler registry按原input/prompt精确分类；未知只读，恢复candidate逐字相同；原D unknown保留，schema3拒绝旧writer。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[storage](../../data/ux-hardening-20261003/storage-final.log)<br>[D](../../data/native-scene-20261003/D-workbench.json)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|B04 模板迁移与回退|已实现并验证|不可变compiler registry按原input/prompt精确分类；未知只读，恢复candidate逐字相同；原D unknown保留，schema3拒绝旧writer。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[storage](../../data/ux-hardening-20261003/storage-final.log)<br>[D](../../data/native-scene-20261003/D-workbench.json)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|B05 未采用draft随历史恢复|已实现并验证|仅替换采用事件；draft/removed保持追踪；预览列草稿与事件差异，baseRevisions重验新增草稿，ID/来源冲突拒绝。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|B06 恢复后已采用事件集合|已实现并验证|仅替换采用事件；draft/removed保持追踪；预览列草稿与事件差异，baseRevisions重验新增草稿，ID/来源冲突拒绝。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|B07 预览后另一页新增草稿|已实现并验证|仅替换采用事件；draft/removed保持追踪；预览列草稿与事件差异，baseRevisions重验新增草稿，ID/来源冲突拒绝。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|B08 事件ID冲突或来源改变|已实现并验证|仅替换采用事件；draft/removed保持追踪；预览列草稿与事件差异，baseRevisions重验新增草稿，ID/来源冲突拒绝。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|B09 当前提示超限恢复短旧设置|已实现并验证|不先编译当前坏指导；保护正文/参考/成员，历史候选合法且精确后原子写；中途SQL/持久后置条件失败全部回滚，rework保留。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|B10 当前正文/参考/成员真改变|已实现并验证|不先编译当前坏指导；保护正文/参考/成员，历史候选合法且精确后原子写；中途SQL/持久后置条件失败全部回滚，rework保留。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|B11 恢复多步中途写失败|已实现并验证|不先编译当前坏指导；保护正文/参考/成员，历史候选合法且精确后原子写；中途SQL/持久后置条件失败全部回滚，rework保留。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|B12 恢复成功后置条件|已实现并验证|不先编译当前坏指导；保护正文/参考/成员，历史候选合法且精确后原子写；中途SQL/持久后置条件失败全部回滚，rework保留。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|B13 AI描述1501字符|已实现并验证|AI描述1501/2000不ready且不截断；编辑/采用/编译同1500代码点，整体3000预算拒绝；emoji/组合边界已执行。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[unicode](../../data/ux-hardening-20261003/automation/unicode-contract-check.json)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|B14 Unicode和整体预算|已实现并验证|AI描述1501/2000不ready且不截断；编辑/采用/编译同1500代码点，整体3000预算拒绝；emoji/组合边界已执行。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[unicode](../../data/ux-hardening-20261003/automation/unicode-contract-check.json)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|B15 用户选clear/natural/subtle|已实现并验证|显式clear/natural/subtle仅替换presence块，未设置原样；development与volumeChange分开，member+quote+occurrence保护，明确冲突聚合且正文词语不误扫。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[K-frozen](../../data/ux-hardening-20261003/k-presence/live/frozen.json)|自然语言不确定语义不自动改写；无毫秒/新文本或音乐请求|
|B16 宁静发展与可闻性|已实现并验证|显式clear/natural/subtle仅替换presence块，未设置原样；development与volumeChange分开，member+quote+occurrence保护，明确冲突聚合且正文词语不误扫。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[K-frozen](../../data/ux-hardening-20261003/k-presence/live/frozen.json)|自然语言不确定语义不自动改写；无毫秒/新文本或音乐请求|
|B17 真实引文与重复词|已实现并验证|显式clear/natural/subtle仅替换presence块，未设置原样；development与volumeChange分开，member+quote+occurrence保护，明确冲突聚合且正文词语不误扫。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[K-frozen](../../data/ux-hardening-20261003/k-presence/live/frozen.json)|自然语言不确定语义不自动改写；无毫秒/新文本或音乐请求|
|B18 明确指导/人工冲突|已实现并验证|显式clear/natural/subtle仅替换presence块，未设置原样；development与volumeChange分开，member+quote+occurrence保护，明确冲突聚合且正文词语不误扫。|[native](../../data/ux-hardening-20261003/automation/native-history-final.log)<br>[front](../../data/ux-hardening-20261003/frontend-regression.log)<br>[K-frozen](../../data/ux-hardening-20261003/k-presence/live/frozen.json)|自然语言不确定语义不自动改写；无毫秒/新文本或音乐请求|
|B19 K0/K1冻结配对|已实现并验证|首对真实K0/K1冻结仅presence不同，343字正文/参考/模型/参数/路由相同，全部实际请求及原文件有ledger。|[K-frozen](../../data/ux-hardening-20261003/k-presence/live/frozen.json)<br>[K-live](../../data/ux-hardening-20261003/k-presence/live/ledger.json)<br>[K-mock](../../data/ux-hardening-20261003/k-presence/mock/ledger.json)|听感结果另列B22，不能由请求冻结推导|
|B20 新预算尚未同意|已实现并验证|无授权路径Mock/预检0真实调用；首对在当前用户明确授权后仅2请求，既往10次不作无限授权。|[K-frozen](../../data/ux-hardening-20261003/k-presence/live/frozen.json)<br>[K-mock](../../data/ux-hardening-20261003/k-presence/mock/ledger.json)<br>[core](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|B21 每次新生成与unknown|已实现并验证|本次2次返回全部记录且首对后等待提交听评；unknown不自动重发、下一决定绑定实际attempt/目标范围有Mock正反。|[K-live](../../data/ux-hardening-20261003/k-presence/live/ledger.json)<br>[unknown](../../data/ux-hardening-20261003/automation/core-unknown-final.log)<br>[K-preflight](../../data/ux-hardening-20261003/k-presence/mock/preflight-error-ledger.json)|仅限本行明确列出的工程层级；不自动扩为真人签收|
|B22 K原始听评|按计划延期|新首对humanListening为pending；用户未提交首中尾/转折/正文/背景存在感评分，音量问题保持效果待验。|[K-live](../../data/ux-hardening-20261003/k-presence/live/ledger.json)<br>[old-K](../../data/native-scene-20261003/original-long-followup/human-listening-assessment.json)|用户提交本次K0/K1听评及是否满意|
|B23 原始WAV与正常母版试听|已实现未验证|原始WAV/正常母版有不同声道与时长元数据；未形成相同音量/相同媒体来源的完整听评记录，不用RMS冒称背景响度。|[K-live](../../data/ux-hardening-20261003/k-presence/live/ledger.json)<br>[K-mock](../../data/ux-hardening-20261003/k-presence/mock/ledger.json)|raw与正常母版统一播放音量听辨记录|
|B24 诊断包装与费用保护|已实现并验证|正常worker掌握供应商响应和unknown账本，mock预检/回应原件记录不伪成功；D诊断采集unknown保持，0自动重发。|[K-mock](../../data/ux-hardening-20261003/k-presence/mock/ledger.json)<br>[K-live](../../data/ux-hardening-20261003/k-presence/live/ledger.json)<br>[K-preflight](../../data/ux-hardening-20261003/k-presence/mock/preflight-error-ledger.json)<br>[unknown](../../data/ux-hardening-20261003/automation/core-unknown-final.log)<br>[D](../../data/native-scene-20261003/D-workbench.json)|仅限本行明确列出的工程层级；不自动扩为真人签收|

## 原始证据与重放

详见 [automation/README.md](../../data/ux-hardening-20261003/automation/README.md)；归档目录同时保留红灯、过渡失败和最终绿灯，过渡日志不能冒充最终结论。

|证据ID|层级|结果与边界|文件|
|---|---|---|---|
|native|已运行 Node 隔离夹具|77/77；enhancement/native-scene/scene-analysis/history-query|[native-history-final.log](../../data/ux-hardening-20261003/automation/native-history-final.log)|
|candidate|已运行 Mock worker + 本地FFmpeg|51/51；候选取舍/在途/同会话unknown|[enhancement-worker-final.log](../../data/ux-hardening-20261003/automation/enhancement-worker-final.log)|
|core|已运行 Node + Mock + 实际本地FFmpeg/HTTP|230/230；experience/worker/semantic-split/project-delete/storage-hardening/enhancement-worker；含A21事务修复|[core-storage-review-final4.log](../../data/ux-hardening-20261003/automation/core-storage-review-final4.log)|
|repair|已运行隔离A21事务应用 + 反向回滚|9/9；chapter.repair-structural-decisions由scope/revision/eligible保护，保存before快照|[core-repair-apply-final.log](../../data/ux-hardening-20261003/automation/core-repair-apply-final.log)|
|red-repair|新动作缺失最小红灯|原路由无handler落入segmentget；已由repair最终日志覆盖|[core-repair-apply-red.log](../../data/ux-hardening-20261003/automation/core-repair-apply-red.log)|
|unknown|已运行 Mock 请求与实际计划提交|9/9；含单子范围、merge、双子计划集合去重|[core-unknown-final.log](../../data/ux-hardening-20261003/automation/core-unknown-final.log)|
|front|已运行 Node/AST 真实组件回调夹具，非浏览器|140/140；19文件，不能替代输入法/媒体Promise/真人浏览器|[frontend-regression.log](../../data/ux-hardening-20261003/frontend-regression.log)|
|error|已运行真实本机HTTP + 客户端回调|4/4；403/409/503/500/连接丢回执及200持久操作回执均带code/scope/retryClass，供应商0请求|[error-metadata-regression.log](../../data/ux-hardening-20261003/error-metadata-regression.log)|
|location|已运行实际位置面板回调|3/3；四类数量/引用字节、原件缺失禁迁移、可重建母版区分；不是长期真库测量|[workspace-location-client.log](../../data/ux-hardening-20261003/workspace-location-client.log)|
|front-build|已运行 TypeScript + Vite|类型检查及构建成功；不代表安装/视觉签收|[frontend-build.log](../../data/ux-hardening-20261003/frontend-build.log)|
|storage|已运行隔离SQLite + FFmpeg|4/4；旧writer、缺派生母版、坏runtime、升级回滚；history-query另见native 77/77|[storage-final.log](../../data/ux-hardening-20261003/storage-final.log)|
|schema-backup|早期运行的隔离候选/备份/清理回归|26/26；属于较早阶段，不作最新全量替代|[native-schema-backup-tests.log](../../data/ux-hardening-20261003/automation/native-schema-backup-tests.log)|
|backup|已执行完整真实资料副本备份|backup.log确认完整备份；副本不用于故障注入，不纳入分发|[backup-info.json](../../data/ux-hardening-20261003/real-workspace-backup/backup-info.json)|
|red-native|a291 隔离基线上的新增合同红灯|16子项2过14失败；不是外部38项/原13红灯的重放|[native-history-red-a291.log](../../data/ux-hardening-20261003/automation/native-history-red-a291.log)|
|red-cross|a291 隔离回放，含缺新函数/适配错误|29子项2过27失败；不把全部27计为业务缺陷|[crossflow-before.log](../../data/ux-hardening-20261003/crossflow-before.log)|
|red-storage|a291 隔离存储探针|两项旧业务红灯；具体异常见原日志|[storage-before.log](../../data/ux-hardening-20261003/storage-before.log)|
|red-plan|新增双子计划集合红灯|同父unknown ID重复；已由unknown最终9/9覆盖修复|[core-plan-unknown-red.log](../../data/ux-hardening-20261003/automation/core-plan-unknown-red.log)|
|review-stage|独立复核的过渡红灯快照|10子项9过1失败；同父ID重复，已被core-unknown-final.log取代|[native-unknown-review.log](../../data/ux-hardening-20261003/automation/native-unknown-review.log)|
|perf-before|已运行实际domain投影测量，非浏览器/解码|300/1000条、每条5历史；含机器/p50/内存；初始约4.9s/62.8s|[performance-before.json](../../data/ux-hardening-20261003/performance-before.json)|
|perf-index|已运行实际domain投影中间测量|索引初改约0.276s/2.644s；不是最终性能|[performance-after.json](../../data/ux-hardening-20261003/performance-after.json)|
|profile-before|已运行合成stat-only 1000条×5历史诊断|总2.403s；chapters读取7002次；历史查询909.9ms|[native-history-profile.json](../../data/ux-hardening-20261003/automation/native-history-profile.json)|
|profile-final|已运行同规模隔离响应诊断|总0.231s；chapters读取2次；历史56.3ms；17,334,525字节；单样本不是p95|[native-history-profile-final.json](../../data/ux-hardening-20261003/automation/native-history-profile-final.json)|
|unicode|已运行共享描述validator边界断言|emoji/组合字符1500/1501四项通过；0请求；不作真实编辑器输入法证明|[unicode-contract-check.json](../../data/ux-hardening-20261003/automation/unicode-contract-check.json)|
|D|已有真实D原始快照 + 当前只读分类核对|419 Unicode字符精确命中native3-frozen-cd；原unknown/input/prompt保留，未冒充成功恢复|[D-workbench.json](../../data/native-scene-20261003/D-workbench.json)|
|old-native|已有历史条件档案，非本轮重跑|A/B/C/D历史条件只核对已有归档；不推导当前全场景成功|[frozen-experiment.json](../../data/native-scene-20261003/frozen-experiment.json)|
|old-GJ|既往用户听评更正|J优秀、G背景偏小是既往单例；不是当前K单变量对照|[human-listening-correction.json](../../data/native-scene-20261003/joint-capability-followup/human-listening-correction.json)|
|old-K|既往343字K记录|旧78.4秒K仅基准；本轮首对听评另列|[human-listening-assessment.json](../../data/native-scene-20261003/original-long-followup/human-listening-assessment.json)|
|K-frozen|已保存本次授权首对请求条件|仅presence块变化，343字正文/参考/模型/参数/路由保留；generic生产文案替代案例专用词已说明|[frozen.json](../../data/ux-hardening-20261003/k-presence/live/frozen.json)|
|K-live|真实供应商返回，未人工验声|首对K0/K1各1次，HTTP200 received；89.8s/81.68s，humanListening pending；不追加请求|[ledger.json](../../data/ux-hardening-20261003/k-presence/live/ledger.json)|
|K-mock|已运行正常worker Mock对照|离线请求与母版流程，不能作为真实背景可闻性|[ledger.json](../../data/ux-hardening-20261003/k-presence/mock/ledger.json)|
|K-preflight|已运行Mock派发前错误对照|未发送的预检错误不伪造provider调用/产物|[preflight-error-ledger.json](../../data/ux-hardening-20261003/k-presence/mock/preflight-error-ledger.json)|
|browser-pause|本机浏览器截图；详细操作说明待补|只支持已观察的背景试听/暂停画面，不扩为所有迟到、拒播或切章组合|[background-local-pause.jpg](../../data/ux-hardening-20261003/browser/background-local-pause.jpg)|
|backup-fork-red|已运行实际SQLite + 原draft helper的同路径备份分叉探针|同canonical路径/同primaryID/同revision2的不同正文分支，原path-only身份使旧稿覆盖B；修前原件保留，不能与修后green混淆|[same-path-backup-red.json](../../data/ux-hardening-20261003/automation/same-path-backup-red.json)|
|backup-fork-final|已独立运行实际共享身份helper + SQLite + draft helper|exit0；新DB文件不读旧稿，B正文保留；原A移回原路径原稿可找回；重启与symlink别名稳定，0HTTP/供应商|[same-path-backup-probe.json](../../data/ux-hardening-20261003/automation/same-path-backup-probe.json)|
|workspace-identity|已运行SQLite/草稿与真实state HTTP出口|39/39；实际startServer GET state.settings.workspaceIdentity等于共享helper，configured=false、0模型调用|[workspace-identity-final.log](../../data/ux-hardening-20261003/automation/workspace-identity-final.log)|
|workspace-identity-build|已运行A86修后构建|TypeScript + Vite成功|[workspace-identity-build.log](../../data/ux-hardening-20261003/automation/workspace-identity-build.log)|
|baseline|已实际核对12份Git blob与原备份只读schema|12/12与计划附录相同；原真实完整备份schema2；新schema3写能力另由隔离回归证明|[baseline.json](../../doc/ux-hardening/baseline.json)|
|browser-reference|主任务已执行真实浏览器10项操作并保留截图/DOM/媒体状态|播放暂停、迟到参考优先、导入/下载/取消删除与960/1280/1440局部画面；第10项真实4318只读历史与恢复预览，未apply，未扩为全部长尾/IME|[README.md](../../data/ux-hardening-20261003/browser/README.md)|
|delivery|已执行实际媒体下载与生产资料前后只读核对|WAV下载等于母版、MP3同masterId；真库protected字段保留，135引用文件逐字节一致、audioUsage不新增；本轮真付费仅K首对2次|[delivery-verification.json](../../data/ux-hardening-20261003/delivery-verification.json)|
|credential-review|已执行公开候选源与dist范围扫描及16已有commit历史检查|159公开候选文件及dist实际配置key匹配0；gitleaks当前快照和16可达历史无发现；3处同一fake fixture人工核对，不修改抑制规则；实际包另验|[credential-review.json](../../data/ux-hardening-20261003/credential-review.json)|
|supplemental-http|已运行隔离实际HTTP/SQLite/draft helpers与真实RecoveryCenter回调投影|A90正式删除后3份可查看复制旧稿不自动投新对象；A98非空diagnostics只7白名单字段，11本机HTTP、0供应商；不是实体浏览器/系统剪贴板|[deleted-draft-diagnostics-probe.json](../../data/ux-hardening-20261003/automation/deleted-draft-diagnostics-probe.json)|
|package-links-red|独立实际旧ZIP相对链接红灯|旧64文件包缺完整说明，quick-start搬移后断链；旧14项未覆盖本地链接，保留原包与报告|[package-guide-links-red.json](../../data/ux-hardening-20261003/automation/package-guide-links-red.json)|
|package-links|独立只读复核修后实际ZIP本地链接|7/7实际路径和标题anchor通过；1,030,106bytes；0请求；不复跑启动|[package-guide-links-final.json](../../data/ux-hardening-20261003/automation/package-guide-links-final.json)|
|package-scan|已扫描修后实际ZIP独立解包文件集|65文件，0symlink/禁入路径/密钥格式，3份用户文档；不读取本机key文件、不含执行计划|[package-content-scan.json](../../data/ux-hardening-20261003/distribution/package-content-scan.json)|
|saved-location|已运行隔离保存位置检查|9/9；配置位置断开/原库缺失或为空均拒绝，不创建空库；首次默认、显式DATA_DIR及合法别名保留|[saved-workspace-location-final.log](../../data/ux-hardening-20261003/automation/saved-workspace-location-final.log)|
|saved-location-red|已运行A94最小红灯|已保存目录断开未拒绝的Missing expected exception；由saved-location最终9/9覆盖|[saved-workspace-location-red.log](../../data/ux-hardening-20261003/automation/saved-workspace-location-red.log)|
|saved-location-build|已运行A94修后TypeScript + Vite|构建成功；不是物理外接盘/新Mac实录|[saved-workspace-location-build.log](../../data/ux-hardening-20261003/automation/saved-workspace-location-build.log)|
|full|已运行A94/A86补后工作树全量回归|534/534，旧532加新增2项；未提交工作树不能称固定最终commit SHA|[regression-release.log](../../data/ux-hardening-20261003/regression-release.log)|
|build|已运行A94/A86补后最终构建|TypeScript + Vite成功；不是干净Mac安装签收|[build-release.log](../../data/ux-hardening-20261003/build-release.log)|
|perf-final|已运行300/1000条最终domain测量|本机domain测量，浏览器/解码/输入轮询仍单独待验|[performance-final.json](../../data/ux-hardening-20261003/performance-final.json)|
|launch|已运行清洁独立启动回归|旧混杂storage-launch-final.log不作最终证据|[storage-launch-clean.log](../../data/ux-hardening-20261003/storage-launch-clean.log)|
|distribution|已执行修后实际本机发行包14项复验|14/14；65文件、61份source/dist/start/docs逐字节一致，7/7本地链接+anchor有效，0供应商；不等于全新Mac安装验收|[verification.json](../../data/ux-hardening-20261003/distribution/verification.json)|
|browser|本机真实浏览器操作记录|只映射记录明确覆盖的组合|[README.md](../../data/ux-hardening-20261003/browser/README.md)|

## F / N / S 结论账本

影响范围与修后证据逐项见关联验收；JSON另保留前存分类和回退边界。未找到原38项附件，不能把新增夹具说成原审计逐条等价重放。

|问题|当前结论|影响/证据对应|
|---|---|---|
|F01|已实现并验证|A16, A17, A18, A19, A20, A21, A34|
|F02|已实现并验证|A37, A38, A39, A40|
|F03|已实现并验证|A04, A05, A06, A07, A08, A09, A31|
|F04|已实现未验证|A22, A23, A24, A25, A26, A27|
|F05|已实现并验证|A28, A29, A30, A31|
|F06|已实现并验证|A32, A33, A34, A35, A36|
|F07|已实现未验证|A10, A11, A12, A13, A14, A15, A45, A46, A47, A48|
|N01|已实现并验证|B01, B02, B03, B04|
|N02|已实现并验证|B05, B06, B07, B08|
|N03|已实现并验证|B09, B10, B11, B12|
|S01|已实现并验证|A35|
|S02|已实现并验证|A61, A62, A63, A64|
|S03|已实现并验证|A41, A42, A43, A44, B13, B14|
|S04|已实现未验证|A54, A55, A56, A57, A58, A59, A60, B15, B16, B17, B18, B19, B20, B21, B22, B23, B24|
|S05|已实现并验证|A45, A46, A47, A48|
|S06|已实现并验证|A74, A75, A76, A77|
|S07|已实现未验证|A70, A71, A72, A73|
|S08|按计划延期|A91, A92, A93, A94|

## 草稿位置与旧入口

草稿保存在浏览器当前地址的本机暂存中，并按工作区和页面归属分开。更换端口或浏览器地址后，旧稿不会自动搬到新入口；需回原地址查看、复制内容。无工作区身份的旧格式只作为遗留记录显示。A86实际红灯后改用canonical目录与原生DB文件身份；同路径新备份不误投，原A移回可找回原稿，HTTP出口与独立probe均已通过。旧path-only暂存保留查看/复制，不自动迁入新身份。用户入口说明见 [工具使用说明](../../doc/工具使用说明.md) 和 [四步入门](../../doc/ux-redesign/quick-start.md)。

## 当前未关闭项

A21补修已有230/230及专项9/9；A78/A81补修已有真实HTTP+客户端4/4证据。A94保存位置失联有red→9/9/build；A86同路径备份有原red、修后独立probe与39/39/state HTTP及build。补后全量534/534与build已过。T00/A03外部原审计材料缺失仍保留。

效果与产品边界：本轮K用户听评、真实浏览器长尾/输入法/读屏/缩放、低空间权限中断、干净Mac及5新手+2熟手签收均不得由自动化计数代签。修后实际包65文件/14项、7链接与范围扫描已验，A90/A98补充HTTP已验；最后本地commit版本关联由release-revision记录，不重跑同一生产源码。
