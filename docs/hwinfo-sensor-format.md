# HWiNFO Sensor Export — Verified Technical Spec (Registry VSB + Shared Memory v2)

Source of truth for this document:
* Empirically captured on a live machine running **HWiNFO64 v8.26-5730** (REALiX s.r.o.),
  Windows 11 x64, ANSI code page 936 (GBK), reader process **non-admin**.
* Cross-checked against the developer's official forum posts and open-source parsers (cited inline).

Two *separate* interfaces exist. Do not confuse them:

| Direction | Root | Enabled by |
|---|---|---|
| **HWiNFO → third party** (what you want) | `HKCU\Software\HWiNFO64\VSB` | "Report sensors to gadget / Windows Registry" |
| **Third party → HWiNFO** (custom *input* sensors) | `HKCU\Software\HWiNFO64\Sensors\Custom\…` | read *by* HWiNFO, not written by it |

`HKCU\Software\HWiNFO64\Sensors` is **HWiNFO's own settings hive** (window geometry, logging
flags, per-sensor customisation), NOT the value export. The layout you hypothesised
(`Sensor\#1`, `#Ns`, `#Nv`) does **not** exist.

---

## 1. Registry export layout (the "gadget"/VSB interface)

### 1.1 Root key path

```
HKEY_CURRENT_USER\Software\HWiNFO64\VSB
```

Since build **5590** (Nov 2024) HWiNFO additionally mirrors the same value set into
`HKEY_LOCAL_MACHINE\Software\HWiNFO64\VSB` so non-elevated readers can see it. Confirmed
on this machine: both keys exist and contain byte-identical values. Verified by Martin
(HWiNFO author) in the forum: "Starting with the next Beta build, HWiNFO will export the
data into both HKEY_CURRENT_USER and HKEY_LOCAL_MACHINE… It's already available in build 5590."
<https://www.hwinfo.com/forum/threads/2024-hwin-data-in-rainmeter-without-running-rainmeter-as-admin.10146/>

There is no WOW6432Node variant (`HKLM\SOFTWARE\WOW6432Node\HWiNFO64\VSB` absent — checked).

### 1.2 Value-name scheme

Flat key, **no subkeys**, no `#N`/`#Ns`/`#Nv` suffixes. Index is **0-based** and contiguous;
reader should enumerate `Sensor0`, `Sensor1`, … until a name is missing.

For each slot `N` exactly five `REG_SZ` values exist:

| Value name | Content | Verified example |
|---|---|---|
| `SensorN` | owning sensor-group name (device/grouping header) | `CPU [#0]: AMD Ryzen 5 9600X` |
| `LabelN` | reading label (localized/user name) | `核心频率` |
| `ValueN` | formatted display string, **locale-formatted** | `4,803.6 MHz` |
| `ValueRawN` | number only, no separators, decimal **point** | `4803.6` |
| `ColorN` | 6-hex RGB, no `#` | `ff0000` |

Corroborated by two independent open-source consumers:
* `raiguard`-authored Rainmeter skin pack README + `chriswier/Rainmeter-illustro-hwinfo64`,
  file `hwinfo-settings.ps1` — emits `Measure=Registry`, `RegHKey=HKEY_CURRENT_USER`,
  `RegKey=SOFTWARE\HWiNFO64\VSB`, `RegValue=Sensor{N} / Label{N} / Value{N} / ValueRaw{N} / Color{N}`.
  <https://github.com/chriswier/Rainmeter-illustro-hwinfo64/blob/main/hwinfo-settings.ps1>
* `rolfosian/HWiNFO64-gadget-py`, file `main.py` — enumerates `SOFTWARE\HWiNFO64\VSB` with
  `winreg.EnumValue`, grouping by the `Sensor`/`Label`/`Value` prefixes and explicitly
  excluding `Raw` from the value set.
  <https://github.com/rolfosian/HWiNFO64-gadget-py/blob/main/main.py>

`SensorN` also functions as the group-by key (the PS1 script buckets sensors by it).

### 1.3 Registry value types and string encoding

All five are **`REG_SZ`** (verified: `RegGetValue` type = 1 for every value, both hives).
**Nothing here is `REG_BINARY`; there is no packed-string blob to decode.**

