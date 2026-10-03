# v2.0 整改发行状态

当前继续内部试用。已完成的工程项、原始证据、未测组合见 [regression-map.md](regression-map.md)；问题分类见 [issue-register.json](issue-register.json)。本文件记录状态，不能代替正式发行或产品签收。

6e2b449保留当时的 [534/534](../../data/ux-hardening-20261003/regression-release.log)、[构建](../../data/ux-hardening-20261003/build-release.log)、10项浏览器、真实4318只读启动和实际包14项记录。之后存在感补修新增14个覆盖，当前 [548/548](../../data/ux-hardening-20261003/presence-template-fix/full-regression.log) 与 [构建](../../data/ux-hardening-20261003/presence-template-fix/build.log) 已通过；本次新增一条实际浏览器存在感启用路径、最新版包14项复验与真实工作区安全重启已通过，另列证据，不把6e的旧结果当作本次修补已验。

|验收维度|当前状态|依据/边界|
|---|---|---|
|工程范围修复|存在感补修后全量548/548与build通过|6e原534历史保留；各范围suite有重叠，不相加|
|unknown/同路径备份/保存位置|工程验证通过|实际Mock、SQLite、draft helper及state HTTP出口；0模型调用|
|原生背景效果|K1本例达到用户预期，K0未听到音乐|用户已原样提交自由听评；背景不挡人声，正文音色节奏正常；逐段首中尾/转折及raw/master来源和同音量对照未单列|
|真实浏览器|6e原10项保留；本次存在感启用路径通过|[原浏览器实录](../../data/ux-hardening-20261003/browser/README.md)与实际下载核对保留；未扩为全部长尾/IME|
|构建/实际发行包/范围扫描|本次build、新包14/14及扫描通过|65文件、61份源/build/启动/文档一致、7链接有效；旧包归档，开发机包不代替干净Mac|
|5新手+2熟手、视觉、安装|待真人填写与签收|见研究空表；没有代填通过|
|原外部38项审计材料|缺失|新增独立探针不冒充原附件等价重放|

本轮听评与入口收尾分别关联本地提交，最新SHA在提交后登记到 `data/ux-hardening-20261003/presence-template-fix/release-revision.json`，旧 `release-revision.json` 保留6e2b449历史，以该记录和Git为准，避免把提交号嵌入自身。没有远端修改、公开部署或公开分发私有K材料。真实资料副本、音频、参考及完整请求不进入默认包。公开诊断只应包含所需ID/模式/版本与已有摘要；扫描只声明实际检查的文件集，不声称扫过全部Git历史。

实际包最初搬移入门文档造成一处断链，旧64文件包与原报告保留。修后保持原文档相对目录，补入完整说明与README标题，实际ZIP7/7路径和anchor有效；此工程遗漏已登记，不把旧14项绿灯冒充链接证据。

用户路径以 [使用说明](../工具使用说明.md)和 [四步入门](../ux-redesign/quick-start.md)为准。草稿按浏览器origin、实际数据库身份与页面归属区分；改端口回原入口保存/复制。升级前只有路径归属的旧暂存仍保留可查看和复制，不自动迁入新数据库身份。正式迁移或备份恢复创建的新DB文件具有新身份，不能自动投旧稿。

A90/A98补充证据使用临时库实际11次本机HTTP：正式删除后旧3稿可查看复制、0自动套新对象，最小诊断非空返回7白名单字段且原audio不改，0供应商。A97复用已有效的实际解包进程/HTTP记录，没有重复启动；实体浏览器剪贴板未代签。

听评已补录：[原始反馈](../../data/ux-hardening-20261003/k-presence/live/human-listening.json)与 [条件/audioId绑定](../../data/ux-hardening-20261003/k-presence/live/assessment.json)。听评补录不改6e2b449当时生产/提交/发行验证；旧模板继续保留，clear仍为用户显式意图，本例通过不设全局默认。

补修防止旧有效compiler忽略已保存的轻/自然/清楚意图：共享生成入口拒绝该不生效配置，生成旁免费“核对并启用背景存在感”先等待保存，再按最新章节/单元版本预览和切换。after预览清旧compiler，与实际切换一致；冻结历史提示、旧音频和现有试听/恢复不改，不全局迁移模板。首轮回环EPERM与AST夹具闭包输入错误的原因保留，未删取消核心断言，最终548全绿不覆盖原534历史。

本次最终补证：[实际浏览器](../../data/ux-hardening-20261003/browser/presence-browser-result.json)记录旧模板选择清楚后阻止生成、免费预览并明确启用v4；没有申请新授权或点生成，模板确认后未授权按钮仍禁用。实际Chrome原生可访问树及3步截图不是模拟DOM。[本机重启](../../data/ux-hardening-20261003/presence-template-fix/production-restart-verification.json)核对所有记录的正文/角色/单位/候选及135引用文件逐字节一致、用量不变；[最新包](../../data/ux-hardening-20261003/distribution/verification.json)14项通过。以上运行0新模型请求。
