# 级联补丁说明（agent-team-cascade）

目标包：`@deepseek-ai/dsh-experimental-agent-team@0.1.7-rc.2`
运行入口：该包 `lib/index.js`（`package.json` → `exports["."].default`）
基线快照：本目录 `index.js.orig-0.1.7-rc.2`，SHA-256 = `7E8122ED7AE6723DC5152AF32CC62B592F5C39A36A88DC71F280FD332C815419`

## 目的

让"某个 Team Lead 的 roster 成员"成为**它自己这个新 Team 的 Lead**，从而把 DSH 内置的单层 Agent Teams
自动变成 1–5 层的 Agent 树。信箱、任务板、名单、会话投影与 UI 全部随 `membership.root` 走，因此不需要改它们的实现。

## 门控开关

补丁完全受环境变量 `DSH_AGENT_TEAM_CASCADE` 控制：
- 未设置或 `0` / `false` → **行为与原生完全一致**（可随时安全关闭，无需还原文件）。
- `1` / `true` / `yes` / `on` → 启用级联语义。

补丁同时在 `globalThis.__dshCascadeProbe` 暴露 `{ cascadeEnabled, resolveLeadSelf }` 作为**冒烟测试面**：
这两个函数是纯函数，没有它就无法在没有真实团队的情况下验证补丁行为。

## 已实测的验证证据（2026-10-03）

| 检查 | 命令 | 结果 |
|---|---|---|
| 语法 | `node --check`（副本改名为 `.mjs`） | exit 0 |
| 结构唯一性 | 正则计数 | `async spawnAdmitted` = 1、`async sendAdmitted` = 1、`var TeamRoster = class` = 1、`function resolveActiveMember` = 1、`const queued = await this.journal.transact` = 1 |
| 补丁标记 | 正则计数 | `/* dsh-cascade-patch v1 */` = 1（幂等：重复执行为 no-op） |
| 门控默认 | 导入模块后读探针（**不设**环境变量） | `cascadeEnabled() = true`；`resolveLeadSelf(子)` → 父会话 id；`resolveLeadSelf(顶层)` → 自身 |
| 门控显式关闭 | 同上，`DSH_AGENT_TEAM_CASCADE=0` | `cascadeEnabled() = false`；`resolveLeadSelf(子)` → 子自身（原生单层语义） |
| 无损性 | 逐字节对比 | 原文件仅 2 个非 ASCII 字节（`façade` 的 `ç`），补丁后仍为 2 个，内容一致 |
| 回滚 | `restore-cascade.ps1` | 还原后 SHA-256 回到基线 `7E8122ED…5419` |
| 实机加载 | 重启 DSH Desktop 后查 `harness.log` | **无任何 agent-team 相关错误**，补丁模块正常加载 |

> **门控默认开启的原因**：Windows 上运行中的应用持有启动时的环境块。实测：把 `DSH_AGENT_TEAM_CASCADE=1`
> 写入用户级变量后重启应用，Host 进程里**仍读不到**（启动它的 explorer 缓存了旧环境块）。
> 依赖"必须先设环境变量"会让功能时灵时不灵，故改为**默认开启**，关断用 `restore-cascade.ps1`（还原文件，不依赖环境）。
> 运行时也可用 `DSH_AGENT_TEAM_CASCADE=0` 退出级联，但必须让 Host 以此环境**启动**。

预置补丁后文件 SHA-256 = `7EEA9E345F46EF27463DFDCDAFBB6E8738440491C46E53D203CC185A968CA2A2`。

## 实现补丁时踩过并已修正的三个坑（供未来版本重放参考）

1. **不要在 PowerShell 里做多行字符串替换**：here-string 的行尾符与文件不一致，
   会让替换结果与后一行**粘连**在同一行（表现为 `…required")\t\tconst name = …`）。
2. **不要用"首/末锚点行 + 行号区间"定位**：末锚点若是 `};` 这类多现行，会**吞掉后续的类声明**
   （P0 的 helper 注入曾因此吃掉 `var TeamRoster = class {`）。
3. **锚点块必须覆盖到替换块之后的下一行内容**：否则替换块的最后一行会与原文重复
   （P3 曾因此产生两行 `const queued = await this.journal.transact(…)`）。

当前脚本采用**行序列匹配**：把锚点块与替换块都按行切分、逐行 `Trim()` 比较，
匹配成功即整段替换 —— 既不依赖行尾符，也不会粘连或吞行；同一锚点匹配到多次会直接报错拒改。

## 改动点

### P1 `TeamRoster.tryMembership`（成员即新 root）
原生：当 agent 的父会话是活跃 Lead 且自己是其 roster 成员时，返回 `{root: 父, role: 'teammate'}`。
补丁：级联模式下改为返回自身 `{root: agent, role: 'lead'}`。
原因：`journal.state(root)` 是按 root 各自取投影（`lib/index.js:20-27` 同源逻辑），root 改成自己后，
该 agent 的名单/任务板/信箱/投影自动成为"属于它自己的团队"。

