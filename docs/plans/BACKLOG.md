# BACKLOG（2026-07 审查修复冲刺遗留）

> 来源：R 系列修复冲刺（`2026-07-03-review-remediation-spec.md`）各批 PM review 中按约定不回改、记档的 Medium/Low 项，以及需要连板的手工验证清单。

## 代码遗留（Low）

1. **`collectStandaloneButtonSnapshot` 是误导性结构**（`host/src/index.js:496`）：订阅后立即在 finally 退订，实际恒返回空数组。行为无害（standalone/once 模式本就不消费 tick 间按键），但读者会误以为它在收集事件。建议直接返回 `[]` 并加注释说明 standalone 模式不收集按键。
2. **serial `timeoutMs` 注入语义变窄**（`host/src/transport/serial.js:344`）：Batch A 后 `retryTimeoutFor = max(DEFAULT_TIMEOUT_MS, timeoutMs, 150+ceil(len/16))`，注入低于 250ms 的值不再生效（只可调高不可调低）。当前无快超时用例，测试均用 mock timers，无实际影响；若未来需要可将下限改为 `min(timeoutMs, 250)` 语义。

## 2026-07 只读审计整改遗留（AR 系列，`2026-07-05-audit-remediation-spec.md`）

> P0 已落地并过门禁：AR4/AR1/AR2/AR3/AR5/AR6（commit cccaab1/db3c8c1/e932509/1610b48/cf6815a/71272b9）。以下为本轮明确不含、另立的项。

### PRE-1（**已修复** — AR8，commit `2a3bffd`，Medium）ccusage 默认 UTC 分桶 vs host 本地日历
> 状态：已落地。`usage.js` 现经 `CCUSAGE_TIMEZONE` env 把 ccusage 分桶对齐 host 本地 IANA 时区（`2026-07-05-ar8-ccusage-timezone-spec.md`），门禁 367/0。以下为原始记录。
- **结论**：调查证实 ccusage `daily`/`blocks` 的 `period` **默认按 UTC 分桶**（Claude JSONL 时间戳带 `Z`，ccusage 默认用 UTC 组件提取日期；参见 ryoppippi/ccusage issue #349「时区≠UTC 时分组错误」、#778「statusline today 因 UTC 显示 \$0」）。ccusage 提供 `--timezone <tz>` / `CCUSAGE_TIMEZONE` 覆盖，但**默认 UTC**。
- **缺陷**：`host/src/usage.js:7-8` 调 `npx --yes ccusage blocks/daily --json` **未传 `--timezone`**，而 `today = localYmd(now)`（`usage.js:145-150`）为**本地**。对非 UTC 用户（默认配置 Auckland UTC+12/+13）：跨日边界的 `todayTokens`（`latestIsToday = todayPeriod === today` 失配 → 成长少记/记错日，影响 `applyDailyGrowth`）与 `activeDays`（UTC 桶 vs 本地结算窗口失配 → `streak`/`bond`/`shield` 衰减错误）会 off-by-one。
- **注**：审计对抗验证曾以"两侧均本地"误驳此项（R6/R9/R10）；两模型均正确标注 Needs More Context。本调查推翻误驳、证实缺陷。`daysBetween` 本身仍正确（DST 安全）——问题在 ccusage 分桶时区，非 `daysBetween`。
- **修复方向（小而安全）**：`usage.js` 的两个 ccusage 调用显式传 `--timezone <host 本地时区>`（如 `Intl.DateTimeFormat().resolvedOptions().timeZone`），或设 `CCUSAGE_TIMEZONE`，使 ccusage 与 host `localYmd` 同为本地日历。需验收：注入受控时区 + 边界日的 `todayTokens`/`activeDays` 归属正确；旧 ccusage 版本无 `--timezone` 时的降级（未知 flag 行为）。

### AR7（Low，固件/协议）跨 host 重启 seq 去重 1/256 首帧丢失
- 固件 `last_acked_frame_seq` 跨 host 重启持久，host `nextSeq` 每进程归零 → 1/256 首帧被误判重传丢弃；buddy 区 ~333ms 恢复，但静态左栏保持陈旧至内容下次变化（≥60s）。
- 修复须先定 host→device RESET opcode 字节格式（proto.js + main.cpp 同步）、ack/fire-and-forget 语义、初连/重连相对首帧顺序（注意 `serial.js:285` reconnect 回调先于 `pump()`）。协议改动两端同批。

### 优化项（另立性能冲刺）
- **OPT-1（Medium）** animator 热路径：全帧 PNG 重编码 + 同步落盘 3×/s + 静态左栏重绘 + sprite 重阈值。加 bitmap-only 渲染路径；预览写异步/节流至 ≤1/tick；缓存左栏。**须保留 mock PNG 行为**（`index.js:487-492`）。
- **OPT-2（Medium，固件）** 每脏矩形整屏 15KB SPI 刷新（`main.cpp:219-227` + `display_bsp.cpp:191-203`）。窗口化 ST7305 刷新至脏矩形——**需硬件验证**。
- **OPT-3（Medium）** 每 tick 串行 `npx ccusage` ×2（`usage.js:3-16`）。Promise.all / 解析 binary 一次 / 解耦渲染节奏。
- **OPT-4（Low）** `diffRect` 全扫无早退、`bitAt` 重算 rowBytes（`diff.js:9-18,35-39`）。

