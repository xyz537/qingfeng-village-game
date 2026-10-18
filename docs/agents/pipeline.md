# Codex + DSH 单次开发流水线

本目录实现 Issue #3 批准的单次开发流水线：DSH 实现并自测，Codex 独立验收，发布代理负责 GitHub 写入。
控制器是可信的固定版本 Node 工具；模型与仓库测试子进程都不继承 GitHub 凭据。

## 组件

| 文件 | 职责 |
| --- | --- |
| `cli.mjs` | `doctor`、`run --issue N`、`status --issue N`、`export-logs --issue N` |
| `config.mjs` | `loadLocalConfig(path)`：严格校验本机路径、workerId、Profile、超时、`maxFixRetries=2`，拒绝配置里的密钥 |
| `github.mjs` | 通过可配置 argv 的外部 `gh` 凭据代理访问 GitHub；原子创建领取 ref、状态记录、幂等查建 PR；无 merge API；不执行 Issue 命令文本 |
| `workspaces.mjs` | `acquireTaskWorkspace(task)`：独立分支、独立 clone 工作区、按真实路径的排他锁；拒绝 main/master、非独立根目录、脏工作目录 |
| `dsh.mjs` | `runDsh` 语义：UTF-8 stdin、JSONL stdout、stderr、退出码、超时、session ID；`shell:false`、`windowsHide:true`；prompt 只通过 spawn 契约写入 stdin 一次（`spawnProcess({stdin})`），不再二次 `writeStdin`；模型密钥来自外部 `credentialCommand` 并只注入精确命名 env |
| `review.mjs` | 独立只读审查工作区、固定命令复跑、Codex JSONL + strict output-schema；先核验 base/head，绝不把 exit 0 当通过 |
| `runner.mjs` | `runTask(issueNumber)`：状态机、持久 attempt/fixRetries、首次实现 + 最多两轮修复、通过后 `awaiting-merge`，不关 Issue、不合并 |
| `logs.mjs` | 本机完整记录与去敏导出；远端只共享摘要与去敏记录链接引用 |
| `schemas/` | `task.schema.json`、`review.schema.json` 严格字段与类型；`review.schema.json` 完全满足 Codex strict Structured Outputs：每个对象在任意深度都把全部属性列进 `required` 且 `additionalProperties:false`，缺省细节用 `""` / `0` 占位 |
| `templates/` | 固定提示 `implement.md`、`review.md`，Issue 文本只作为数据代入，不拼 shell |
| `pipeline.test.mjs` | Node 内置测试；外部进程/远端调用全部可注入，测试真实状态机行为 |

## 依赖注入

`runner.runTask(issueNumber, deps)` 要求显式注入以下适配器，缺一即 `AdapterError`：

- `config`：`loadLocalConfig` 的结果
- `github`：`getIssue`、`commitExists`、`acquireClaim`、`ownerOfClaim`、`readStatus`、`writeStatus`、`listPulls`、`createPull`、`probe`
- `workspaces`：`acquire`、`inspect`、`isAncestor`、`commitAll`、`changedFiles`、`release`
- `dsh`：`drive`（可选 `readModelKey`、`buildEnv`、`dispose`）
- `tests`：`run`（默认 `createTestRunner()`：固定命令、去敏 env、无模型密钥）
- `review`：`review`（可选 `dispose`）
- `publish`：`pushBranch`、`ensurePullRequest`（可选 `pushLogs`）
- 可选：`logs`、`env`、`runId`、`now`

生产环境用 `createDefaultAdapters({ config })` 装配真实适配器；测试注入内存适配器即可离线确定性运行。

## 本地运行

```
# 1. 复制并填写本机配置（不要提交）
copy .pipeline\config.example.json .pipeline\config.json

# 2. 自检本机环境
node tools\pipeline\cli.mjs doctor

# 3. 执行任务（需要已批准清单的 Issue）
node tools\pipeline\cli.mjs run --issue 3

# 4. 查看本地持久状态
node tools\pipeline\cli.mjs status --issue 3

# 5. 导出本机去敏日志
node tools\pipeline\cli.mjs export-logs --issue 3
```

退出码：`0` 成功（run 达到 `awaiting-merge`），`1` 失败/blocked，`2` 用法错误。

## 状态机

```
read issue -> validate manifest -> verify baseSha exists -> atomic claim
  -> exclusive local workspace
  -> [implement -> selftest -> scope/head check -> publish exact branch + one Draft PR
      -> independent review of that published head]
  -> awaiting-merge
```

- 领取：GitHub 原子创建 `refs/heads/automation/claim/issue-N`，提交内容含 `workerId/runId/specDigest/baseSha`。
  两台机器只有一个创建成功；重复轮询不会让新 worker 通过同名标签抢任务。
- 领取失联：fail closed。人工确认旧进程停止后，才可用同 `workerId` 复跑（同一把锁也会阻止双开）。
- 持久化：本地 `workspaces/state/issue-N.json` 记录 `specDigest/attempt/fixRetries/phase/headSha/pull`；
  `automation/status/issue-N` 分支保存远端状态。重启或第二台机器不会清零重试次数。
