# 交给 Agent 执行：安装 dsh-task-agent-kit

> **使用方法**：把本文件整份复制给你的 DSH agent，然后说一句「按这个文件执行」。
> 本文件是**可执行指令**，不是介绍文档。请逐步执行、每步验证、失败就停下报告，不要跳步、不要"一次性全开"。
>
> 目标：在**当前这台机器**的 DSH 里装好 `dsh-task-agent-kit`，让它提供的
> **多层级任务 Agent 树**（角色即 Agent、1–5 层级派发、Agent 观察室、层级配置弹窗、公共资源目录）可用。

---

## 0. 先探查环境（**务必先做，路径因机器而异**）

```powershell
# 0.1 DSH Desktop 安装目录（含 app.asar.unpacked）
$app = 'D:\DSH_desktop\deepseek_harness_desktop\DSH Desktop'      # ← 改成这台机器的实际路径
Test-Path "$app\resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh\package.json"

# 0.2 Harness 版本（插件兼容性以它为准，不是桌面端版本号）
(Get-Content "$app\resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh\package.json" -Raw | ConvertFrom-Json).version

# 0.3 当前 profile 与其目录
$env:DSH_PROFILE          # 例如 web
$env:DSH_PROFILE_DIR      # 例如 C:\Users\<你>\AppData\Roaming\dsh-desktop\harness\profiles\web

# 0.4 已安装了哪些 bundle
(Get-Content "$env:DSH_PROFILE_DIR\package.json" -Raw | ConvertFrom-Json).dsh.profile.bundles

# 0.5 该 Harness 是否随包提供 Agent Teams（多层级派发依赖它）
foreach ($p in 'dsh-experimental-agent-team','dsh-experimental-tool-agent-team','dsh-experimental-client-ui-agent-team') {
  "$p : " + (Test-Path "$app\resources\app.asar.unpacked\node_modules\@deepseek-ai\$p\package.json")
}
```

**记录 0.2 的版本号**——后面所有兼容性判断都以它为准。

---

## 1. 安装插件

```powershell
# 本仓库所在目录（改成实际路径）
$kit = '<本文件所在目录>'          # 例如 D:\DSH_desktop\dsh-task-agent-kit\dsh-task-agent
plugin_manager install_bundle  target: $kit
```

**判据（必须看返回的 `application` 字段）**：

| 返回 | 含义 | 下一步 |
|---|---|---|
| `applied` | 已生效 | 继续第 2 步 |
| `restart-required` | 需重启 | 重启 DSH Desktop 后继续 |
| 报错 / 未出现该字段 | 安装失败 | **停下**，把完整错误原文报告给用户 |

> 注：若 `plugin_manager` 提示 `peerDependencies` 不匹配，先别用版本豁免——把告警原文报告给用户，
> 由用户决定是否升级 Harness。

---

## 2. 写配置（用户层，覆盖 bundle 默认值）

编辑 `$env:DSH_PROFILE_DIR\cordis.patch.yml`，加入（若已存在同 id 行则改它）：

```yaml
- id: task-agent-kit
  name: 'dsh-task-agent-kit'
  config:
    sourceAgentPath: 'D:\DSH_desktop\Agents'            # 角色池根目录，改成实际路径
    sharedRoots:                                         # 公共资源（所有 agent 共享）
      - 'D:\DSH_desktop\common_project'
    roleTemplateDir: 'D:\DSH_desktop\Agents\_templates'  # 建角色用的层级模板（可留空）
    statusFile: 'D:\DSH_desktop\dsh-ext\task-agent-kit\.state\roster.json'   # 运行结果落盘，强烈建议填
```

**判据**：保存后**不必重启**（该字段是 volatile，插件会监听 `settings/document-updated` 自动重扫）。
读 `statusFile` 指向的 JSON，应看到 `registered` 数组里列出识别到的角色。

---

## 3. 可选：启用多层级派发（`spawn_teammate` / `team_task_*`）

**仅当 0.5 步显示三个 `dsh-experimental-*` 包都存在时**才做这一步。

1. 把本仓库 `cordis.team.patch.yml` 的内容**追加**到 `$env:DSH_PROFILE_DIR\cordis.patch.yml`；
2. 同时**解除子代理深度上限**（上游默认只允许 1 层）：

```yaml
- id: subagent
  name: '@deepseek-ai/dsh-subagent'
  config:
    maxDepth: 4
    maxActiveSubagents: 8
```

3. **不要**同时启用 `@deepseek-ai/dsh-experimental-agent-team-profile`——它会插入相同行 id，重复插入会被拒绝。

