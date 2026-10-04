# dsh-task-agent-kit

> 为 **DeepSeek Harness (DSH)** 提供「**一个任务 = 一棵 1–5 层 Agent 树**」：源 agent 路径下的每个角色文件夹都会变成一个可选的 Agent，一级 Agent 拆解并派发给下级，下级遇疑可反向询问上级，全程有一个「Agent 观察室」俯瞰并可切进任一层的独立会话。

作者：**ZDH4869**　许可证：**MIT**

---

## 一、它做了什么

| 能力 | 说明 |
|---|---|
| **角色即 Agent** | 源 agent 路径下的每个一级文件夹（含 `Agent.md` 等角色标记）自动注册为一个 Agent preset：`Agent.md` 成为该会话的人格提示词，`.skills/` 挂载进技能列表，`.mcp/mcp.json` 的 MCP 服务器接入 |
| **三种创建对话方式** | ①原生工作区对话（完全未改动上游链路）②工作区 + 选一个角色 Agent 建对话 ③工作区 + 子 Agent |
| **「添加任务 agent」层级面板** | 新建对话页 hero 区的按钮 → 浮层模态：设定 **1–5 层级** + 每层勾选具体角色（默认 4 列卡片）+「重置」「完成」 |
| **Agent 观察室** | 整页九宫格（3×3 / 4×4 / 5×5 可切）、翻页、右上角刷新、**「仅活动」**开关（不臆造状态：无法判定就显示为空闲）、点卡片即以该角色开一个新会话 |
| **会话头部层级芯片** | 配置过的对话，头部显示「任务 agent · N 层」，**悬停即列出各层级与所选角色名** |
| **公共资源目录** | 配置 `sharedRoots` 后，其 `.skills` 会**追加进每一个角色预设**的技能目录、其 `.mcp/mcp.json` 会合并进每一个角色预设——**放一次，所有 agent（含未来新建的）都能用** |
| **角色脚手架工具** | 模型可见工具 `create_task_agent_role`：按层级模板生成角色文件夹骨架（`Agent.md` / `agent.json` / `.mcp` / `.skills` / `log` / `markdown` / `open_project`），支持 dry-run 与重名保护 |
| **设置页入口** | 设置 → 模型：新增「源 agent 路径」行（浏览 / 清除 / 保存，**保存后立即重扫，无需重启**） |
| **文档同步器** | `tools/sync-agent-docs.mjs`：扫描磁盘实况，重写每个 agent `Agent.md` 里的资源清单段（功能作用 / 全部 skills / MCP / 应用项目 / 日志位置）——幂等、可审、有备份 |

## 二、环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| DSH Desktop | **≥ 0.2.0-rc.1**（`peerDependencies` 声明） | 声明依据是新版客户端包名（`dsh-client-runtime` / `dsh-client-ui-slots` / `dsh-host-webserver`）。**注意：见 §七 兼容性现状** |
| Node.js | ≥ 20 | 宿主半使用了 `structuredClone`、`node:fs/promises` |
| React | 18.x | 客户端半从浏览器模块表取 React，不自行安装 |
| 多层级派发（可选） | `@deepseek-ai/dsh-experimental-agent-team` / `-tool-agent-team` / `-client-ui-agent-team` | 见 §四；缺失时本插件仍可用（只是没有 `spawn_teammate` 那套工具） |

## 三、安装

```powershell
# 方式一：从 GitHub 直接装（DSH 会 clone 到 profile 的 generations 里）
plugin_manager install_bundle  target: https://github.com/ZDH4869/dsh-task-agent-kit

# 方式二：从本地目录装（开发时推荐）
plugin_manager install_bundle  target: D:\DSH_desktop\dsh-task-agent-kit
```

安装后按需在 profile 的 `cordis.patch.yml`（用户层）写配置——**用户层覆盖 bundle 默认值**：

```yaml
- id: task-agent-kit
  name: 'dsh-task-agent-kit'
  config:
    sourceAgentPath: 'D:\DSH_desktop\Agents'          # 角色池根目录
    sharedRoots:                                       # 公共资源（所有 agent 共享）
      - 'D:\DSH_desktop\common_project'
    roleTemplateDir: 'D:\DSH_desktop\Agents\_templates' # 建角色用的层级模板
    statusFile: 'D:\DSH_desktop\dsh-ext\task-agent-kit\.state\roster.json'  # 运行结果落盘，便于排查
```