- 发布顺序：DSH 自测通过且改动在允许范围内后，先按精确 `headSha` 推送业务分支并幂等查建**一个** Draft PR，
  然后才做独立验收。验收绑定该 PR 的精确 head；修复轮重新推送同一分支并复用同一个 PR，不建重复 PR、不强推。
- 重试：初轮 attempt0；`needs-fix` 可启动 attempt1、attempt2，共三轮；每轮反馈写入下一轮固定提示。
  验收失败（含 `blocked`/schema 违规/证据不符）保持 Draft PR 打开，并把具体反馈写入本地状态与日志。
- 摘要与 HEAD：每轮和发布前复查清单 sha256；变化即 `blocked`（`spec-changed`），不执行后编辑的需求。
  审查返回的 `headSha`/`testEvidence.headSha` 与当前 HEAD 不一致即 `stale-review`。
- 失败即 blocked 且不消耗额度：认证/凭据缺失、沙箱、超时（终止自己启动的进程树）、越界改动、空改动。

## 安全边界

- 禁止推送 main/master、强推、通配 refspec、删除 ref、关闭 Issue、任何 merge/auto-merge。
  这些在 `publish.assertPushable`、`publish.assertAutomationRef`、`github.assertArgvAllowed` 三处硬性拒绝。
- 发布超时不确定时先查询（`ensurePullRequest` 先 list、create 超时/冲突后再 list），不盲重建、不强推、不建重复 PR。
- 凭据只来自外部 `credentialCommand` 的 stdout，保存在内存中，只注入精确命名 env；日志与导出全部去敏。
- 子进程 env 白名单：模型子进程拿模型密钥但没有 GitHub 令牌；自测与审查子进程拿不到模型密钥。
- 导出只含去敏数据，不含本机个人绝对路径或令牌；远端只共享 digest 摘要。
  未实现的自动共享以 `shared:false` + `logsRef` 明确标注，不假装已上传。
- `doctor` 只根据真实探测判定：Electron ASAR 内的 `cliEntry` 是虚拟路径，普通 `fs.existsSync` 看不到它，
  因此以 `<executable> --expose-internals <entry> --version` 探测结果为准（成功=ok，失败=failed，
  无法探测=unverified）；普通缺失路径仍然 failed。单元测试全绿不会被当成 live loop 成功。

## 命令白名单

`allowlist.mjs` 首轮只允许：

- `node test.cjs`
- `node --check <仓库内相对路径>`
- `node --test <仓库内相对 .mjs 路径>`

拒绝 `-e`、`--eval`、绝对路径、`..`、空格/引号/`&&`/`|`/`;` 等注入形状，以及 `powershell`、`cmd`、`git`、`npm` 等命令名。
Issue 清单只能在这份白名单里选，不能新增。

## 测试

```
node --test tools/pipeline/pipeline.test.mjs
node test.cjs
```

测试注入内存 GitHub/workspace/DSH/review/publish 适配器，覆盖：双机领取仅一台执行、本地锁冲突、
写请求超时后查询恢复、PR 重复调用只建一次、**Draft PR 先于验收发布并在修复轮复用同一个**、
重启保留修复计数、精确两次修复上限、
主分支/强推/合并拒绝、摘要变化与 HEAD 变化阻止旧审查、凭据不继承给测试、去敏、
DSH 非 completed 即使 exit0 也失败、超时清理、schema 违规拒绝、无效审查判失败、
`review.schema.json` 递归满足 strict Structured Outputs（每个对象全部属性 required）、
doctor 对 ASAR 条目按真实探测判定、真实 Node 假 CLI 子进程收到非空 prompt 并返回 completed。

> Windows 沙箱提示一：若 `node --test` 因 `spawn EPERM` 无法为本文件启动子进程（受限沙箱禁止命名管道），
> 可改用等价的 `node --test --test-isolation=none tools/pipeline/pipeline.test.mjs` 或
> `node tools/pipeline/pipeline.test.mjs` 直接运行，仍会执行同一套断言并返回非零退出码。
>
> Windows 沙箱提示二：同一限制会让“真实管道子进程”回归被显式 skip（不是静默通过）。
> 该回归在不受限环境下会真正执行：用真实 Node 假 CLI 子进程验证 `drive` 只通过 spawn 契约
> 写入一次非空 prompt 并返回 completed；`--session-id` 续跑 argv 也有断言。
> 另有不依赖管道的真实子进程回归（文件描述符 stdio）在受限沙箱内也始终执行。

## 双机步骤

1. 两台机器各自准备 `.pipeline/config.json`，`workerId` 不同，`approvedUsers` 相同。
2. 两台都对同一 Issue 执行 `run`。先创建领取 ref 的一台执行，另一台返回 `claimed-by-other` 并退出。
3. 失败的机器不要手动改 ref；等人工确认旧进程停止后再复跑。
4. 发布只允许该任务精确的 `agent/issue-N-slug` 分支与 `automation/` refs；Draft PR 在独立验收前创建，之后复用同一个 PR。
