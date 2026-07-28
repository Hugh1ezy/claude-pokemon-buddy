# SETUP-WINDOWS.md — 写给 Claude 的安装手册

> **如果你是人类**：把下面"发给 Claude 的指令"原样发给你的 Claude Code 就行，剩下交给它。
>
> **发给 Claude 的指令（复制这段）**：
> 请打开并严格执行 https://raw.githubusercontent.com/Hugh1ezy/claude-pokemon-buddy/main/SETUP-WINDOWS.md —— 这是一份写给你（Claude）的安装手册。我桌上有一台连着 USB 的宝可梦小设备，请按手册把它从零装好，每一步都要跑手册里的验证命令确认成功再继续。
>
> **送礼人转发话术**：送你的小设备到了！它是一只用你的 Claude 用量养大的宝可梦。用 USB **数据线**把它连上电脑，然后把上面那段指令原样发给你的 Claude Code。

---

## 0. 给 Claude 的执行契约（先读这节）

1. **逐步执行**：每步跑完"验证"命令、确认符合预期输出才进入下一步。
2. **失败先走该步的"失败分支"**，分支穷尽后再自行诊断；连续两次无法推进 → 停下向主人清晰描述卡点。
3. 需要主人动手（按设备按键、拔插线、确认屏幕）时，用一句人话明确说"请你……"。
4. 除第 5 步问城市外，**不要问不必要的问题**。
5. 全程 PowerShell；工作目录约定 `$HOME\claude-pokemon-buddy`。

## 1. 环境自举

```powershell
winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements
winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements
```

**装完开一个新的 PowerShell 会话**（刷新 PATH），验证：

```powershell
git --version; node --version; claude --version
```

预期：三个都出版本号；`claude` ≥ **2.1.80**（低于则先让主人升级 Claude Code）。
失败分支：winget 被组织策略禁用 → 改用官方安装包（git-scm.com / nodejs.org）下载安装后重试验证。

下载 esptool（官方 Windows 独立 exe，免 Python）：

```powershell
$assets = (Invoke-RestMethod https://api.github.com/repos/espressif/esptool/releases/latest).assets
$asset = $assets | Where-Object name -match 'windows.*amd64.*\.zip$' | Select-Object -First 1
if (-not $asset) { $asset = $assets | Where-Object name -like '*win64*' | Select-Object -First 1 }
if (-not $asset) { Write-Error "esptool Windows 资产未找到，改用 pip install esptool 兜底"; exit 1 }
Invoke-WebRequest $asset.browser_download_url -OutFile "$HOME\esptool-win64.zip"
Expand-Archive "$HOME\esptool-win64.zip" -DestinationPath "$HOME\esptool" -Force
$esptool = (Get-ChildItem "$HOME\esptool" -Recurse -Filter esptool.exe | Select-Object -First 1).FullName
& $esptool version
```

预期：输出 esptool 版本号（v5+）。

## 2. 取码 + 装依赖

```powershell
cd $HOME
git clone https://github.com/Hugh1ezy/claude-pokemon-buddy.git
cd claude-pokemon-buddy\host
npm install
npm ls --depth=0
```

预期：`npm ls` 列出 `serialport` 与 `@napi-rs/canvas`，无 `ERR`。
失败分支：公司代理导致 npm 超时 → `npm config set registry https://registry.npmmirror.com` 后重试。

## 2b. 烘制宝可梦图（必做，仓库里没有图）

```powershell
node scripts/bake-assets.mjs
```

预期：打印 156 行 `wrote seed/sprites/<名字>.png`，最后一行 `baked 156 sprite(s)`，中途没有 `FAILED`。耗时几分钟（151 只图鉴 + 5 只非图鉴伊布进化型，逐个从 PokeAPI 下载）。

**为什么不在仓库里**：这些是任天堂/Game Freak 的美术资源，而这个仓库是公开的。仓库里只放"下载并加工"的脚本，成品每台机器自己生成一次。

失败分支：个别几只下载失败（脚本会在最后汇总列出）→ 只重跑那几只，例如 `node scripts/bake-assets.mjs pikachu gengar`；全部失败 → 多半是网络到 `raw.githubusercontent.com` 不通，挂代理后重试。

跳过这一步的后果：宝可梦会显示成占位的棋盘格方块，且 `npm test` 里的图相关测试会**跳过而不是失败**（会打印一行提示叫你回来跑这个命令）。

## 3. 烧录固件（设备此时是空白的，屏幕不亮属正常）

**3a. 烧前预检**——找到设备的 COM 口：

```powershell
Get-PnpDevice -Class Ports -Status OK | Where-Object InstanceId -match 'VID_303A'
```

预期：一行 `USB 串行设备 (COMx)`。记下 `COMx`。
失败分支（按顺序试）：
- a) 什么都没有 → 大概率是**充电线**（无数据芯）。请主人换一条 USB **数据线**、换一个 USB 口，重跑预检。
- b) 设备管理器里有带叹号的未知设备 → 按 Espressif 官方 USB-Serial/JTAG 驱动指引安装驱动后重试（Win10/11 通常免驱）。
- c) 空白片未出串口/后续烧录失败 → **手动进下载模式（注意：装了 18650 电池时拔 USB 不等于断电）**。请主人：把设备电池电源开关拨到 OFF（若板上有 RESET/EN 键，也可按住 BOOT 再短按 RESET）→ 按住 **BOOT** 键不放 → 插上 USB（或拨回 ON 上电）→ 松开。重跑预检。

**3b. 下载固件并烧录**（把 `COMx` 换成预检结果）：