### 可维护性 / Nit
- **MNT-2（Low，usage-poll）** `DEFAULT_VERSION="2.1.0"` UA 回退值随时间漂移，端点对旧 UA 可能 429（`usage-poll.mjs:10`）；且 `ccVersion` 每次未节流 poll 都 spawnSync `claude --version`（阻塞 ~百 ms）——可进程内缓存一次。另注：同机 CodexBar 轮询同一 `/api/oauth/usage` 端点,与 buddy 共享账号级限流配额,排查 429 时需一并考虑。
- **MNT-3（Low，测试）** `main-orchestration.test.js` 用 `sleep(500)` 竞速判定 settled,`--test-concurrency=4` 高负载下偶发 timeout 抖动（2026-07-05 全量跑复现一次,单跑稳定绿）。可改条件轮询替代固定竞速窗口。
- **MNT-1（Low）** 重复 helper：`volumeByte`×3（index.js:608 / transport/index.js:105 / serial.js:427）、`fsync*`/`isParseableJsonFile`×2（config.js:76-106 == state.js:123-153）、`localYmd`×2（index.js:585 / usage.js:145）。抽取须保留 **0..100 音量契约** 与 **fsync/rename 崩溃安全**。
- **N1（Nit）** onboarding 按键缓冲上限 8 静默丢弃（`index.js:538`）。
- **N2（Nit）** `weekTokens` 生产环境无消费者（死计算，`usage.js:63-65`；测试仍读）。

### 2026-07-26 mock 升级冲刺沉淀（既有问题，非本次引入）

- **MNT-4（Medium，测试）** `--test-concurrency=4` 全量跑时 canvas/render 密集测试**文件级**偶发失败，且 node --test 只报 `'test failed'` 无断言输出（受影响族：`buddy-geometry` / `buddy-hop` / `evolution-anim` / `evolution-trigger` / `layout` / `integration` / `onboarding`）。量化：基线 `HEAD~1` 6 次全量跑复现 2 次；同期 HEAD 9 次全量跑 0 次复现；把 4 个受影响文件单独并发跑 8 轮不复现 → 与全量负载相关而非文件间冲突（`out/` fixture 文件名已确认无碰撞）。与 MNT-3 不同族（那条是 `sleep(500)` 竞速）。排查建议：先让子进程 stderr 可见（`--test-reporter=spec` 或直接 spawn），确认是 OOM 还是 `@napi-rs/canvas` 原生层竞争。
- **MNT-5（Low，transport）** `createTransport({ framePath: null })` 在 **mock 分支必抛** `TypeError: dirname(null)`（`mock.js:13`）。默认参数只对 `undefined` 生效，null 直接穿透；serial 分支的 `writePreview` 有 `if (!framePath) return` 守卫，两边不一致。生产不可达（`main` 恒传字符串），`push-mutex.test.js` 传 null 但走 serial 分支。修法：给 `mock.js` 补同样的守卫。
- **MNT-6（Low，transport）** `mock.push(frame?.pngBuffer ?? frame)`（`transport/index.js`）在 `pngBuffer` 为空但 `bitmap` 存在时，会把**整个 frame 对象**交给 `writeFileSync` → `TypeError`。既有语义（为兼容裸 Buffer 入参），生产不可达。修法：改为显式分支判断，而非 `??` 兜底。

## 连板冒烟清单（owner 手工，Batch G 产出）

- [ ] 上电后 host 收到 HELLO（proto_ver=1, snd_count），约 500ms 后收到第二次。
- [ ] 面板设 quietHours 进入静音窗后，设备本地 KEY 叫声静音（VOLUME 0 生效）；退出窗口后恢复。
- [ ] host 重发同 seq FRAME 时设备只回 ACK 不重刷屏（观察无闪烁）。
- [ ] 构造越界 rect / RLE mismatch → host 日志出现 NACK 且按重试上限放弃。
- [ ] 模拟 codec 故障（如断开 ES8311 总线）→ 屏幕/按键/串口仍正常，仅无声。
- [ ] SHTC3 测量失败路径与 USB short-write 需故障注入或长期日志观察。
- [ ] 进化闭环实机走查：长按关怀→bond 满→KEY 进化仙子伊布；面板 choose leafeon；面板给石头→KEY 进化水伊布。

## 分发/运维（2026-07-05 onboarding spec 遗留，P2）

- [ ] host 崩溃自愈 supervisor / 托盘程序 / 单 exe 打包（原 spec §241 遗留）
- [ ] 后续更新机制（agent 化 UPDATE.md：git pull + 依赖刷新 + 重启；或自动更新）
- [ ] 网页烧录器（ESP Web Tools）作为非 Claude 用户的备选安装路径
- [ ] R2 评审 Medium 沉淀：SETUP 各失败分支随真实案例持续扩充
- [ ] 桌面版 Claude Code 不触发 statusLine（2026-07-06 实测；终端版正常且 schema 未变）——仅影响 bridge 辅路，poll 主路不受影响；若未来 poll 端点失效需重估

### 自启脚本（autostart-macos，2026-07-06 审查沉淀）

- **AS-1（Low）** plist 烧入 worktree 路径：从 `.claude/worktrees/` 下执行 `install` 会把临时路径写进 plist（`ProgramArguments`/`WorkingDirectory`/日志路径），worktree 删除后自启断（指向已删目录）。install 检测到 `HOST_DIR` 含 `.claude/worktrees` 时应警告或拒绝，引导用户从主仓库执行。
- **AS-2（Low）** symlink 方式调用时入口守卫失效：`process.argv[1] === SCRIPT_PATH` 未对 `argv[1]` 做 realpath 解析（`SCRIPT_PATH` 已 `fileURLToPath`），经软链启动时两侧不等 → 脚本静默退出 0 不执行。改为双侧 `realpathSync` 后比较。
- **AS-3（Medium）** `findManualHostPids`/`install`/`uninstall` 的 `runCommand` 未注入化，导致「install 拒绝路径（发现手动实例/bootout 未落定）」与 `uninstall` 的 `isMissingService` 容错分支缺进程级单测。重构为可注入 runner（依赖倒置）后补齐这些真分支的单测覆盖，避免只测纯函数。
