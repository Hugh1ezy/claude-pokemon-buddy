# Plan: 消除 mock 回退终态（冷启无板 → 插板自动升级为 serial）

日期: 2026-07-26
分支: `claude/fervent-neumann-9b0abf`
范围: `host/src/transport/index.js`（重写）、`host/src/transport/serial.js`（仅提常量）、新增 `host/test/transport-upgrade.test.js`

---

## 1. 缺陷与根因（已实测确认）

`createTransport()` 在 `host/src/index.js:246` 的 `main()` 中只调用一次。
`createSerialTransport(serialOptions)` 返回 `null` 时走 `wrapMockTransport()`，此后**没有任何路径**能把 mock 升回 serial。

`serial.js` 的 `tryReconnect` / `reconnectTimer`（262-296 行）只在**已成功创建**的 serial transport 内部生效，处理「打开过之后断开」，覆盖不到「从未打开过」。

证据：`host/out/host.log` 中 `ESP serial port not found; using mock transport` 出现 14 次；该行受 `logMockFallback()` 的模块级 `loggedMockFallback` once 守卫保护（每进程只打一次），即 14 个进程生命周期冷启在无板状态并永久 mock。

## 2. 被忽略的硬约束（本计划的设计依据）

这三条决定了「换对象」的朴素解**必然失效**，必须做稳定门面：

| # | 事实 | 位置 | 推论 |
|---|---|---|---|
| C1 | `withSoundGate` 用 `{...transport}` 展开，拷贝的是**函数引用快照** | `host/src/index.js:611-618`，被 `:249` 调用 | 替换 `createTransport` 的返回对象对上层不可见；方法必须是**闭包**，闭合可变的 inner |
| C2 | `createButtonDispatcher` 在启动时对 `hostTransport.onButton` 订阅**一次**；`makeOnboardingIo` 同理 | `host/src/index.js:106`、`:591` | 换底层后订阅会失联 → 按键静默失效。门面必须自持 EventEmitter，把 inner 的事件桥接进来 |
| C3 | `animator` / `buttonDispatcher` 在构造时捕获 `hostTransport` | `host/src/index.js:256`、`:285` | 同 C1，对象身份必须恒定 |

另一条正向事实：`createSerialTransport` 内部已 `path ?? await findEspPort({ SerialPort })`，`findEspPort` 认 **VID 303A** 而非路径（`serial.js:25-28`）。因此升级探测**直接复用 `createSerialTransport`**，天然满足「节点号 1301 / 11301 不固定」的要求，且 serial.js 无需改任何逻辑。

## 3. 目标行为

- mock 模式下按 `reconnectDelayMs`（默认 1500ms）节奏周期性尝试 `serialTransportFactory(serialOptions)`。
- 一旦成功：挂载为 inner、**重置 diff 基线 `previousBytes = null`** 并**立即补推缓存的最后一帧**（真正的全量重画，见 §4.3）、**重放 `lastActiveCry` / `lastVolume`**、桥接 button/sensor/reconnect 事件、停止探测且永不重启。
- 对上层 `push` / `setActiveCry` / `sendVolume` / `onButton` / `feedSensor` 完全透明。
- 不产生重复 transport 实例或串口句柄泄漏。
- 不做反向降级（serial → mock）：断开由 serial.js 自己的 `tryReconnect` 负责，语义不重叠。

## 4. 设计

### 4.1 `host/src/transport/serial.js`（唯一改动，纯提取）

```js
export const DEFAULT_RECONNECT_DELAY_MS = 1500;
// makeTransport({ reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS, ... })
```

行为零变化，仅供 index.js 复用同一节奏常量。**不得**改动 `tryReconnect` / `scheduleReconnect` / `handleDisconnect` 任何逻辑。

### 4.2 `host/src/transport/index.js`（重写为门面）

`createTransport` 签名不变（新增项从 `serialOptions` 里读，不加新 knob）：

```js
export async function createTransport({
  framePath = "out/frame.png",
  serialTransportFactory = createSerialTransport,
  mockFactory = createMockTransport,
  logger = console,
  ...serialOptions
} = {})
```

流程：先 `await serialTransportFactory(serialOptions)` 一次。
- 有结果 → 门面以 serial 模式起步，**不启动探测**。
- 返回 null → `logMockFallback(logger)`（保留模块级 once 守卫，`transport-factory.test.js:10` 依赖它）+ `mockFactory({ framePath })`，**启动探测**。