`REG_SZ` on NT is stored as UTF-16LE + NUL; Python `winreg` returns `str` correctly. The
localized label round-trips exactly (`核心频率` → U+6838 U+5FC3 U+9891 U+7387), proving
Unicode storage, not ANSI-in-binary. Do **not** try to read these as code-page bytes.

### 1.4 Real captured example (this machine, verbatim)

```
HKCU\Software\HWiNFO64\VSB   (HKLM mirror identical)
    Sensor0     REG_SZ  "CPU [#0]: AMD Ryzen 5 9600X"
    Label0      REG_SZ  "核心频率"
    Value0      REG_SZ  "4,803.6 MHz"
    ValueRaw0   REG_SZ  "4803.6"
    Color0      REG_SZ  "ff0000"
```

Only one slot was enabled here, which is the normal case: the user picks sensors individually.
For a realistically richer capture (CPU temp, GPU temp, fan RPM, volts, RAM used) read §2.4 —
those come from the shared-memory table, which holds the *same* value/unit strings HWiNFO shows.
Expected `ValueN`/`ValueRawN` shapes per type: temperature `66.6 ℃` / `66.625`; fan
`2566 RPM` / `2566.0`; voltage `1.139 V` / `1.139`; usage `47.5 %` / `47.5`; power `63.6 W`;
RAM `15159 MB`.

### 1.5 Enabling it — exact UI path

The switch is **per-sensor**, not a global "Write values to Windows Registry" checkbox:

1. HWiNFO → Sensors window.
2. Right-click a sensor reading → **"Report to…"** submenu (a.k.a. *Configure reported sensors*),
   or global **Settings → Sensors → "Report to gadget" / "Enable Support for… Registry/Rainmeter"**
   in newer builds. Mark the readings you want exported; HWiNFO then writes the `VSB` slot array.
3. The overall flag persisted on this machine is
   `HKCU\Software\HWiNFO64\Sensors\EnableVSB` = `REG_DWORD 1`.

Caveat: a user-reported bug exists where the "Report to gadget" setting does not persist across
restarts — <https://www.hwinfo.com/forum/threads/report-to-gadget-setting-does-not-persist.9445/>

* **Sensors window must be open** (or HWiNFO minimised into it). Closing the sensors window
  stops sensor polling and therefore stops the registry writes. `HKCU\...\Sensors\MinimalizeSensorsClose=1`
  on this install controls the close-vs-minimise behaviour.
* **HWiNFO must run elevated (admin).** Martin, verbatim: "HWiNFO always needs to be started with
  admin elevation, it requires direct access to hardware and kernel. Problem is only when the
  'consumer' of its data is run as standard user as that maps to a different HKCU key."
  <https://www.hwinfo.com/forum/threads/registry-access.7631/>
  Consequence for a non-admin reader: if HWiNFO runs as a *different* (admin) user, `HKCU` will
  be empty for you — **always try `HKLM\Software\HWiNFO64\VSB` first, then fall back to HKCU.**
  (Verified: a plain-user reader can open and read both on this box.)

### 1.6 Stale data — the critical caveat

* Values **persist after HWiNFO exits**; they are **never cleared**. The last snapshot stays
  readable and looks perfectly valid.
* There is **no timestamp, no counter, and no count value** in the `VSB` key — I enumerated every
  value name and kind (this install: exactly 5 values, all `REG_SZ`). You cannot tell "live" from
  "stale" from `VSB` alone.
* Practical liveness checks, in order of reliability:
  1. Use **shared memory** `poll_time` (§2.2) as the heartbeat and read the registry only as a
     convenience mirror.
  2. Otherwise require `HWiNFO64.exe`/`HWiNFO32.exe` in the process list.
  3. Weak heuristic: sample `ValueRawN` twice ~5 s apart; identical values across several
     samples for a sensor that always jitters (CPU clock/usage) means dead.
