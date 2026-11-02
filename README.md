# dsh-agent-hardware-sensors

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：把本机硬件传感器读数接进对话，让 agent 能回答"现在 CPU 多少度"、"风扇转速多少"，同时在界面上挂一个小读数条。

数据来源是 **AIDA64** 或 **HWiNFO** 的传感器导出。

## 核心设计：谁开着读谁，两个都不要求

- 两个源**各自独立探测**，谁在导出数据就读谁
- 两个都没开时，插件**静默缺席**：不报错、不弹窗、不打扰
- 只有一个装着并开着，就只显示那一列
- 两个都在，就并排双列方便对比

这不是"任意软件适配"的通用传感器库，而是专门对接这两个软件导出格式的读取器 —— 因为它们的导出格式各有各的坑，值得认真处理（见 [`docs/`](docs/)）。

## 安装

桌面端（官方 Electron 客户端）读的是 **`desktop` profile**，普通 CLI 拒绝管理它，必须用桌面客户端自带的 CLI 入口：

```powershell
& "<安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add link:<本目录绝对路径>
```

Web profile 用：

```bash
dsh plugin --profile web add link:<本目录绝对路径>
```

装完重启客户端（新 bundle 行需要宿主重新收集注入表）。

## 开启数据导出（任选其一，或都开）

### HWiNFO（免费，推荐）

1. **以管理员身份运行**，并保持传感器窗口打开（关掉窗口就停止轮询）
2. `Settings → Sensors →` 勾选 **Shared Memory Support**（持久化为 `HWiNFO64.INI` 的 `SensorsSM=1`）
3. 若想额外走注册表通道：在传感器窗口对具体读数**右键 → Report to… → Windows Registry**（这是**逐个传感器**的开关）

| 通道 | 位置 | 特点 |
|---|---|---|
| 共享内存（优先） | `Global\HWiNFO_SENS_SM2` | 定长结构体，含单位/类型/`poll_time`，免提权可读 |
| 注册表（兜底） | `HKLM\|HKCU\Software\HWiNFO64\VSB` | 扁平 `SensorN/LabelN/ValueN/ValueRawN/ColorN` |

> ⚠ 注册表这份在 HWiNFO 退出后**不会清除、也没有时间戳**。插件会叠加进程存活判断，把它标为"已停止更新"而不是当成实时读数。

### AIDA64（付费）

`File → Preferences → Hardware Monitoring → External Applications →`
勾选 **Enable writing sensor values to Registry**（或 shared memory），并在下方列表里勾选**具体要导出的传感器**（两者都要，否则键在但没数据）。

| 通道 | 位置 | 特点 |
|---|---|---|
| 注册表（优先） | `HKCU\Software\FinalWire\AIDA64\SensorValues` | `Label.<ID>` / `Value.<ID>`，都是 `REG_SZ`，**不导出单位** |
| 共享内存 | `AIDA64_SensorValues` | 一段 NUL 结尾的 **XML 片段** |

AIDA64 退出时**整键删除**，所以"键在"就等于"活着"。

## agent 工具

```
hw_sensors(category?, match?, limit?, refresh?)
```

| 参数 | 说明 |
|---|---|
| `category` | `temperature` / `fan` / `voltage` / `current` / `power` / `clock` / `usage` / `data` / `other` / `all` |
| `match` | 按 id 或标签子串过滤（大小写不敏感，空格分隔命中任一即可），如 `"cpu gpu"` |
| `limit` | 默认 200，上限 400 |
| `refresh` | `true` 强制重采样（忽略 ≤1.2s 缓存） |

返回 `sources[]`（每个 app 的 available / transport / stale / reason / note）+ `sensors[]`，按类别与重要性排序（CPU 封装温度打头）。

两个源都没数据时返回 `live:false` 与一句提示，**不抛错**。

## 界面

**右下角读数条**：默认显示最要紧的几条（CPU/GPU 温度、占用、功耗、风扇）。

- 拖动标题移动位置（记在 localStorage）
- 点标题展开/收起列表
- 点 `◦` 循环 **完整 → 精简 → 隐藏**
- **Shift+点击 `◦`** 彻底收起（连可点回的小圆点都不留，停止轮询省资源）
- 恢复入口在详细面板里（「显示悬浮提示」开关）

