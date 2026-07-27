# Claude Pokémon Buddy

一台桌面小设备：**左半屏是你的 Claude 用量仪表盘，右半屏是一只用你的 Claude 用量"养"大的宝可梦**——会表演、会进化、几天不理会蔫（但永远救得回来）。单色 1-bit 反射屏，原生 GB 质感。

- 硬件：Waveshare **ESP32-S3-RLCD-4.2**（4.2" 反射屏 400×300、喇叭、温湿度、RTC、KEY/BOOT 两键、18650 电池、USB-C）
- 架构：**固件只是"笨显示器"**（收帧/回按键/放音），全部逻辑与存档在电脑侧 Node host（Windows/Mac）。传输默认走 USB 数据线；也可选启用 **WiFi**（设备连本地网、mDNS 广播、host 自动发现），USB 优先、找不到才试 WiFi，两者共用同一套协议，见 [`docs/wifi.md`](docs/wifi.md)
- 数据源：Claude Code 官方 statusline `rate_limits`（5h/周额度）+ ccusage（费用/token）

## 我收到了这台设备，怎么装？

把 [`SETUP-WINDOWS.md`](SETUP-WINDOWS.md) 交给你的 Claude 执行——它是写给 Claude 的安装手册，从零环境到屏幕亮起全自动。手册顶部有可以直接转发的那条指令。

装好后想了解怎么玩：[`PLAYER-GUIDE.md`](PLAYER-GUIDE.md)（也可以让你的 Claude 讲给你听）。

## 开发（owner）

- host：`cd host && npm install && node src/index.js`（无板时自动 mock，输出 `out/frame.png`）
- macOS 自启：`cd host && node scripts/autostart-macos.mjs status|install|uninstall`（写入用户 LaunchAgent，日志 `out/host.log`）
- 测试：`cd host && npm test`（已固化 `--test-concurrency=4` 和文件过滤，见 `package.json`）
- 固件：ESP-IDF 项目在 `firmware/`；发布流程见 [`docs/firmware-release.md`](docs/firmware-release.md)；WiFi 传输配置见 [`docs/wifi.md`](docs/wifi.md)；断连自动/手动切换简易时钟见 [`docs/local-clock-mode.md`](docs/local-clock-mode.md)
- 设计文档：`docs/specs/`（自 2026-05-30 起的全部设计与增量修订）

## 声明

粉丝作品（fan project），非商业、不出售、与任天堂/宝可梦公司无关；仓库不含任何官方 ROM/游戏资产。Pokémon © Nintendo / Creatures Inc. / GAME FREAK inc.