```powershell
cd $HOME\claude-pokemon-buddy
Invoke-WebRequest https://github.com/aquamarinz/claude-pokemon-buddy/releases/latest/download/cpb-firmware-merged.bin -OutFile cpb-firmware-merged.bin
& $esptool --chip esp32s3 --port COMx write-flash 0x0 cpb-firmware-merged.bin
```

预期：输出含 **`Hash of data verified`**。烧完设备自动重启，屏幕出现待机画面。
失败分支：串口被占用（`could not open port`）→ 关掉占用程序（常见：其它串口工具/上次残留的 node 进程 `Get-Process node | Stop-Process`）；写入中途失败 → 走 3a-c 手动下载模式流程再烧一次；再失败 → 停下报告主人。

## 4. 接通 Claude 用量数据（statusline bridge）

读 `$HOME\.claude\settings.json`（不存在则视为空 `{}`）：

- **没有 `statusLine` 字段（预期情况）**：merge 写入（**保留文件里其它字段**，路径用正斜杠）：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node C:/Users/<用户名>/claude-pokemon-buddy/host/src/usage-bridge.mjs"
  }
}
```

- **已有 `statusLine`**：先把原文件备份为 `settings.json.bak`，把原 command 字符串 base64 编码后挂到 fan-out（原状态栏显示不变；base64 避免引号/空格转义问题）：

```powershell
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('<原来的 command 字符串>'))
```

```json
{
  "statusLine": {
    "type": "command",
    "command": "node C:/Users/<用户名>/claude-pokemon-buddy/host/scripts/cpb-statusline-fanout.mjs --b64 <上面算出的 base64>"
  }
}
```

验证：`Get-Content $HOME\.claude\settings.json | ConvertFrom-Json` 不报错。

## 5. 个性化（唯一需要提问的一步）

问主人："你在哪个城市？（用于屏幕上的天气）"，把城市换算成经纬度，写入 `$HOME\claude-pokemon-buddy\host\config.json`：

```json
{ "lat": <纬度>, "lon": <经度> }
```

（其它字段走默认；名字默认"阿布"，主人以后可在 dashboard 改。）

## 6. 开机自启

先确保日志目录存在、拿到 node **绝对路径**（自启环境的 PATH 不可依赖）：

```powershell
New-Item "$HOME\claude-pokemon-buddy\host\out" -ItemType Directory -Force
(Get-Command node).Source   # 记下绝对路径，写进下面的 vbs
```

写 `$HOME\claude-pokemon-buddy\start-buddy.vbs`（`<用户名>` 与 `<node绝对路径>` 用上面查到的真实值替换）：

```vbscript
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\<用户名>\claude-pokemon-buddy\host"
sh.Run "cmd /c """"<node绝对路径>"" src\index.js >> out\host-autostart.log 2>&1""", 0, False
```

复制进 Startup 文件夹并**实测一次**：

```powershell
Copy-Item "$HOME\claude-pokemon-buddy\start-buddy.vbs" "$([Environment]::GetFolderPath('Startup'))"
Get-Process node -ErrorAction SilentlyContinue | Stop-Process   # 清掉手动起的实例
wscript "$HOME\claude-pokemon-buddy\start-buddy.vbs"
Start-Sleep 8; Get-Process node                                  # 预期：node 进程存在
```

预期：`Get-Process node` 有输出，且**屏幕出现画面**（问主人确认）。

## 7. 端到端验证

1. 屏幕有画面（第 6 步已确认）。
2. 用量数据有两条路：host 自带的 **poll**（host 跑起来后 ~3 分钟内自动写；主路）+ statusline bridge（辅路）。等 3 分钟后检查：

```powershell
Get-Content $HOME\.claude\cpb-usage.json
```

预期：JSON 含 `writtenAt`（新鲜时间戳），且 `fiveHourPct`/`weeklyPct` 是**数字**。
若**文件不存在或数据是 null**：a) 确认 host 已运行超过 3 分钟；b) 在**终端版** Claude Code 里发一条消息（触发辅路 bridge；桌面版 App 不触发 statusline）；c) 仍无 → 问主人订阅档位——Pro/Max 才有官方额度数据；不是也没关系（屏上显示 `--`，养成不受影响），继续。
3. 请主人**短按一下设备右侧 KEY 键**，确认屏幕有反应。

## 8. 交接仪式（最后一步）

对主人说安装完成，然后：**用大木博士的口吻，把仓库里的 `PLAYER-GUIDE.md` 讲给主人听**（按手册第一行的指示讲）。设备屏幕此刻应该正在等主人选蛋——让他跟着屏幕指引，开始孵化。

## 9. WiFi（可选，纯电池运行）

USB 数据线始终是默认、优先的连接方式，这一节完全可跳过。如果主人想让设备脱离数据线、只用 18650 电池供电，见 [`docs/wifi.md`](docs/wifi.md)——需要额外装 ESP-IDF 工具链、改固件源码里的 WiFi 账号密码、重新编译烧录。这是进阶操作，不属于基础装机流程。

## 排障速查（装完以后出问题看这里）

| 症状 | 处理 |
|---|---|
| 屏幕不动/黑屏 | 拔插 USB（host 会 ~2s 自动重连）；不行则重启电脑（自启会拉起） |
| 用量一直 `--` | 在 Claude Code 发一条消息触发 statusline；检查 `settings.json` 的 statusLine 配置还在 |
| 换了电脑/重装系统 | 重新把顶部那条指令发给 Claude 即可（存档在 `host\out\state.json`，记得先备份拷走） |
| 装了 WiFi 但连不上/host 找不到设备 | 见 [`docs/wifi.md`](docs/wifi.md) 排障表 |