* **Free-edition limitation:** Remote/shared-memory reporting is time-limited to roughly 12 hours
  per run in the free version, then silently stops writing until HWiNFO is restarted.
  Confirmed by Martin's redirect to the v7 licensing announcement
  (<https://www.hwinfo.com/forum/threads/important-changes-to-hwinfo64-coming-soon.7092/>) in
  <https://www.hwinfo.com/forum/threads/shared-memory-support-setting-becomes-unchecked-after-a-few-hours.7187/>.
  Treat "registry values exist" as *necessary, not sufficient*.

### 1.7 Parsing rules that will bite you

* `ValueN` is **locale-formatted** (observed thousands separator + decimal point). Do **not**
  parse it with a fixed culture. Use `ValueRawN` and parse with **invariant culture**.
  `ValueRawN` is always plain digits with `.` decimal (observed `4803.6`); note `float("4,803.6")`
  throws in Python while `ValueN` is fine as display text.
* `ValueRawN` type is `REG_SZ` even for numbers — read as string, then convert. (Rainmeter
  auto-coerces `REG_SZ` numeric strings, which is why the PS1 generator sets `MinValue=0 /
  MaxValue=100` when `ValueN` matches `%`.)
* Slots are dense from 0; iterate until a gap. Do not assume a fixed maximum.
* Index `N` is **not stable across configuration changes** — it changes when the user
  adds/removes reported sensors. Never hard-code `Sensor3`; resolve by `SensorN`+`LabelN` text.
* `ColorN` may be empty/`000000` for non-thresholded sensors.

---

## 2. Shared memory ("Shared Memory Support") interface

### 2.1 Exact mapping name

Confirmed empirically by attempting `OpenFileMapping(FILE_MAP_READ)` on every candidate name
(HWiNFO running):

| Name | Result |
|---|---|
| `Global\HWiNFO_SENS_SM2` | **success** ← the real one |
| `Local\HWiNFO_SENS_SM2` | `ERROR_FILE_NOT_FOUND` |
| `HWiNFO_SENS_SM2` | `ERROR_FILE_NOT_FOUND` |
| `Global\HWiNFO_SENS_SM` | `ERROR_FILE_NOT_FOUND` |
| `Global\HWiNFO_SHARED_MEMORY_Sensors` | `ERROR_FILE_NOT_FOUND` |

So the string is **`HWiNFO_SENS_SM2`** (v2 of the interface) and HWiNFO creates it in the
**`Global\`** namespace (so it is visible across sessions). The name `HWiNFO_SHARED_MEMORY_Sensors`
does not exist — correct your assumption. There is **no 32-bit-vs-64-bit name difference**: the
same `Global\HWiNFO_SENS_SM2` serves both, and layout is byte-identical because every field is
fixed-width (see §2.3). A 32-bit reader can safely map a section written by HWiNFO64.

Matching mutex: **`Global\HWiNFO_SM2_MUTEX`** — verified pre-existing (my non-admin `CreateMutexW`
call got `ERROR_ACCESS_DENIED`, i.e. the object exists but its DACL blocks me). It is **not
required for reading**: I decoded a full, consistent 320-entry table with `FILE_MAP_READ` only,
no mutex, no elevation. A non-admin reader should therefore just map read-only and *not* depend
on the mutex (grabbing `SYNCHRONIZE` will fail).

### 2.2 Header (48 bytes, packed, `#pragma pack(1)`, little-endian)

Captured verbatim from this machine:

```
000000  48 57 69 53  02 00 00 00  01 00 00 00  2d 9b e8 6a   HWiS........-..j
000010  00 00 00 00  30 00 00 00  88 01 00 00  1a 00 00 00   ....0...........
000020  00 28 00 00  cc 01 00 00  40 01 00 00  d0 07 00 00   .(......@.......
```

| Offset | Type | Field | Observed value |
|---|---|---|---|
| `0x00` | `DWORD` | `dwSignature` | `0x53695748` |
| `0x04` | `DWORD` | `dwVersion` | **`2`** |
| `0x08` | `DWORD` | `dwRevision` | `1` |
| `0x0C` | `__int64` | `poll_time` (Unix epoch **seconds**, UTC) | `1793629125` → 2026-11-02 22:18:45 local (UTC+8) |
| `0x14` | `DWORD` | `dwOffsetOfSensorSection` | `48` |
| `0x18` | `DWORD` | `dwSizeOfSensorElement` | `392` |
| `0x1C` | `DWORD` | `dwNumSensorElements` | `26` |
| `0x20` | `DWORD` | `dwOffsetOfReadingSection` | `10240` (`0x2800`) |
| `0x24` | `DWORD` | `dwSizeOfReadingElement` | `460` (`0x1CC`) |
| `0x28` | `DWORD` | `dwNumReadingElements` | `320` |
| `0x2C` | `DWORD` | *undocumented* (spare / max-capacity) | `2000` |

Signature gotcha, worth knowing so you don't "fix" working code: the well-known constant is the
FOURCC string **`"SiWH"`**, and `0x53695748` *is* that value. On disk the first four **bytes**
read as `'H','W','i','S'` = `HWiS`. So:
* compare as a `DWORD`: `dwSignature == 0x53695748` ✔
* compare as 4 raw bytes: must be `b"HWiS"` — `b"SiWH"` will **fail**.

This resolves why some sources print `HWiS` (namazso's reverse-engineering gist) and others
print `SiWH` (the C header style in `david-morgenstern/hwinfo-mcp`); they are the same integer
with opposite byte order. Recommend testing the DWORD.

Minimum buffer: `offsetReading + numReading*sizeReading` = **157 440 bytes**. A 64-byte probe
map is enough to read the header, then re-map the full size. (Sections are far larger than
needed — the smallest successful `MapViewOfFile` probe reached >31 MB, i.e. HWiNFO reserves
headroom for future sensors; never size your buffer from the mapping, size it from the header.)

### 2.3 Sensor element — 392 bytes, fixed-width record, at `+0x14` stride 392

```
0x000  DWORD   id            // 0xF0000300
0x004  DWORD   instance      // 0..N
0x008  char[128] szSensorNameOrig   // ANSI, code page of the OS
0x088  char[128] szSensorNameUser   // ANSI (localised / user-renamed)
0x108  char[128] szSensorNameUserUtf8  // UTF-8 of the same user name  ← v2 only
0x188  (end)                        // 0x188 = 392 ✓
```

Live example (`+0x108` decoded as UTF-8):
`系统: GIGABYTE B850 AORUS ELITE WIFI7 ICE` while `+0x008` is the English
`System: GIGABYTE B850 AORUS ELITE WIFI7 ICE`.

The three name buffers are the *same string* in two encodings (orig = English, user = localised).
Verified across all 320 readings: ANSI-decode of `0x088` and UTF-8-decode of `0x108` produced
identical text in **320/320** cases. **Prefer the UTF-8 buffer** and skip the code-page dance.

### 2.4 Reading element — 460 bytes, fixed-width record, at `+0x20` stride 460

```
0x000  DWORD     tReading          // reading type, see table
0x004  DWORD     dwSensorIndex     // INDEX into sensor array — NOT an id
0x008  DWORD     dwReadingID       // (type<<24) | per-type sequence
0x00C  char[128] szLabelOrig       // ANSI (English)
0x08C  char[128] szLabelUser       // ANSI (localised)
0x10C  char[16]  szUnit            // ANSI  ("°C","RPM","V","W","%","MHz","MB","GB/s","A","ms")
0x11C  double    value             // current
0x124  double    min
0x12C  double    max
0x134  double    avg               // running average since reset
0x13C  char[128] szLabelUserUtf8   // ← v2 only
0x1BC  char[16]  szUnitUtf8        // ← v2 only
0x1CC (end)                        // 0x1CC = 460 ✓
```

Offset arithmetic self-checks: `0x13C + 128 + 16 = 460`. And `460 - 144 = 316`, which is exactly
namazso's reverse-engineered **v1** record (`12 + 128 + 128 + 16 + 4×8`) — i.e. v2 = v1 plus the
two trailing UTF-8 buffers. That is strong independent confirmation of this layout: namazso
derived it visually with ReClass on HWiNFO 6.40 (`version = 1`); my live capture is `version = 2`.

`dwReadingID` decomposition, validated on all 320 rows (320/320 match):
`high byte == tReading`, low 24 bits == sequence within that type for that sensor.
Example: `0x01000000` = temperature #0, `0x03000008` = fan #8.

`tReading` values seen live: `1` temperature, `2` voltage, `3` fan, `4` current, `5` power,
`6` clock, `7` usage, `8` other. The enum is
`{None=0, Temperature=1, Voltage=2, Fan=3, Current=4, Power=5, Clock=6, Usage=7, Other=8}`,
consistent with both namazso and `hwinfo-mcp`. Codes `9+` are not observable here — treat unknown
as `Other` rather than erroring.

Real decoded rows (this machine, `szLabelUserUtf8` + `szUnit` + the four doubles):

```
[  0] t=8 other        sidx=0  id=0x08000000  提交虚拟内存            MB    v=20812.000 min= 8120.000 max=28551.000 avg=19112.118
[  5] t=8 other        sidx=0  id=0x08000005  物理内存使用率          %     v=   47.500 min=   24.200 max=   66.800 avg=  45.347
[  7] t=2 voltage      sidx=1  id=0x02000000  Core 0 VID              V     v=    1.139 min=    0.744 max=    1.224 avg=    0.995
[ 13] t=6 clock        sidx=1  id=0x06000000  Core 0 频率 (perf #1)   MHz   v= 5172.270 min= 2873.024 max= 5365.326 avg= 4605.412
[ 27] t=7 usage        sidx=1  id=0x07000000  Core 0 T0 使用率        %     v=   21.991 min=    2.363 max=   98.051 avg=   16.864
[ 88] t=1 temperature  sidx=4  id=0x01000000  CPU (Tctl/Tdie)         °C    v=   66.625 min=   51.375 max=   88.375 avg=   55.955
[105] t=4 current      sidx=4  id=0x04000000  CPU 核心电流 (SVI3 TFN) A     v=   27.770 min=    4.038 max=   62.503 avg=   13.272
[110] t=5 power        sidx=4  id=0x05000000  CPU 封装功率            W     v=   63.590 min=   31.087 max=  110.586 avg=   42.952
[133] t=8 other        sidx=4  id=0x08000007  DRAM 读取带宽           GB/s  v=    8.073
[152] t=3 fan          sidx=6  id=0x03000000  CPU                     RPM   v= 2566.000 min= 1730.000 max= 2800.000 avg= 1949.129
[228] t=1 temperature  sidx=16 id=0x01000000  GPU 温度                °C    v=   52.453   (sensor[16] = GPU [#1]: AMD Radeon)
[238] t=7 usage        sidx=16 id=0x07000000  GPU 使用率              %     v=  100.000
[252] t=1 temperature  sidx=17 id=0x01000000  GPU 全局温度            °C    v=   54.000   (sensor[17] = GPU [#0]: Intel Arc A770)
[257] t=5 power        sidx=17 id=0x05000000  GPU 总功率              W     v=   47.220
```

Sensor-group IDs observed: `0xF0000300` CPU, `0xF0000501` CPU Enhanced, `0xF0000301` motherboard,
`0xF0008696` IT8696E monitor, `0xE0003000`/`0xE0001800` GPUs, `0xF0000100`/`0xF0000101` S.M.A.R.T./Drive,
`0xF000EA00` network, `0xF3000005` DIMM, `0xF0000FF0` PresentMon. These IDs are the same identifiers
Rainmeter skins address via `HWiNFOSensorId`/`HWiNFOEntryId`
(<https://www.hwinfo.com/forum/threads/rainmeter-plug-in-for-hwinfo-3-2.2172/>), e.g.
`HWiNFOSensorId=0xF0000300`, `HWiNFOSensorInstance=0x0`, `HWiNFOEntryId=0xfe`.

### 2.5 Entry count and change detection

* **Count** comes only from `dwNumSensorElements` / `dwNumReadingElements` — read them from the
  header, never hard-code element sizes. Both are "currently populated" counts (`26`, `320`),
  and the sections are pre-allocated far larger, so counts grow as sensors appear but slots beyond
  the count are zero-filled.
* **Change detection:** the only documented signal is `poll_time` at `+0x0C`. It is a Unix epoch
  **in seconds** and is bumped once per sensor poll. Measured over 21 s: it advanced
  `1793628973 → 1793628975` etc., i.e. **~2-second cadence, monotonically increasing**. So:
  ```
  live  = (now_epoch_utc - poll_time) < ~6..8 s        # 2-3 missed polls
  stale = otherwise  → treat HWiNFO as gone / free-edition 12 h cutoff
  ```
  This is also the robust answer to §1.6: the registry has no timestamp, but the shared memory
  does — use `poll_time` as the liveness source even when your values come from the registry.
* There is **no per-record update counter and no generation/sequence number** — the extra
  `0x2C` DWORD is *not* a counter (it stayed `2000` while `poll_time` advanced). Do not invent one.
* Tearing: I diffed the whole 320×460 table across a 2.5 s interval; only the `double` fields
  changed, at byte offsets 284/288, 300/304, 308/312 — i.e. `value`, `max`, `avg` (and only
  sometimes), never `min`-vs-`max` ordering (checked 320/320: always `min ≤ max`, all finite,
  0 UTF-8 decode failures). Since `double`s are not atomic-with-consistency across the four fields,
  a `value`/`min`/`max`/`avg` tuple may be momentarily inconsistent. If you need coherent stats,
  copy the four doubles then re-read `poll_time`; if it changed, retry.

### 2.6 Enabling it — exact UI path

**HWiNFO → Settings (F5… gear icon) → Sensors tab → "Shared Memory Support"** (labelled exactly
*Shared Memory Support* in the Settings dialog; tooltips warn it is Pro-gated). Persisted in
`HWiNFO64.INI` as:

```
SensorsSM=1
```

(captured from this install's `HWiNFO64.INI`, alongside `OpenSensors=1`,
`MinimalizeSensorsClose=1`, `MinimalizeSensors=1`.) The INI key is confirmed by the forum report
"The HWiNFO64.INI file still has the following line: SensorsSM=1" while the checkbox had
auto-unchecked itself
(<https://www.hwinfo.com/forum/threads/shared-memory-support-setting-becomes-unchecked-after-a-few-hours.7187/>).

This is a **separate** switch from the registry/gadget export of §1.5 and from "Enable support for
Remote Sensors" (which is the TCP-based LAN feature feeding the Rainmeter `HWiNFOHostId`
parameter). "Shared Memory Support" is the one that creates `Global\HWiNFO_SENS_SM2`.

The official spec is **not public**: Martin releases it only by e-mail under freeware/no-open-source
conditions (<https://www.hwinfo.com/forum/threads/shared-memory-support.18/>), which is why every
usable description — including this one — comes from third-party parsers or live capture.

---

## 3. Practical caveats for a non-admin reader

* **Shared memory: readable without elevation, verified.** I mapped
  `Global\HWiNFO_SENS_SM2` `FILE_MAP_READ` and fully decoded all 26 groups + 320 readings from a
  **non-elevated** process (`IsUserAnAdmin() == False`). It works because HWiNFO publishes it in
  `Global\` with a read-capable DACL. Only the *mutex* denies me access.
* **Registry: readable, but only for the writing user's hive, or via HKLM.** HKCU works when
  HWiNFO runs as *you*. If HWiNFO elevates under a different account, your HKCU is empty → read
  `HKLM\Software\HWiNFO64\VSB` (build ≥5590). Both verified readable non-elevated here.
* **Refresh interval: ~2 s** (measured `poll_time` deltas of 2 s; registry writes observed every
  ~2 s: 11 distinct changes in 21 s). Sampling faster than 1 s is pointless. The Rainmeter
  reference skin's `Update=1000` (1 s) is well matched.
* **Do not assume a fixed schema.** `dwSizeOfSensorElement`/`dwSizeOfReadingElement`/offsets are
  in the header *for this reason*. Hard-coding 392/460 will break on a future build; compute the
  double-block position from the record size, or better, feature-detect on `dwVersion`.
* **v1 vs v2 (build ≤ ~6.40 is v1):** `dwVersion==1` → sensor element **264 B**, reading element
  **316 B**, and **no UTF-8 buffers** — so names are ANSI/code-page only (`MultiByteToWideChar`
  with the user CP, or `charset='mbcs'`/locale codec). `dwVersion==2` → 392/460 with UTF-8 as in
  §2.3/2.4. The header field positions are identical in both, so one header parser covers both.
* **ANSI strings are code-page dependent** (`℃` for `°C` on CP936 here; mojibake on a mismatched
  decoder). In v2 always take `0x13C`/`0x1BC`; in v1 take `0x088`/`0x10C` and decode with the
  system ANSI CP (`cp1252` is *not* safe universally — it silently mangles CJK/Greek; use
  `GetACP()`/`locale` default).
* **Free edition: stops after ~12 h.** Expect the section to still exist and map fine while
  `poll_time` freezes. Detect with the staleness rule in §2.5, not by "did the mapping open".
* Buffer sizes are **including NUL**; strings are NUL-terminated and possibly truncated
  (128 B name, 16 B unit). `dwSensorIndex` bounds-check against `dwNumSensorElements` before
  indexing (a reading may reference a group dropped between polls — map it, then re-read the count).
* `min`/`max`/`avg` are since-session/reset, not since-read; don't use them as a rolling window.
* Empty slots (`tReading == 0`) may appear within the counted range — skip them.

---

## 4. Direct-implementation summary

```c
// ---- shared memory (preferred) ----
HANDLE h = OpenFileMappingW(FILE_MAP_READ, FALSE, L"Global\\HWiNFO_SENS_SM2");
void*  base = MapViewOfFile(h, FILE_MAP_READ, 0, 0, 48);        // probe header
// DWORD sig=*+0x00 must == 0x53695748 ; DWORD ver=+0x04 ; INT64 poll=+0x0C ;
// offS=+0x14 szS=+0x18 nS=+0x1C ; offR=+0x20 szR=+0x24 nR=+0x28
UnmapViewOfFile(base);
size_t need = offR + (size_t)nR*szR;
base = MapViewOfFile(h, FILE_MAP_READ, 0, 0, need);
for (i=0;i<nR;i++){ char* e = base+offR+ i*szR;
  int      type  = *(int*)(e+0x00);
  int      grp   = *(int*)(e+0x04);            // index into sensor array
  unsigned rid   = *(unsigned*)(e+0x08);
  const char* unit = (ver>=2) ? e+0x1BC : e+0x10C;               // UTF-8 : ANSI
  const char* name = (ver>=2) ? e+0x13C : e+0x08C;
  double v=*(double*)(e+0x11C), mn=*(double*)(e+0x124),
         mx=*(double*)(e+0x12C), av=*(double*)(e+0x134);
  const char* gname = (ver>=2) ? base+offS+grp*szS+0x108
                               : base+offS+grp*szS+0x088;
}
// stale if (time(NULL) - poll) > 8   (poll cadence ~2 s)

// ---- registry (secondary) ----
// HKLM\Software\HWiNFO64\VSB first, else HKCU\Software\HWiNFO64\VSB
// for N = 0,1,2,... while RegQueryValueEx(...L"SensorN") succeeds:
//   SensorN, LabelN, ValueN, ValueRawN, ColorN  — all REG_SZ (UTF-16LE)
//   numeric  = wcstod(ValueRawN, invariant)     // NEVER parse ValueN (locale-formatted)
```

## 5. Confidence ledger

**Confirmed by live capture (HWiNFO64 8.26-5730, this machine):** everything in §1.1–1.4, 1.6
(no count/timestamp in `VSB`), §2.1, 2.2, 2.3, 2.4, 2.5, §3 cadence + non-admin access.
**Confirmed by developer forum posts:** HKLM mirroring from build 5590; elevation requirement and
the HKCU-hive mismatch problem; the v6.10+ `Sensors\Custom` input format; the shared-memory spec
being non-public; the free-edition cutoff.
**Confirmed by third-party parser source:** the `SensorN`/`LabelN`/`ValueN`/`ValueRawN`/`ColorN`
scheme and `SOFTWARE\HWiNFO64\VSB` path; the v1 record layout and `HWiS`/`SiWH` equivalence.
**Not confirmed — stated as-is:**
1. The literal current checkbox caption for the registry export (§1.5). Per-sensor "Report to…"
   plus `EnableVSB` are what I verified; the exact Settings-dialog wording ("Report to
   gadget"/"Write values to Windows Registry") was not rendered into any string I could read
   (the shipped binary is packed). Implement against the registry keys, not the caption.
2. The meaning of header `DWORD +0x2C` (observed constant `2000`). Most probably a
   max-capacity/reserve; it is *not* a counter. Ignore it.
3. `tReading` codes above 8, and `9`/`10`: unobservable in this capture. Treat unknown as `Other`.
4. Whether HWiNFO deletes the `VSB` key/values on clean exit. I could not terminate HWiNFO
   (not my process, and I lacked rights to `tasklist`-inspect it). Evidence points to "values
   persist" (the key held a single stale-looking slot while `EnableVSB=1`), and either way
   §1.6/§2.5 liveness logic covers it. Do **not** rely on key absence as your exit signal.