门面内部状态：
```
events(EventEmitter) / inner(serial|null) / mock / previousBytes / lastFrame
lastActiveCry / lastVolume / detachInner / probeTimer / closed
```

**探测循环**（`probeDelayMs = serialOptions.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS`）：
```js
function scheduleProbe() {
  if (closed || inner || probeTimer) return;     // 单定时器不变量
  probeTimer = setTimeout(runProbe, probeDelayMs);
  // 注意：不得 unref()。见 §4.4。
}

async function runProbe() {
  probeTimer = null;
  if (closed || inner) return;
  let next = null;
  try { next = await serialTransportFactory(serialOptions); } catch { next = null; }
  if (closed || inner) { closeQuietly(next); return; }  // 竞态：已 close 或已升级 → 关掉新句柄
  if (!next) { scheduleProbe(); return; }
  attachSerial(next);
  logger?.warn?.("ESP serial port detected; upgrading mock transport to serial");
}
```
句柄唯一性由三重不变量保证：① `probeTimer` 单例；② `runProbe` 入口即清空 timer，无重入；③ await 后的 `closed || inner` 再检查 + `closeQuietly` 兜底；④ `attachSerial` 后 `inner` 非空 → `scheduleProbe` 直接 return，永不再探测。此处照抄 serial.js RM6（`serial.js:277-284`）已验证过的竞态模式。

**attachSerial(next)**：
```js
detachInner();
inner = next;
previousBytes = null;                       // 全量重画
const offs = [
  next.onButton?.((e) => events.emit("button", e)),
  next.onSensor?.((e) => events.emit("sensor", e)),
  next.onReconnect?.(() => { previousBytes = null; replay(); events.emit("reconnect"); }),
];
detachInner = () => { offs.forEach((off) => off?.()); detachInner = () => {}; };
replay();                                   // lastActiveCry / lastVolume
events.emit("reconnect");                   // 语义 = 基线已重置，请全量重画
redrawLastFrame();                          // §4.3：真正把画面推上去
```
mock 也走同形状的 `attachMock`（只桥接 `onButton`），保证 `injectButton` 经门面仍可达。

### 4.3 升级后的全量重画（Blocker，codex review 2026-07-26）

**只重置基线是不够的。** `runOnboardingGate`（`host/src/index.js:263-273`）会 `io.push(oak 第一页)` 之后 `await io.nextButton()` **无限阻塞**（`host/src/pet/onboarding.js:12-13`）。冷启无板时这一帧只落到了 `out/frame.png`；此刻插上板子，若不主动补推，屏幕会一直空白，用户只能盲按。用户的验收口径原文即「**做一次全量重画**」。

- `doPush` 在成功推送后缓存 `lastFrame = { pngBuffer, bitmap }`——**仅当入参带 `bitmap` 时缓存**（mock 分支允许裸 Buffer，无法重放到 serial，该形态仅测试使用）。
- `redrawLastFrame()`：`if (!lastFrame) return;` 否则 `push(lastFrame).catch(() => {})`——**必须经门面自己的 `push()` 走同一条互斥链**，不得绕过 `chain` 直接调 `inner.pushFrame`，否则会与并发中的 tick/animator 帧交错。
- 排队语义：补推在 `attachSerial` 时入链，之后到达的真实帧排在其后并以补推帧为基线做 diff — 顺序与基线均正确。
- `lastFrame` 无值（尚未 push 过）时跳过：此时基线本就是 `null`，下一帧天然全量。

### 4.4 探测 timer 必须 referenced（Blocker，codex review 2026-07-26）

**不得 `unref()`。** 在 `await runOnboardingGate(...)` 期间，进程内没有任何 referenced handle：`dashboardServer` 在 gate **之后**才创建（`host/src/index.js:293`），`process.once("SIGINT"/"SIGTERM")` 也在 gate **之后**才注册（`:327`），`animator.start()` 更要等到首个 tick 之后（`:407`）。若 timer 被 unref，Node 事件循环空转即退出 → launchd 拉起 → 重启循环，探测永远等不到那 1500ms。这与 memory 记录的「无档会卡 onboarding」及日志中 14 次进程生命周期一致。