## 四、启用多层级派发（可选，独立一步）

`spawn_teammate` / `team_task_*` 由 **Agent Teams** 系列包提供。把这些包的启用层追加到 **profile** 的 `cordis.patch.yml`：

```
把本仓库 cordis.team.patch.yml 的内容追加到
C:\Users\<你>\AppData\Roaming\dsh-desktop\harness\profiles\<profile>\cordis.patch.yml
```

**不要**同时启用 `@deepseek-ai/dsh-experimental-agent-team-profile`——它会插入相同的行 id，重复插入会在启动时被拒绝。

**⚠️ 级联补丁（多层级）**：上游 `dsh-experimental-agent-team` 默认只允许 **一层**委派（`maxDepth: 1`，且只有 Team Lead 能创建成员）。要让"下级再创建下级"成立，需要对该包打补丁：

```powershell
# 1) 先解除 subagent 的深度上限（profile 的 cordis.patch.yml）
#    - id: subagent
#      name: '@deepseek-ai/dsh-subagent'
#      config: { maxDepth: 4, maxActiveSubagents: 8 }

# 2) 打级联补丁（6 个改动点 P0–P5，幂等、可整体回退）
& .\install\apply-cascade.ps1
& .\install\verify-cascade.ps1     # 只读自检
& .\install\restore-cascade.ps1    # 一键回退到原始文件
```

补丁详情与版本基线见 `install/patch.md` 与 `patches/`。

## 五、使用

**创建角色**（两种方式）：

