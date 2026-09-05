# Codex Observability

本仓库把 Codex rollout 中已经确定的会话、轮次与协作关系转换为可观测 trace，同时避免把不确定的关系伪装成事实。

## Language

**Parent Thread（父线程）**：
发起协作动作并拥有顶层 turn 的 Codex thread。父线程拥有协作意图，但不拥有子线程的本地历史。
_Avoid_: Main agent, root session

**Child Thread（子线程）**：
由另一个 thread 发起、且 metadata 明确声明其 parent 的 Codex thread。子线程拥有自己的本地 turn 和投影历史边界。
_Avoid_: Nested session, worker file

**Child Turn（子代理轮次）**：
Child Thread 中属于该子线程本地历史的一次已完成 turn。它可以归属于 Parent Thread 中一个确定的协作触发动作。
_Avoid_: Entire child rollout, subagent session

**Collaboration Trigger（协作触发动作）**：
Parent Turn 中会启动 Child Turn 的 `spawn_agent` 或 `followup_task` 调用；`wait_agent` 只是等待，不是触发动作。触发动作拥有父侧的协作意图，Child Turn 拥有实际执行结果。
_Avoid_: Any collaboration tool call, wait event

**Projected History Boundary（投影历史边界）**：
legacy/projected Child Thread metadata 声明的第一个本地 rollout ordinal；更早的记录属于继承的父历史，不是 Child Turn。Paginated History（分页历史）通过外部 history-base 引用继承内容，其自身 rollout 只保存本地记录，因此不需要该 boundary。
_Avoid_: Array offset, spawn timestamp

**Attribution（归属）**：
把一个已完成 Child Turn 关联到唯一 Collaboration Trigger 的事实关系。无法由 thread parent、投影边界和唯一 agent path 确定时，该关系保持未知。
_Avoid_: Time-based guess, best-effort nesting

**Discovery Evidence（发现证据）**：
用于定位 Child Thread 的可靠标识；父事件中的明确 thread ID 优先，child metadata 是缺少该事件时的 fallback。两条路径发现同一 Child Turn 时仍是同一事实。
_Avoid_: Duplicate source, heuristic match