referenced timer 的爆炸半径已实测确认**仅 5 处**（全部 `runOneTick`/`main` 测试调用点都已注入 `transport`/`mock`/`transportFactory`，不会走到真实 `createTransport`）：

| 文件:行 | 处理 |
|---|---|
| `host/test/transport-factory.test.js:14` | 接住返回值并 `close()` |
| `host/test/transport-factory.test.js:18` | 同上 |
| `host/test/transport-factory.test.js:31` | 断言后 `close()` |
| `host/test/transport-cry.test.js:64` | 断言后 `close()` |
| `host/test/transport-cry.test.js:70` | 断言后 `close()` |

这 5 处本就该释放资源，属于测试卫生修正，不改变任何断言。**不得**为此新增「探测开关」参数——默认开启才是 correct-by-default，加 flag 会制造「新守护路径忘了传 flag 就静默退化」的地雷。

**push**：沿用现有串行互斥链（`index.js:77-82` 原样保留），`doPush` 分两支：
```js
if (frame?.bitmap) lastFrame = frame;                      // §4.3 补推用；裸 Buffer 不缓存
if (!inner) return mock.push(frame?.pngBuffer ?? frame);   // 保持 mock 现有语义（含裸 Buffer 入参）
if (!bitmap) throw new Error("bitmap is required");
writePreview(framePath, pngBuffer);
const rect = diffRect(previousBytes, bitmap.bytes, bitmap.w, bitmap.h);
if (!rect) return { ok: true, skipped: true };
const result = await inner.pushFrame(encodeDirtyPayload(rect));
if (result?.ok) previousBytes = Uint8Array.from(bitmap.bytes);
return result;
```
`diffRect(null, ...)` 已确认返回 `{x:0,y:0,w,h,bytes:nextBits}` 全屏 rect 且**永不返回 null**（`host/src/transport/diff.js:2`），故「基线重置 + 补推」必然产生一帧全屏刷新。
> `transport-factory.test.js:35` 用 `transport.push(Buffer.from([1,2,3]))` 断言写盘，mock 分支必须继续接受裸 Buffer。

**门面公开面**（全部为闭包方法，可安全被 `{...}` 展开）：
`push` / `pushFrame` / `playSound` / `setActiveCry` / `sendVolume` / `onButton` / `onSensor` / `onReconnect` / `feedSensor` / `getHello` / `injectButton` / `getKind` / `close`

- `setActiveCry(id)`：先存 `lastActiveCry = id & 0xff`，再 `inner?.setActiveCry(...)`（mock 模式只存不发 → 升级时重放）。`sendVolume` 同理（复用现有 `volumeByte`）。
- `pushFrame(payload)`：mock 模式返回 `{ ok: false, disconnected: true }`（诚实语义：无线可走）。
- `getKind()` **取代**现有的 `kind` 属性——`kind` 是普通字段，被 `withSoundGate` 展开后会成为撒谎的陈旧快照。全仓 grep 确认无任何消费者读 `transport.kind`（仅 `event.kind`，语义无关），故可安全替换。
- `close()`：`closed = true` → `clearTimeout(probeTimer)` → `detachInner()` → `try { inner?.close?.() } catch {}`。

## 5. 测试（新增 `host/test/transport-upgrade.test.js`）

沿用仓库既有约定：`reconnectDelayMs: 5` + `waitFor()` 轮询（同 `serial.test.js:213-233`）。