1. **对 agent 说人话**：「帮我建一个叫『数据分析』的角色，末级执行，负责取数做报表」→ 触发 `create_task_agent_role`；
2. **手工**：在 `sourceAgentPath` 下建文件夹 + 写非空的 `Agent.md`（可复制 `Agents\_templates\` 里的层级模板）。

> **角色标记**：`Agent.md` / `AGENTS.md` / `CLAUDE.md` / `agent.json` 任一即可；**空文件会被识别但拒绝注册**。资源目录（`log`、`markdown`…）不会被当成角色。

**角色文件夹约定**：

```
<角色名>\
├─ Agent.md          ← 角色提示词（必有、非空）
├─ agent.json        ← 显示名 / 描述 / 层级（建议）
├─ .skills\          ← 该角色专属技能（<技能名>\SKILL.md）
├─ .mcp\mcp.json     ← 该角色专属 MCP 服务器
├─ markdown\         ← 本地知识库（按路径读，不注册为技能）
├─ open_project\     ← 参考资料 / 应用项目 / 本地 MCP 源码
│   ├─ mcp\
│   └─ project\
└─ log\              ← 任务日志（YYYY-MM-DD-任务简称.md，五类必填字段）
```

**新增公共资源后**，跑一次同步器让所有 agent 的文档跟上：

```powershell
node "D:\DSH_desktop\dsh-task-agent-kit\tools\sync-agent-docs.mjs" [agentsRoot] [sharedRoot]
```

## 六、配置项（Host 半 `Config`）

| 字段 | 默认 | 作用 |
|---|---|---|
| `sourceAgentPath` | `''` | 角色池根目录（**volatile**，可在设置页读写） |
| `basePresetId` | `''` | 克隆哪个基础 preset 的行（空 = 当前默认 preset） |
| `skillDirCandidates` | `['.skills','.agents/skills','skills']` | 角色技能目录候选名 |
| `rolePromptCandidates` | `['Agent.md','AGENTS.md','CLAUDE.md']` | 角色标记文件候选名 |
| `mcpFileCandidates` | `['mcp.json','.mcp.json','.mcp/mcp.json','.mcp/servers.json','mcp.yml','mcp.yaml']` | 角色 MCP 配置候选 |
| `presetIdPrefix` | `taskagent` | 生成 preset id 的前缀（UI 按前缀筛选角色） |
| `allowEmptyPrompt` | `false` | 是否允许空提示词的角色注册（不建议开启） |
| `pruneStaleRoles` | `true` | 角色文件夹消失后注销其 preset |
| `allowOverwrite` | `false` | 脚手架工具是否允许覆盖同名角色文件夹 |
| `roleTemplateDir` | `''` | 层级模板目录 |
| `statusFile` | `''` | 运行结果（角色清单/失败原因/drift）落盘的 JSON 路径 |
| `sharedRoots` | `[]` | 公共资源根；其 `.skills` 与 `.mcp/mcp.json` 注入**每个**角色预设 |

## 七、兼容性现状（**请务必先读**）

本节是**实测事实**，不是承诺：

| 项 | 状态 |
|---|---|
| **DSH 0.1.7-rc.2**（本插件的开发与验证环境） | ✅ **已实测**：角色注册、设置行、层级面板、观察室、三层级联、名单/任务板隔离、向上汇报通道，均有真实运行时证据；**60/60 自检通过**（含用应用自带真 React 18.3.1 + jsdom 的真实渲染与点击） |
| **DSH ≥ 0.2.0-rc.1** | ⚠️ **仅声明，未验证**。开发机未安装 0.2.x，因此 **0.2.x 上能否运行尚属未知**。已声明 `peerDependencies`，并把版本敏感点收敛到少数位置，便于升级后快速定位 |

**升级到 0.2.x 后的自查清单**（升级后请按序执行）：

1. `plugin_manager install_bundle` → 看 `application` 字段是否为 `applied`；
2. 看 `harness.log` 是否有 `did not activate`；
3. 打开浏览器控制台，确认没有 `slot entry crashed in '<slot>'`；
4. 观察室 / 层级面板 / 设置行 三个界面是否出现；
5. `node tools/e2e-check.mjs` → 角色池是否全部 OK；
6. `& .\install\verify-cascade.ps1` → 级联补丁与团队行是否仍在（**升级可能使补丁失效，需按新版重做**）。

**版本敏感点集中在这几处**（升级后优先看这里）：

- `client.js`：`ctx.slots.*`（槽位注册 / `inject`）、`ctx.remote.*`（远端返回**结果信封** `{ok,value,error}`）、`ctx.configForms`（设置值读取）、`ctx.layout.selectPanel`、`ctx.uiWorkspace`、标准 props `useWorkspaces` / `useSessions`；
- `index.js`：`ctx.agentPresets.register/list/compositionInventory`、`ctx.tools.register` + `defineTool`、`settings/document-updated` 事件；
- `package.json` 的 `dsh.client.inject`：客户端包名若在 0.2.x 改名，**只改这一处**。

## 八、验证

```powershell
npm test            # 60 项自检（6 个测试文件）
npm run check       # 端到端角色池校验（识别哪些文件夹成为角色、哪些被跳过）
npm run dry-run     # 只报计划不写盘
npm run sync-docs   # 同步所有 agent 的 Agent.md 资源清单
```

## 九、已知限制

- **级联补丁是对随发行包的猴子补丁**，不是依赖。**每次升级 DSH 都必须重新适配**（补丁脚本会校验基线哈希并拒绝在未知版本上盲打）。
- 观察室的「工作中/空闲中」只在 shell 提供会话摘要时才是真实的；**无法判定时显示为空闲，绝不臆造状态**。
- 可见文案目前是中文硬编码，**未接入客户端 locale 服务**。
- 只做了源码部署的第三方应用项目（如 VoiceStudio / OpenMAIC）**不包含依赖安装**，需要时自行按其文档安装。
- **记忆注入最多滞后 30 秒**：`systemPrompt.context({ text })` 是**同步**的，不能在组装时读文件，因此靠内存缓存，按 30 秒定时器刷新。

## 九之二、改这个插件时必须遵守的三条硬规则（都是踩过的坑）

> 这三条各自都**真实导致过 DSH 启动失败或界面异常**，改动 `index.js` / `client.js` 前请先读。

**规则 1｜`apply()` 内绝不 await 会重建 Loader 的操作。**
`settings.update()` → `configEditor.edit()` → `hmr.runExclusive()` → `ctx.loader.await()`，而启动期 Loader 正在等你的 `apply()` 返回 → **死锁到 100 秒超时**，应用停在启动页。写入必须延后到 Loader settle 之后（见 `publishAfterBoot`），并经 `outsideHmrTransaction`。

**规则 2｜不得直读未在 `inject` 里声明的服务。**
Cordis 下 `ctx.systemPrompt` 这种访问**本身就会抛** `cannot get property "systemPrompt" without inject`，`ctx.systemPrompt?.method` 这样的可选链**挡不住**。要么加进 `export const inject = [...]`，要么用可选访问 `ctx.get('systemPrompt')`（本插件对 `settings` / `hmr` / `systemPrompt` 一律如此）。

**规则 3｜不要把 `--dsw-alias-brand-primary` 当按钮底色。**
深色主题下这个 token **本身就是近白色**，按钮会变成白块。主按钮用 `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground` 这一对（照宿主 `dsh-client-ui-primitives/lib/Button.module.css`），次级按钮用 `transparent` + `--dsw-alias-border-l3`。

**另外两条安装/调试经验**：

- 插件**装到哪个 profile**取决于应用当前状态：应用降级到安全模式时，`plugin_manager` 会作用在 `desktop-safe-mode` 上，**修不到 `web`**。判断方法：日志路径里出现 `desktop-safe-mode`，或输出是 `link:` + `✓ Already up to date`（而非 `generation-install: promoted to …`）。
- 测试桩是普通对象，读缺失属性只得到 `undefined`；**真实 Cordis 会抛**。所以"未声明服务直读"这类 bug 只有**把 `ctx.X` 定义成一读就抛的 getter**的测试才能拦住（见 `test/host-apply.test.mjs` 的「apply survives a service that throws on property access」）。

## 十、目录结构

```
dsh-task-agent-kit/
├─ index.js              宿主半：扫描角色 → 注册/注销 Agent preset；注册建角色工具
├─ client.js             客户端半：观察室面板、侧栏字形、hero 触发器、层级浮层、设置行、会话头部芯片
├─ src/
│   ├─ source-agent-registry.js   角色/技能/MCP 扫描
│   ├─ role-preset.js             角色预设组装（人格、技能目录、MCP、公共资源）
│   └─ role-scaffold.js           角色骨架生成
├─ tools/                e2e-check / dry-run / gen-preset-base / sync-agent-docs
├─ test/                 60 项自检（registry / host-apply / client-contract / client-runtime / client-render / role-scaffold）
├─ install/              级联补丁脚本（apply / restore / verify）与 patch.md
├─ patches/              级联补丁的原始文件快照与哈希基线
├─ cordis.patch.yml      本插件的行（发布默认值）
└─ cordis.team.patch.yml 可选的 Agent Teams 启用层（须追加到 profile 补丁）
```

## 十之二、随附角色池（`D:\DSH_desktop\Agents`）

本插件随附的角色池实况（由 `npm run sync-docs` 扫描磁盘生成，含用于验证的 **`测试`** 角色）：

| 角色 | 专属技能 | MCP | 应用项目 |
|---|---:|---:|---:|
| CAE | 0 | 1（abaqus） | 0 |
| PPT制作 | 1 | 0 | 3 |
| 子Agent举例 | 0 | 0 | 0 |
| 新媒体视频 | 1 | 0 | 2 |
| 日常使用 | 30 | 0 | 1 |
| **测试** | 0 | 0 | 0 |
| 科研论文 | 177 | 0 | 0 |
| 编程开发 | 3 | 0 | 3 |

共 **8 个角色**。`Agents\_templates` 不是角色（无角色标记），**会被扫描静默跳过**——与 `npm run check` 的输出一致。
新增角色只需在建好文件夹后跑一次 `npm run sync-docs`，本表随各角色 `Agent.md` 的资源清单一起刷新。
## 十一、致谢与许可

- 依赖 DSH 的 Cordis 插件体系；多层级派发能力建立在 `@deepseek-ai/dsh-experimental-agent-team` 之上。
- 采用 **MIT** 许可证，见 [LICENSE](./LICENSE)。