### 3b. 级联补丁（让"下级也能创建下级"）

上游 `dsh-experimental-agent-team` 默认只有 Team Lead 能创建成员，所以**第 3 层建立不起来**。需要打补丁：

```powershell
& "$kit\install\verify-cascade.ps1"      # 先只读自检：看基线哈希是否匹配
& "$kit\install\apply-cascade.ps1"       # 匹配才打；不匹配会拒绝
& "$kit\install\restore-cascade.ps1"     # 需要时一键回退
```

**⚠️ 关键**：补丁脚本绑定 **0.1.7-rc.2 的基线哈希**。若 `verify-cascade.ps1` 报"unknown build"，
说明这台机器的该包版本不同，**不要强行打**——把
`<app>\...\@deepseek-ai\dsh-experimental-agent-team\lib\index.js` 的路径与版本报告给用户，
按 `install/patch.md` 记录的 6 个改动点在新版本上重做。

---

## 4. 验证（逐项，任何一项失败都停下报告）

```powershell
# 4.1 插件自检（60 项）
cd $kit ; npm test

# 4.2 角色池端到端
node "$kit\tools\e2e-check.mjs"

# 4.3 运行日志有无激活失败
Select-String -Path "$env:USERPROFILE\..\AppData\Roaming\dsh-desktop\logs\harness.log" -Pattern 'did not activate|plugin failures|compatibility warning' | Select-Object -Last 10

# 4.4 合成结果里角色行与团队行
node "$app\resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile $env:DSH_PROFILE --dump-config | Select-String 'task-agent-kit|agent-team|tool-subagent'
```

**界面自查（需人工或浏览器工具）**：

1. 左侧栏有 **▦** 面板字形 → 点开是「Agent 观察室」（九宫格、显示方式、翻页、「仅活动」）；
2. 新建对话页 hero 区有 **「＋ 添加任务 agent」** → 点开是层级配置浮层（1–5 层级 + 角色卡片 + 重置/完成）；
3. 设置 → 模型 底部有 **「源 agent 路径」** 行（浏览 / 清除），且能保存并在状态行看到 `目录 <实际路径>`；
4. 浏览器控制台**没有** `slot entry crashed in '<slot>'`。

---

## 5. 故障处理

| 现象 | 处理 |
|---|---|
| 启动后进入 **安全模式**（`safe mode: third-party web profile bundles are blocked`） | 说明某插件让启动失败。**先停用最近装的插件**，把 `harness.log` 里 `did not activate` / `TypeError` 的原文报告给用户 |
| `slot entry crashed in '<slot>'` | 客户端半渲染抛错。把控制台原文报告给用户 |
| 角色卡片为空 | 读 `statusFile`：`failures` 里会写明原因（常见：`Agent.md` 为空、`sourceAgentPath` 未配） |
| `spawn_teammate` 不存在 | 第 3 步没做，或三个 `dsh-experimental-*` 包不存在 |
| 第 3 层创建失败 `TEAM_LEAD_REQUIRED` | 级联补丁没打（见 3b） |
| 设置行报"settings namespace … not offered" | 客户端读设置走的是 `configForms` 镜像；把该行文字报告给用户 |

---

## 6. 严禁事项

- **不要一次装齐所有插件**：逐个装、逐个验证，否则失败无法归因；
- **不要在未知版本上强行打级联补丁**（脚本会拒绝，这是保护）；
- **不要同时启用** `agent-team-profile` 与本插件的团队层；
- **不要**用版本豁免绕过 `peerDependencies` 检查（可能崩溃/丢数据，需用户明确授权）；
- **不要**改 `sourceAgentPath` 之外的角色文件夹内容来"让扫描通过"。

---

## 7. 完成判据（全部满足才算成功）

- [ ] `plugin_manager install_bundle` 返回 `application: applied`（或重启后生效）
- [ ] `statusFile` 里 `registered` 列出的角色数与磁盘上的角色文件夹数一致
- [ ] `npm test` → 60 项全通过
- [ ] `e2e-check` → 所有角色 `OK`
- [ ] 观察室、层级面板、设置行**三个界面都出现**
- [ ] 浏览器控制台无 `slot entry crashed`
- [ ] （可选）`spawn_teammate` 存在且三级树可建立、任务板按层隔离、向上汇报可达直接上级

**最后把结果如实回报**：哪些通过、哪些失败、失败项的**原文错误**，以及这台机器的 Harness 版本。
不要替用户判断"应该没问题"。