| # | 场景 | 断言 |
|---|---|---|
| T1 | 冷启无端口 → 工厂后续返回 serial | `getKind()` 由 `"mock"` 转 `"serial"`；此后 push 走 `inner.pushFrame` |
| T2 | **升级即全量重画**（§4.3） | 升级前 push 一帧 A（走 mock，屏幕上没有它）→ 升级后**无需再 push**，底层自动收到一帧，且其 dirty rect 为全屏（x=0,y=0,w=full,h=full），RLE 解码后等于 A 的 bitmap |
| T2b | 补推后基线正确 | T2 之后 push 帧 B（仅局部不同于 A）→ 底层收到的是**局部** rect（证明补推帧已成为基线，而非重复全屏） |
| T3 | 升级后重放 `lastActiveCry` | 升级前 `setActiveCry(9)` → 升级后底层收到 `["cry", 9]` |
| T4 | 升级后重放 `lastVolume` | 升级前 `sendVolume(55)` → 升级后底层收到 `["volume", 55]` |
| T5 | **升级与 push 真实竞态**（不是空跑） | 工厂返回一个受控挂起的 promise；在其挂起期间 push A（落 mock）并再 push B（排队）→ 释放工厂完成升级 → 断言：全部 push 均 resolve 无 reject；底层收到的帧序列**恰好一次**且有序；无同一帧被 mock 与 serial 双投递 |
| T6 | 重复升级不产生第二个句柄 | 升级成功后等待 ≥3 个探测周期，工厂调用次数不再增长；只 attach 一个 inner |
| T7 | 探测失败可恢复 | 工厂前两次 throw / 返回 null，第三次成功 → 仍能升级，进程不崩 |
| T8 | `close()` 停止探测 | close 后等待 ≥3 周期，工厂调用次数不增长 |
| T9 | close 与探测竞态（RM6 同形） | 探测挂起中 close → 新 serial 被 `close()`、不 attach、`getKind()` 仍为 `"mock"` |
| T10 | **升级前注册的 `onButton` 回调升级后仍收事件** | 对应约束 C2，最关键的一条 |
| T10b | `onSensor` / `onReconnect` 同样跨升级存活 | 升级前订阅 → 升级后底层发事件仍能收到；且升级时 `onReconnect` 被触发一次 |
| T10c | 订阅返回的 `off()` 跨升级仍能退订 | 升级前 `const off = t.onButton(cb)`；升级后调用 `off()` → 底层再发事件不再回调 |
| T11 | 升级后 `feedSensor()` 透传到 serial | 不再返回 mock 的 canned `{t:23.4,h:56}` |
| T12 | mock 模式行为不回归 | `push(Buffer)` 写盘、`feedSensor()` 返回 canned、`setActiveCry`/`sendVolume` 不抛 |

改造既有测试（§4.4，仅加 `close()`，不改任何断言）：`transport-factory.test.js:14/18/31`、`transport-cry.test.js:64/70`。

回归面：`transport-factory` / `transport-cry` / `push-mutex` / `integration` / `main-orchestration` / `serial` 必须全绿。

## 6. 门禁

```
cd host && node --test --test-concurrency=4
```
（本仓无 eslint / tsc / build；`host/package.json` 仅 `test` 与 `start`。并发必须锁 4，见 README。）
已知环境失败：`play-test.js` 的 `Cannot lock port` 属环境问题，非回归。

## 7. 明确不做

- 不做 serial → mock 反向降级。
- 不改 `serial.js` 的重连状态机。
- 不改 `host/src/index.js`（门面身份恒定，上层零改动即生效）。
- 不加新的配置 knob（复用 `reconnectDelayMs`）；**特别地不加「探测开关」flag**，理由见 §4.4。

## 8. Review 记录

codex review（2026-07-26，1 轮）：2 Blocker + 1 Medium + 1 Medium + 1 Low，全部已并入本计划（§4.3 / §4.4 / T2·T2b·T5 / 既有测试 close / T10b·T10c），BACKLOG 无新增。
对 Blocker 2 的处置范围做了实测收窄：codex 认为 referenced timer 会污染整个测试套件；实扫全部 `runOneTick`/`main` 调用点后确认它们都已注入 transport，真正触达真实 `createTransport` 的仅 5 处，故不引入 flag。

---

## 9. 实施后评审修正（2026-07-26，多 agent 对抗评审 + 本人实证）

第一版实现（`40c2e8c`）功能正确——门禁 430/429 绿、C1 经真实 `{...transport}` 展开链路实证通过——但评审发现 7 项真实缺陷，其中 2 项由本计划 §4.4 的决策引入。

### R1（High，回归，已实证复现）`main()` 启动失败路径不释放 transport → 僵尸进程

§4.4 让探测 timer 保持 referenced 是对的（实测基线在 onboarding gate 上 exit=0，HEAD 才存活），但**漏了所有权**：`stop()` 定义在 `host/src/index.js:315`，而 `runOnboardingGate`（:263）与 `await startDashboardServer`（:294）都在它之前，且都在 :397 的 `try/finally` 之外。任一处抛出（最常见：dashboard 端口 8765 被残留实例占用 → `web/server.js:58` 的 `server.once("error", reject)` → EADDRINUSE），`transport.close()` 永不执行。

