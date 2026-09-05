# Upstream convergence and fork retirement

本文是 codex-observability-plugin fork 的 Living Transition Record（持续迁移记录），用于增量跟踪上游收敛和本仓库退役过程，避免每次重新进行全量调查。

## 文档边界

- GitHub 上游仓库、Issue、Pull Request、release 和 `upstream/main` 是 Source of Truth（事实源）。
- 本文只保存带核查日期的 Verified Snapshot（已验证快照）、fork 独有差异、下一动作和退役门槛，不替代 GitHub 实时状态。
- 每次执行上游化、发布验证或退役动作前，应按本文的刷新清单重新核查可能变化的事实。
- 本文不是 ADR：过渡方案可以随上游状态调整，也不引入不可逆的架构决策。

## 目标状态

本仓库是 Temporary Maintenance Fork（临时维护 fork）。目标不是形成独立产品路线，而是在生产依赖的修复被上游接管前提供可验证的过渡版本。

最终状态是：所有仍被生产依赖的 Fork-only Fix（fork 独有修复）均已进入上游或被上游等价实现；消费者已经迁移到上游正式发布包；本仓库完成弃用说明和观察期后归档。

## 已验证快照

最后核查日期：**2026-09-05**

上游：[`langfuse/codex-observability-plugin`](https://github.com/langfuse/codex-observability-plugin)

上游 `main` 在核查时指向 [`1db5c0f`](https://github.com/langfuse/codex-observability-plugin/commit/1db5c0f5ddce569afc112c6476e21d00cf9a482e)。近期合入的发布、版本和插件维护工作表明上游已恢复正常维护，但 Stop-hook 生命周期和缺失 subagent trace 两项生产问题尚未完成收敛。

| 上游事项                                                                                                                      | 核查状态                  | 与本 fork 的关系                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------- |
| [Issue #46：单个 Codex turn 产生重复 trace](https://github.com/langfuse/codex-observability-plugin/issues/46)                 | Open                      | Issue #1 的重复上传侧                                   |
| [PR #71：完成 Stop payload 指定的目标 turn](https://github.com/langfuse/codex-observability-plugin/pull/71)                   | Open、等待上游检查与评审  | Issue #1 的完整上游修复                                 |
| [Issue #12：部分已完成 session 没有 sidecar 或远端 session](https://github.com/langfuse/codex-observability-plugin/issues/12) | Open                      | 可能包含 Issue #1 的最终 turn 丢失侧                    |
| [PR #17：跳过 in-progress turn](https://github.com/langfuse/codex-observability-plugin/pull/17)                               | Open、未合并、存在冲突    | 只阻止提前上传，不能保证最终 turn 被上传                |
| [PR #31：defer incomplete turn](https://github.com/langfuse/codex-observability-plugin/pull/31)                               | Open、未合并、存在冲突    | 同样依赖后续 hook，可能丢失最终 turn                    |
| [PR #50：prevent duplicate turn uploads](https://github.com/langfuse/codex-observability-plugin/pull/50)                      | Open、未合并、存在冲突    | 尚未进入上游主线                                        |
| [Issue #65：defer 后最终 turn 永不上传](https://github.com/langfuse/codex-observability-plugin/issues/65)                     | Closed，但没有关联修复 PR | 作者因尚未完成内部确认而关闭，不能解释为上游已修复      |
| [Issue #44：subagent traces missing](https://github.com/langfuse/codex-observability-plugin/issues/44)                        | Open                      | Issue #2 的上游用户可见症状                             |
| [PR #45：支持 `sub_agent_activity`](https://github.com/langfuse/codex-observability-plugin/pull/45)                           | 已进入当前上游历史        | 未覆盖 parent rollout 缺少 child thread ID event 的场景 |

核查时，上游 `main` 仍会上传 in-progress trailing turn，但只为已经完成的 turn 写 sidecar；Stop-hook 入口也没有使用 payload 中的精确 `turn_id`。因此不能把 Issue #46、PR #17/#31/#50 或已关闭的 Issue #65 解释为 Issue #1 已被上游修复。

## Fork-only Fix 清单

### Issue #1：Stop-hook 最终 turn 与恰好一次交付

本地 Issue：[`tutar/codex-observability-plugin#1`](https://github.com/tutar/codex-observability-plugin/issues/1)，状态为 Closed。

已验证实现：

- [`c9dd85f`](https://github.com/tutar/codex-observability-plugin/commit/c9dd85f7fe9a8528a82cbd9617a996e63cfd9a76)：以 Stop-hook payload 的精确 `turn_id` 作为该 turn 已停止的权威信号；跳过其他 arbitrary incomplete turns；telemetry flush/shutdown 成功后才写 sidecar。
- [`1c99fb4`](https://github.com/tutar/codex-observability-plugin/commit/1c99fb467eff83b51bb296fed9e2cd197ab2e896)：验证实际安装 bundle 的 Stop-hook 路径。
- [生产 Workflow 验证](https://github.com/tutar/codex-observability-plugin/issues/1#issuecomment-5522701991)：最终 root turn 在没有手工 replay 的情况下恰好产生一个 Langfuse trace。

这个修复当前仍未进入上游，是 fork 暂时不能退役的第一个阻断项。

### Issue #2：缺失 parent-side child ID 时的 subagent trace

本地 Issue：[`tutar/codex-observability-plugin#2`](https://github.com/tutar/codex-observability-plugin/issues/2)，已在 2026-09-05 完成实现、部署和真实验证。基础修复提交为 `6d9f7d8`、`8411b8d`；真实 workflow 随后暴露 paginated history 与 trigger/output 竞态，补充修复为 `8b19461`、`b63355c`、`bcccf1c`、`2c3e0e1`。最终本地安装版本为 `0.1.1+codex.20260905075653`。

已确认的问题边界：

- parent rollout 可能包含 `spawn_agent`，但没有 `collab_agent_spawn_end.new_thread_id` 或 `sub_agent_activity.agent_thread_id`。
- child rollout 仍可通过 `session_meta.parent_thread_id` 证明父子关系。
- `followup_task` 会在同一个 child thread 上启动后续 turn；`wait_agent` 只是同步工具，不应被解释为 child turn。
- child rollout 可能重放父线程历史；fallback 不能直接转换整个文件，必须尊重 `subagent_history_start_ordinal`，只处理真实 child turns。

已确认的归属规则：

- 只归属已完成、且能确定关联的 child turn；parent Stop 时仍在运行的 child 不阻塞 parent，可由 child Stop 独立上报。本阶段不引入跨 rollout delivery ledger 或延迟 parent trace。
- event 中的明确 child thread ID 是优先发现证据；metadata fallback 使用 `parent_thread_id`、有效 history boundary，以及 `task_name` / `target` 与 `agent_path` 的唯一匹配。两条路径以 `(child thread ID, child turn ID)` 去重。
- `spawn_agent` 归属该 child 的首个尚未分配 turn；`followup_task` 按顺序归属下一个尚未分配 turn；时间只验证先后关系，不单独用于猜测关联。
- legacy/projected rollout 名称/path 不唯一、缺少 boundary 或其他证据不足时 fail closed，只写 debug 日志；`history_mode: "paginated"` 的 inherited history 由外部 history-base 引用，自身 rollout 可作为 local history。`wait_agent` 不触发归属。
- child turn 继续嵌套在 parent `Codex Turn` root 下。本阶段不改变为 TOOL 子节点，也不扩展 trigger metadata。

Issue #2 必须独立于 Issue #1 设计、实现和提交。它是 fork 退役的第二个阻断项。

## 已确认的执行顺序

### 1. 跟进 Issue #1 的最小上游 PR

已完成：修复已整理为面向上游 0.3.0 的最小 [PR #71](https://github.com/langfuse/codex-observability-plugin/pull/71)，commit 为 [`977f3be`](https://github.com/tutar/codex-observability-plugin/commit/977f3befbb46eb2b392d5e5c6ecf2a820141a1c1)。当前等待上游 CI、评审和维护者反馈。

分支必须直接基于最新 `upstream/main`，不能从包含 `.agents`、fork README、版本历史和 marketplace 差异的 fork `main` 派生。

PR 应包含：

- 只把 Stop payload 精确指定的 `turn_id` 视为 stopped；
- 跳过其他 arbitrary incomplete turns；
- telemetry shutdown/flush 成功后才写 sidecar；
- export/flush 失败时保持可重试；
- 源码测试、hook-level 测试和实际 bundle 路径测试；
- 对上游 Issue #46、#12、#65 和 PR #17、#31、#50 的关系说明。

PR 不应包含：

- fork marketplace 或安装地址；
- fork 版本号；
- `.agents` skills；
- 无关 README 内容；
- Issue #2 的 subagent 发现逻辑。

### 2. 独立处理 Issue #2

Issue #1 PR 提交并建立上游反馈通道后，再处理 Issue #2。

fork 修复已通过 59 项自动化测试和多轮 Standards / Spec 双轴复审后合入生产 `main`。安装后的真实 UI workflow 创建同一 child 的 spawn turn 与 followup turn；最终 Langfuse trace `881347fdd910c900cd0dc1380102922a` 恰好包含两个 `Codex Subagent Turn` 和两个 `LLM Subagent`，输出分别为 `PROBE_ONE`、`PROBE_TWO`。对同一隔离 rollout 再次执行 installed hook 后 trace 数量未增加，sidecar replay 去重通过。下一步从最新 `upstream/main` 整理独立最小 PR 并关联 upstream Issue #44，不把 fork 文档或其他差异带入上游提交。

### 3. 等待上游合并、发布并验证

“上游 PR 已合并”本身还不足以移除 fork。必须等待包含修复的正式发布包，并使用上游 marketplace/package 完成真实 Workflow 验证：

- 最终 root turn 恰好产生一个 trace；
- replay 不产生重复；
- export/flush 失败仍可重试；
- Issue #2 的初始 `spawn_agent` 和 `followup_task` child turns 均正确归属；
- 不把 replayed parent history 当作 subagent turns。

### 4. 迁移消费者并归档 fork

只有所有退役门槛满足后，才执行：

1. 将全部消费者切换到上游 marketplace/package。
2. 在 fork README 顶部标记 deprecated，并链接上游替代版本。
3. 保留一个短观察期；具体时长在正式迁移时根据生产运行频率确定。
4. 将 GitHub repository 设为 archived。

归档保留历史 commit、Issue、release 和生产验证证据；不删除仓库。

## 分支与维护政策

fork `main` 是 Production Baseline（生产基线）：跟踪当前实际部署且经过验证的内容，并与 `origin/main` 共同构成 fork 的远端权威状态。它不承担持续追随上游开发分支的责任。

fork `main` 只接受：

1. 生产当前依赖且尚未被上游吸收的阻断性修复；
2. 已在独立分支完成部署验证、明确决定采用的上游正式版本升级；
3. 迁移、验证和弃用文档。

`upstream/main` 是 Upstream Baseline（上游基线）：通过 fetch 保持可见，用于核查状态和创建上游贡献分支，不定期直接 merge 到 fork `main`。

每个问题使用两条职责不同的交付路径：

- 面向当前部署的修复分支从 fork `main` 创建，验证后可进入 fork `main`；
- 面向上游的最小 PR 分支直接从最新 `upstream/main` 创建，只携带可上游化的修复语义和测试。

不再接受 fork-only 新功能、无关重构或提前设计。

Issue #2 默认在独立分支开发。只有生产立即需要时，才在完整验证后先合入 fork `main`；这不改变后续必须上游化的责任。

## 退役门槛

以下条件必须全部满足：

- [ ] Issue #1 已被上游合并或由上游等价实现。
- [ ] Issue #1 已进入上游正式发布包。
- [ ] Issue #1 已用上游安装包通过真实 Workflow 验证。
- [ ] Issue #2 已被上游合并或由上游等价实现。
- [ ] Issue #2 已进入上游正式发布包。
- [ ] Issue #2 已用上游安装包通过真实 subagent Workflow 验证。
- [ ] 所有已知消费者已经取消 fork pin 并切换到上游。
- [ ] fork README 已标记 deprecated 并指向上游。
- [ ] 观察期内没有发现必须继续依赖 fork 的回归。
- [ ] GitHub repository 已设置为 archived。

任何单项未满足时，都不能宣称 fork 已完成退役。

## 增量刷新清单

以后开始相关工作前，只需依次核查：

1. `git fetch upstream main` 后记录新的 `upstream/main` SHA。
2. 检查上游 Issue #12、#44、#46、#65 的状态和新评论。
3. 检查上游 PR #17、#31、#45、#50、#71 是否关闭、合并、被替代或有维护者反馈。
4. 搜索 `upstream/main` 是否已经使用 Stop payload `turn_id`、跳过非目标 incomplete turns，并在成功 flush 后写 sidecar。
5. 搜索上游是否已经通过 `parent_thread_id` 和 history boundary 处理缺失 child ID 的 subagent rollout。
6. 检查上游 marketplace/package 的正式版本和发布时间，而不只看仓库 manifest 版本。
7. 更新本文的核查日期、状态表、fork-only 清单和退役复选框；保留旧结论的 Git 历史，不在正文累积过期调查过程。

## 当前工作区状态说明

截至本文更新前，Issue #2 的最终代码提交为 `2c3e0e1`，已进入本地 `main` 与 `origin/main`。相关修复分支均已 push。先前用于评估的上游 merge commit `2846d6e` 没有推送，并由本地安全分支 `backup/upstream-merge-20260905` 保留；它不是生产基线。

Issue #1 的上游 PR 使用直接基于 `upstream/main@1db5c0f` 的干净分支 `issue-1-final-turn`，没有改变 fork 的生产基线。