### P2 `resolveActiveMember` 的 `lead` 伪行（我或我的直接上级）
原生：`'lead'` 硬编码解析为 `root.id`（最顶层 Lead）。
补丁：级联模式下引入 `resolveLeadSelf(root)` —— 若 `root.session.header.parentSession` 指向一个活跃 agent，
则 `'lead'` 解析为**该直接上级**，否则解析为 root 自身。
原因：下级必须能 `send_message` 给"我的上级"；一级 Agent 的 `'lead'` 仍是它自己。

### P3 向上消息的信箱路由（唯一需要小心的一处）
原生 `TeamMailbox.sendAdmitted`：把消息写进**调用者所属 root 的日志**。
补丁：级联模式下若解析出的目标是调用者的**直接上级**（即目标不属于调用者自己的 roster），
则把 `team/message/queued` 写入**目标自己的日志**，并把 sender 归属解析到目标团队。
原因：消息必须落在**接收方自己的**团队日志里，接收方才能在 `recoverFor` 中取到它；否则消息会永久滞留在
调用者日志中而无人认领。

### P4 `spawnAdmitted` 的上级归属校验
原生：`membership.role !== 'lead'` 抛 `TEAM_LEAD_REQUIRED`；无"直接上级"校验。
补丁（级联模式下）：保持 role 检查（补丁后所有 roster 成员的 role 都是 `lead`），并新增：
新建 child 的 `parentSession` 必须等于调用者自身 → 防止跳级建人。
说明：原生代码本就用 `parent: root`（root 即调用者自身）建 child，因此该校验是"防回归断言"而非行为改变。

### 不需要改动的地方（已核实）
- `TeamTaskBoard`（`create/get/list/update`）：全部以 `membership.root` 为日志所有者 → 自动分层。
- `TeamJournal.state/transact/appendAndFlush`：以传入的 root 为准 → 自动分层。
- `TeamActivity` / `teamProjectionDefinition`：按 TeamId（= root session id）分区 → 自动分层。
- `recoverFor` / `reconcileProvisioning`：收敛 provisioning 态的逻辑与层数无关。

## 已知约束

1. **子代理递归深度**由 `@deepseek-ai/dsh-subagent` 的 `maxDepth`（默认 **1**）与 `maxActiveSubagents`（默认 **8**）限制。
   本补丁不改变它们；需要在组合包 patch 里覆盖（见主方案附录 A.4）。**不覆盖则第 2 层建不出来。**
2. **每个 teammate 的角色（skills / MCP / Agent.md / 模型 / 工作目录）**仍由上游 `SpawnTeammateRequest` 决定，
   它没有这些字段。这部分由增量插件 `dsh-task-agent-kit` 通过 Agent Preset 解决（主方案附录 A.5），**不属于本补丁**。
3. **`subagentDescriptor` 判定**：非 team 的普通子代理（provider 管理的一次性 worker）在原生逻辑里被排除在 Team 之外；
   本补丁保持该排除，不把普通 subagent 拉进树。

## 回滚

`restore-cascade.ps1` 从 `.bak-*` 还原 `index.js`；或在未还原的情况下把 `DSH_AGENT_TEAM_CASCADE` 置为 `0`。

### P6 同级消息的信箱路由（与 P3 合并实现）

原生（含 P1–P5）：每个成员是**自己团队**的 root，其 roster 只含**自己的孩子**；**同级彼此不在对方名册里**，
因此 A 给同级 B 发消息会抛 `active teammate "B" not found`。**但同级直连是产品要求（Q7 必须）。**

补丁：在 `TeamMailbox.sendAdmitted` 里把已有的"跨团队路由"从**仅向上**推广到**同级**，三种形态统一处理：

| 目标 | 解析方式 | 消息写入 |
|---|---|---|
| `"lead"` | 直接上级（P2 的 `resolveLeadSelf`） | **上级自己的日志**（P3 原有行为） |
| 不在**我的**名册、但在**上级**名册里的名字 | 上级名册里的同名活跃成员 = 我的**同级** | **该同级自己的日志**（`targetId` = 它自己 id） |
| 其他（我的孩子 / 独立团队） | `resolveActiveMember(root, state, name)` | 不变（原生单团队语义） |

**为什么必须写进接收方自己的日志**：派发/认领走 `recoverFor`，它只扫**该成员自己 root** 的日志。
写进调用者日志会让消息永久滞留、无人认领（与 P3 同一原因）。

**同级双方名册互不可见**（P1 的必然结果），因此：
- 目标解析借道**上级名册**（它知道全部孩子）；
- 发送者名字也从**上级名册**取真名并写入 `membership.name`——否则 P5 的回退会让消息署名 "lead"，
  收件人无法知道是谁发的（这是 P6 里最容易漏的一处）。

**未改动的部分**：`journal.transact/appendAndFlush`、`tryDispatch`、`TeamTaskBoard`、投影——全部以
`root`（此处=接收方）为准，自动落在接收方的团队日志里。

### 已知遗留（不影响功能）

- `apply-cascade.ps1` 的 P3 锚点会**重复插入一行注释**（`/** Queue and dispatch … */` 出现两次）。
  这是 patch.md 已记录的"锚点块未覆盖到替换块之后下一行"的历史遗留，**纯注释、无行为影响**，本轮未改动以免重新推导锚点。
- `verify-cascade.ps1` 的期望模式已随 P6 同步（`upwardTarget` → `routedTarget`）。