实测对照（`main({dashboardPort: 被占用})`，无板）：

| | 结果 |
|---|---|
| HEAD~1 基线 | reject 后进程干净退出，`exit=0`，无残留 handle |
| HEAD（40c2e8c） | reject 后进程**存活**，残留 `["Timeout"]`，需 SIGKILL |

launchd 下僵尸比崩溃更糟：`KeepAlive` 不重启它，而它每 1.5s 仍在探测，**插板瞬间会抢走串口**并把自己钉在 mock——正是本修复要消灭的终态。注意有板时同样泄漏真实串口句柄，属既有缺陷，一并修掉。

**修法**：`host/src/index.js` 中 `createTransport` 之后的整个主体包一层 `try { … } catch (error) { transport.close?.(); throw error; }`（**不得调整任何语句顺序**——`main-orchestration.test.js` 断言 onboarding io → tutorial io → resident dispatcher 的订阅顺序）；并把末尾 `finally` 的 `if (once && !stopped) stop();` 改为 `if (!stopped) stop();`（守护进程正常返回时 `stopped` 必为 true，是 no-op）。`stop()` 与门面 `close()` 均可重入。

> 本计划 §7「不改 `host/src/index.js`」**作废**。用户的验收口径含「不能引入串口句柄泄漏」，该项属于范围之内。

### R2（High）`redrawLastFrame()` 追加到链尾且快照过早 → 可能重画旧帧

`attachSerial` 在链外执行，`redrawLastFrame()` 同步读取 `lastFrame` 并 `push()` 到链尾。若链上已排着更新的帧，补推会在其后执行，屏幕最终停在**旧帧**（animator 运行时 ≤333ms 自愈，gate 阻塞时可能长期可见）。

**修法**：惰性入队，执行时才读状态：
```js
function redrawLastFrame() {
  chain = chain.then(async () => {
    if (closed || !inner || previousBytes || !lastFrame) return; // 已有新帧上过线则无需补
    await doPush(lastFrame);
  }).then(() => {}, () => {});
}
```

### R3（Medium，非回归，主动修）inner `onReconnect` 只重置基线不重画

`transport/index.js:103-107` 与 12 行下方的 attach 路径不对称。评审正确指出这是既有行为（HEAD~1 逐字等价）、非本次回归，但既然 `lastFrame` 已存在，补一行即可消除不对称；已实证「带板冷启 + 无存档 + gate 阻塞期 USB 重枚举 → 面板空白」可复现。

**修法**：该 handler 末尾追加 `redrawLastFrame();`（R2 改造后天然带互斥与幂等守卫）。

### R4–R7（测试缺口，均经变异实证：删掉生产代码后全套件仍绿）

| # | 变异 | 现状 | 补法 |
|---|---|---|---|
| R4 (High) | 删 `close()` 里的 `closeQuietly(inner)` | 全绿 | 新增：升级后 `close()` → 断言 `serial.closed() === 1`（T9 只覆盖「升级前 close」） |
| R5 (High) | 删 onReconnect 里的 `previousBytes = null` | 全绿 | T10b 扩展：推帧 → 推同帧断言 `skipped` → `emitReconnect()` → 再推同帧断言收到**全屏** rect |
| R6 (Medium) | — | §4.4 补的 5 处 `close()` 是裸尾语句，断言一红就跳过，重新引入 hang | 改 `try/finally` 或 `t.after()` |
| R7 (Low) | 删 `close()` 里的 `clearTimeout(probeTimer)` | 全绿（T8 靠 `closed` 短路通过，与句柄释放无关） | T8 改断 `process.getActiveResourcesInfo()` 中 Timeout 数量 |

### R8（本人发现）C1 无提交测试

整个修复最要害的约束——门面经 `withSoundGate` 的 `{...transport}` 展开后仍能完成升级——只有我的一次性探针验证过，无提交测试守护。

**修法**：新增测试，spread 门面后订阅 `onButton`、`setActiveCry`/`sendVolume`，等待升级，断言补推全屏帧 + 事件仍达 + 重放生效 + `playSound`/`feedSensor` 透传。

### 新增门禁

R1 需回归测试：注入带 close spy 的 transport + 占用 dashboard 端口 → 断言 `main()` reject **且** transport 被 close。
