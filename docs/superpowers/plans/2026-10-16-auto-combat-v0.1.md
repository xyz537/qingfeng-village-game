# 自动战斗 V0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在村外古道加入可点击的山贼与迎战选项，并在独立场地运行带三级 AI、基础防御和可观察调试信息的 1V1 自动战斗。

**Architecture:** 新增无 DOM 依赖的 `Combat` 模块，集中管理角色模板、AI 决策、行动计时、伤害和结果。现有 `game.js` 只负责古道交互、场景切换、Canvas 表现和界面同步；山贼使用独立透明像素素材，并用 Canvas 变换和特效表现各战斗状态。

**Tech Stack:** 原生 JavaScript、Canvas 2D、HTML/CSS、Node.js `assert` + `vm` 测试，无新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-10-16-auto-combat-v0.1-design.md`

## Global Constraints

- 保持无构建、无网络依赖，`node server.cjs` 和直接打开 `index.html` 两种方式都可运行。
- 不改变现有生活模拟存档格式；战斗状态不进入 `qingfeng-v1`。
- V0.1 只做 1V1 自动战斗，不加入手动选招、时间条、六角格、破招、变招、架势或连招。
- 主角属性固定为 HP 100、内力 50、攻击 18、防御 10、攻击间隔 0.75 秒、移动 95、AI1、长剑。
- 山贼属性固定为 HP 120、内力 0、攻击 25、防御 8、攻击间隔 1.65 秒、移动 88、AI0、柴刀。
- 招架倍率 0.3；闪避完全免伤并位移；护体消耗 10、持续 2 秒、伤害倍率 0.6。
- 山贼必须是与现有画面协调的 2D 像素人物，不得以无细节色块代替。

## Review Focus

- 大帧间隔或标签页恢复：战斗按受限步长推进，不能瞬间跳过多个攻击和结束状态（Task 1 测试）。
- 多次更新已结束战斗：结果和结束日志只能产生一次（Task 1 测试）。
- 防御倍率叠加：招架与护体应按顺序乘算，最终伤害至少为 1（Task 1 测试）。
- 古道目标优先级：山贼与返回按钮命中区域不能互相遮蔽，远点先寻路、近点才弹选项（Task 3 测试）。
- 战斗退出与重开：返回古道后不得残留面板、定时状态或旧日志；重新挑战必须获得全新满状态（Task 3 测试）。

---

### Task 1: 可测试的自动战斗内核

**Files:**
- Create: `combat.js`
- Modify: `test.cjs:1-45` and append combat assertions

**Interfaces:**
- Produces: global/CommonJS `Combat` object.
- Produces: `Combat.createBattle(overrides?: object): BattleState`.
- Produces: `Combat.step(battle: BattleState, seconds: number, random?: () => number): BattleState`.
- Produces: `Combat.previewDamage(attacker: Fighter, defender: Fighter): number`.
- `BattleState` exposes `time`, `status`, `fighters.player`, `fighters.bandit`, `log`, and `result`.
- Fighter `action.kind` is one of `idle`, `approach`, `windup`, `parry`, `dodge`, `guard`, `hurt`, `down`, `flee`.

- [ ] **Step 1: Add failing module and template tests**

Load `combat.js` before `game.js`, then assert the exact player/bandit attributes, behavior permissions, initial positions, `status === 'running'`, and empty result.

- [ ] **Step 2: Run the test and confirm the missing-module failure**

Run: `node test.cjs`
Expected: FAIL because `combat.js` or `Combat` does not exist.

- [ ] **Step 3: Implement the battle state and deterministic helpers**

Create the two fixed fighter templates, fresh cloning in `createBattle`, bounded log insertion, distance calculation, `previewDamage`, action setup and one-time result finalization. Keep all functions independent of DOM and wall-clock APIs.

- [ ] **Step 4: Run the template tests**

Run: `node test.cjs`
Expected: PASS for the new template assertions and all existing tests.

- [ ] **Step 5: Add failing behavior tests**

Add focused assertions for:

- AI0 approaches and attacks but never chooses parry, dodge or guard.
- AI0 at less than 20% HP enters `flee` when injected random returns the escape branch.
- AI1 reacts to enemy `windup` with parry or dodge under controlled inputs.
- AI2 spends exactly 10 inner power on a high-threat guard and does not spend again while guard remains active.
- A parried hit deals approximately 30% of normal damage.
- A dodged hit deals zero and changes at least one position coordinate.
- A guarded hit deals 60% of otherwise final damage; guard expires after 2 seconds.
- Over 3.3 simulated seconds, the player initiates more attacks than the bandit.
- Large `seconds` input is internally sliced to steps no larger than 0.05 seconds.
- Death and escape finalize once; later calls do not add another result log.

- [ ] **Step 6: Run and confirm the behavior tests fail for missing simulation**

Run: `node test.cjs`
Expected: FAIL on the first unimplemented movement/decision/action assertion.

- [ ] **Step 7: Implement the minimal combat loop**

Implement target acquisition, approach/flee movement, AI0/AI1/AI2 decision functions, windup and hit resolution, cooldowns, parry, dodge, guard and terminal states. `Combat.step` must split elapsed time into at most 0.05-second slices and return the same battle object for simple integration.

- [ ] **Step 8: Run the full suite and refactor while green**

Run: `node test.cjs`
Expected: PASS with no warnings or uncaught errors.

- [ ] **Step 9: Commit the combat engine**

```bash
git add combat.js test.cjs
git commit -m "feat: add automatic combat engine"
```

### Task 2: 山贼像素角色素材与绘制模型

**Files:**
- Create: `assets/bandit.png`
- Modify: `game.js:1-3`, `game.js:94-141`
- Modify: `test.cjs:35-60`

**Interfaces:**
- Consumes: fighter `action.kind`, coordinates and facing from Task 1.
- Produces: `art.bandit` image entry with `assets/bandit.png` source.
- Produces: `drawBandit(x: number, y: number, fighter?: Fighter | null): void` for both road NPC and battle rendering.

- [ ] **Step 1: Add failing asset/model tests**

Assert `art.bandit.src === 'assets/bandit.png'`, the file exists, and calls to `drawBandit` for `idle`, `approach`, `windup`, `hurt` and `down` all draw the bandit image while producing distinct Canvas transform/effect operations for combat states.

- [ ] **Step 2: Run the test and confirm the missing asset/model failure**

Run: `node test.cjs`
Expected: FAIL because `art.bandit` and `drawBandit` do not exist.

- [ ] **Step 3: Generate and inspect the transparent pixel-art bandit**

Create a single full-body transparent PNG matching the existing proportions and muted palette: rough brown short coat, dark headscarf, wrapped calves and a visibly held woodcutter's saber. Inspect the result at original resolution and at the in-game scale; regenerate if the silhouette, transparency or weapon is unclear.

- [ ] **Step 4: Implement the reusable bandit renderer**

Load the asset through `art.bandit`. Draw one consistent character for road and battle; use bobbing/walking offset, weapon arc, tilt, flash and ground rotation to distinguish approach, windup, hurt and down without requiring an unreliable generated sprite grid.

- [ ] **Step 5: Run the full suite**

Run: `node test.cjs`
Expected: PASS, including asset existence and state rendering assertions.

- [ ] **Step 6: Commit the visual model**

```bash
git add assets/bandit.png game.js test.cjs
git commit -m "feat: add bandit character model"
```

### Task 3: 古道交互、战斗场地与调试界面

**Files:**
- Modify: `data.js` near `DATA.map`
- Modify: `index.html:11-35`
- Modify: `style.css`
- Modify: `game.js:77-88`, `game.js:141`, `game.js:249-376`
- Modify: `test.cjs` interaction and scene tests

**Interfaces:**
- Consumes: `Combat.createBattle`, `Combat.step`, `drawBandit`.
- Produces: `DATA.map.bandit` with road position, hit rectangle and interaction reach.
- Produces: `startBattle(): void`, `leaveBattle(): void`, `renderCombatHud(): void`, `drawBattle(): void`.
- Extends scenes with `battle`; maintains module-local `battle` state that is never serialized.

- [ ] **Step 1: Add failing road encounter tests**

Assert the road target list includes one `bandit`, a far click creates travel toward it, a near click opens dialogue with buttons `拔剑迎战` and `暂且退开`, and choosing retreat leaves the scene and battle state unchanged.

- [ ] **Step 2: Run and confirm the encounter tests fail**

Run: `node test.cjs`
Expected: FAIL because the road has no bandit interaction target.

- [ ] **Step 3: Implement the road bandit interaction**

Add the bandit position and hit box to data, render it in `drawRoad`, include it in `interactionTargets` and hit priority, and open the established dialogue component with the two exact options. Preserve the existing road return target and auto-walk behavior.

- [ ] **Step 4: Run the suite and confirm road behavior passes**

Run: `node test.cjs`
Expected: PASS for road targeting, auto-walk, dialogue and retreat, with all old navigation checks green.

- [ ] **Step 5: Add failing battle scene and lifecycle tests**

Assert `拔剑迎战` calls `startBattle`, sets `state.scene === 'battle'`, creates full-health fighters, hides ordinary nearby actions and shows the HUD. Verify ticks advance `battle.time`, finished state stops changing, `重新挑战` creates a distinct fresh battle, and `返回古道` clears the battle/HUD and restores the road position. Also assert a large render-frame gap advances combat by at most the normal capped frame delta.

- [ ] **Step 6: Run and confirm the battle integration tests fail**

Run: `node test.cjs`
Expected: FAIL because the battle scene and HUD functions do not exist.

- [ ] **Step 7: Implement battle scene rendering and lifecycle**

Add `combat.js` before `game.js` in `index.html`. Add hidden HUD markup containing two status cards, decision text, event log and result actions. In `game.js`, route battle ticks through `Combat.step`, draw the arena and both fighters, sync HUD text/bars, suppress ordinary walking/input while fighting, and implement restart/return cleanup.

- [ ] **Step 8: Style the responsive HUD**

Add compact mobile-first cards and bars that remain readable within the existing 540px layout, with action/result colors matching the muted green and parchment palette. Hide the entire HUD outside the battle scene.

- [ ] **Step 9: Run the full automated suite**

Run: `node test.cjs`
Expected: PASS with no failures, warnings or uncaught errors.

- [ ] **Step 10: Commit the integrated encounter**

```bash
git add data.js index.html style.css game.js test.cjs
git commit -m "feat: add road bandit battle encounter"
```

### Task 4: Play instructions and end-to-end validation

**Files:**
- Modify: `README.md`
- Modify: `VALIDATION.md`

**Interfaces:**
- Consumes: completed road encounter and battle UI from Tasks 1-3.
- Produces: exact local play path and recorded verification evidence.

- [ ] **Step 1: Add the play path to README**

Document: start the server, enter the south village road, click the visible bandit, walk close, click again, choose `拔剑迎战`, then observe the HUD; describe restart and return controls.

- [ ] **Step 2: Run static syntax and automated checks**

Run: `node --check combat.js`
Expected: exit 0.

Run: `node --check game.js`
Expected: exit 0.

Run: `node test.cjs`
Expected: PASS with zero failures.

- [ ] **Step 3: Run the local server and browser smoke test**

Start: `node server.cjs`

Verify in the browser at desktop and narrow mobile width:

- Entering the road shows the modeled bandit.
- Far click walks close; near click shows both options.
- Retreat does not start combat; challenge enters the arena.
- The player visibly attacks faster than the bandit.
- Parry/dodge and logs appear; HP bars and current decisions update.
- Win, loss or escape freezes the result and exposes restart/return.
- Restart resets all battle values; returning restores the road without HUD residue.

- [ ] **Step 4: Record exact validation results**

Update `VALIDATION.md` with commands, pass/fail counts, browser path checked, responsive widths checked and any known V0.1 limitations.

- [ ] **Step 5: Run the final clean verification**

Run these commands separately:

```bash
node --check combat.js
node --check game.js
node test.cjs
git diff --check
git status --short
```

Expected: both syntax checks exit 0, test prints PASS, diff check is clean, and status only lists the intended README/validation changes before commit.

- [ ] **Step 6: Commit documentation and validation**

```bash
git add README.md VALIDATION.md
git commit -m "docs: explain and verify road combat"
```