**左上角标题栏图标**：贴在原生菜单（应用/编辑）右侧的 28px 图标，右下角状态点表示绿色实时 / 橙色停更 / 灰色无源。

**详细面板**：按数据源分列、按设备分组、全量读数、可搜索、可刷新。

**数据源变化提醒**：源接入/离线/停止更新时弹提示，同一提醒去重不刷屏。

## 测试

```bash
node test/run.mjs          # 全部（含真实浏览器验证）
node test/run.mjs --unit   # 跳过浏览器
```

需要本机有 AIDA64/HWiNFO 才能验证真实数据的套件会自行跳过或只验证降级路径，不会误报。

浏览器验证会按优先级探测 Chrome/Edge/Chromium，也可用 `CHROME_PATH` 指定；找不到则自动跳过。

## 实现要点（踩过的坑都在代码注释里）

| 坑 | 说明 |
|---|---|
| **注入行必须最先注册** | 桌面端 index 注入表由宿主启动时收集一次且无刷新路径，订阅晚了就永远不出现 |
| **注入用内联 `script` 而非 `script-src`** | 后者会 `await`，失败即 reject 掉 `__DSH_BOOT_READY__` ⇒ 整个应用起不来 |
| **读注册表走 `reg export`** | `reg query` 用控制台代码页（中文机 GBK），`核心频率` 会变乱码；`.reg` 是 UTF-16LE 无歧义 |
| **`.reg` 节头路径不做反转义** | 实测单反斜杠；当转义处理会吃掉每个 `\`，键路径永远匹配不上 |
| **共享内存必须显式请求 Read** | .NET `OpenExisting(name)` 默认按读写申请，HWiNFO 映射 DACL 只给非管理员读 |
| **PowerShell 包装 .NET 异常** | 直接看 `$_.Exception.GetType()` 永远拿不到 `FileNotFound`，必须走 InnerException |
| **SM2 签名按 DWORD 比较** | 原始字节读出来是 `HWiS` 不是 `SiWH`，字节串比较会静默失败 |
| **数字从 `ValueRawN` 解析** | `ValueN` 是本地化文本（`4,322.5 MHz`），AIDA64 甚至可能是 `17,24` 逗号小数 |
| **宿主不继承交互式 PATH** | `reg.exe` / `tasklist.exe` / `powershell.exe` 全走 System32 绝对路径 |
| **工具参数自己校验** | 普通定义走 `ctx.tools.register` 时宿主只校验 `output.schema`，未声明的键会被静默忽略 |
| **单例清理要在建节点之后** | 先扫描再创建时 `host` 还是 null，会把刚建的节点一起删掉 |

## 目录结构

```
lib/index.js      Host：hw_sensors 工具、认证路由、挂件注入行
lib/store.js      数据层：缓存、单飞、冷源退避、源变化事件
lib/hwinfo.js     HWiNFO：注册表 VSB + 共享内存 SM2
lib/aida64.js     AIDA64：注册表 SensorValues + 共享内存 XML
lib/regfile.js    `reg export` 的 UTF-16LE .reg 解析器
lib/spawn.js      子进程辅助（绝对路径解析、不 detach）
lib/liveness.js   进程存活探针
assets/widget.js  浏览器半边（纯 DOM，零依赖）
cordis.patch.yml  bundle 挂载声明
```

## 许可与合规

- 本插件代码 **MIT**（见 [`LICENSE`](LICENSE)）
- **HWiNFO 共享内存的结构布局不是官方公开规范**。作者在官方论坛说明该规范仅以邮件提供，且要求开源消费者的"接口部分必须保持二进制形式"。本仓库公开的是**逆向 + 实测得出的解析实现**，发布前请自行评估是否与你的分发方式冲突（详见 [`LICENSE`](LICENSE) 与 [`docs/hwinfo-sensor-format.md`](docs/hwinfo-sensor-format.md)）
- AIDA64 / HWiNFO 均为第三方专有软件，本插件只读取它们导出的数据，**不捆绑、不修改、不代替它们运行**

## 文档

- [`docs/aida64-sensor-export.md`](docs/aida64-sensor-export.md) —— AIDA64 两种导出格式的完整规范
- [`docs/hwinfo-sensor-format.md`](docs/hwinfo-sensor-format.md) —— HWiNFO 注册表 VSB 与共享内存 SM2 的完整规范

## 卸载

```powershell
& "<安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-agent-hardware-sensors
```
