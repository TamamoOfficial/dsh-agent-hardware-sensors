# AIDA64 sensor-export format — implementation spec

Scope: the two machine-readable exports FinalWire provides — **Registry** and **Shared Memory**
(plus WMI/RTSS notes). Verified against official FinalWire docs, official doc screenshots, a real
captured shared-memory dump, three independent third-party parsers, and a live local AIDA64 install.

**TL;DR — your assumed format is wrong in three ways:**

| You expected | Actual |
|---|---|
| Suffixes `ID_AL` / `ID_NV` / `ID_SV` | **Prefixes** `Label.<ID>` / `Value.<ID>` |
| A unit suffix / unit value | **No unit is exported at all** — unit is implied by sensor type |
| Shared memory = records of null-terminated fields | Shared memory = **one NUL-terminated XML fragment** |

Also: localized-label variants **do not exist** — labels are always English by design.

---

## 1. Registry export

### 1.1 Key path

```
HKEY_CURRENT_USER\Software\FinalWire\AIDA64\SensorValues
```

- **HKCU only**, never HKLM. Official: [aida64.com External Applications](https://www.aida64.com/user-manual/hardware-monitoring/external-applications?language_content_entity=en), [HelpMax mirror](http://aida64.helpmax.net/en/external-applications/registry/)
- **No subkeys.** Everything is a flat value list directly on `SensorValues`. Verified in both official
  screenshots (the tree shows `SensorValues` with no children) and by
  [`RegistryReader.cs`](https://github.com/Seraksab/AIDA64.SensorValues.Net/blob/main/AIDA64.SensorValues/Readers/RegistryReader.cs),
  which only calls `GetValueNames()` and never enumerates subkeys.
- The `(Default)` value exists but is **`(value not set)`** — ignore it.
- **WOW64 note (important, and easy to get wrong):** AIDA64's `aida64.exe` is a **32-bit** binary
  (verified locally: PE `Machine = 0x014c`, PE32 magic `0x10b`). HKCU `Software` is *not*
  redirected by WOW64 by default (only `Software\Classes` is), and empirically on this machine the
  32-bit AIDA64 wrote its config to the **non-redirected** `HKCU\Software\FinalWire\AIDA64`
  (`HKCU\Software\Wow6432Node\FinalWire` does not exist, even though `HKCU\Software\Wow6432Node` does).
  → **Open the key with `KEY_WOW64_64KEY` (or just don't bother specifying) — do NOT use `KEY_WOW64_32KEY`.**
  Both official screenshots show the key at the plain path; the modern one even shows the address bar
  as `Computer\HKEY_CURRENT_USER\SOFTWARE\FinalWire\AIDA64\SensorValues`.

### 1.2 Value-name convention — the exact suffix/prefix set

Exactly **two** name forms, both `REG_SZ`:

| Value name | Type | Contents |
|---|---|---|
| `Label.<ID>` | `REG_SZ` | Human-readable English label, e.g. `CPU Package` |
| `Value.<ID>`  | `REG_SZ` | Numeric/string reading as *text*, e.g. `71`, `1.368`, `DDR5-6200` |

- **Both are `REG_SZ`. Not `REG_EXPAND_SZ`, not `REG_BINARY`, not `REG_DWORD`.** Confirmed by the
  `Type` column in both official screenshots (every row reads `REG_SZ`) and by
  [ComputerBild](https://www.computerbild.de/artikel/cb-Tipps-Windows-Windows-CPU-Temperatur-in-wenigen-Schritten-anzeigen-31574363.html):
  *"zahlreiche Registry-Einträge vom Typ Zeichenfolge (REG_SZ)… Die CPU-Temperatur ist im REG_SZ `Value.TCPU` enthalten."*
- **There is no unit value and no unit suffix.** No `Unit.<ID>`, no `_UL`, nothing. Units are carried
  only by the *sensor type*, which in the registry you must infer from the ID's first letter (§1.3).
- **There are no localized-label variants.** FinalWire states explicitly: *"Sensor value labels are
  always displayed in English, they are not localized."* So there is no second label family.
- **No third prefix has ever been observed** — not in the 2014-era doc screenshot, not in the current
  one, not in the parser source. Still, parse tolerantly: read `Label.`/`Value.` and **silently ignore
  any other prefix** rather than erroring, in case FinalWire adds one.
- `<ID>` may itself contain `.` and `-` (e.g. `TCC-1-1`, `SDRAMFSB`). Since the prefix is a fixed
  6-character literal (`"Label."` / `"Value."`), strip by `StartsWith` + fixed offset, **not** by
  splitting on `.`. That is exactly what `RegistryReader.cs` does (`name[6..]`).
- Labels are **not guaranteed present** for every ID (see the tolerant merge in
  `RegistryReader.cs`: it yields `""` when a `Value.X` has no `Label.X`). Treat missing label as empty,
  and treat a label with no value as a sensor that is currently unreported.

### 1.3 Sensor IDs: shape and type inference

The ID's **first character encodes the category** — this is the only place the type survives into the
registry, and it is how `RegistryReader.cs` classifies sensors:

| 1st char | Category | XML element | Example IDs |
|---|---|---|---|
| `S` | System | `<sys>` | `SCPUCLK`, `SCPUUTI`, `SUSEDMEM`, `SMEMSPEED` |
| `T` | Temperature | `<temp>` | `TCPU`, `TCPUPKG`, `TCC-1-1`, `TGPU1`, `THDD1` |
| `F` | Fan speed | `<fan>` | `FCPU`, `FSYS`, `FFAN1`, `FGPU1` |
| `D` | Fan duty cycle | `<duty>` | `DCPU`, `DSYS`, `DGPU1` |
| `V` | Voltage | `<volt>` | `VCPU`, `V33V`, `VP12V`, `VBAT`, `VDIMM` |
| `C` | Current | `<curr>` | `CCPU`, `CP12V`, `CVRM` |
| `P` | Power | `<pwr>` | `PCPU`, `PCPUPKG`, `PGPU1` |
| `W` | Water flow | `<flow>` | `WFLOW1` … `WFLOW20` |
| `L` | Liquid level | *(not in the reader's list)* | `LLIQ1` … `LLIQ4` |

Full authoritative ID list (every ID, with its English label):
<https://www.aida64.com/user-manual/hardware-monitoring/external-applications/complete-sensor-value-list?language_content_entity=en>

Note `LLIQ*` exists in the ID list and in AIDA64's internal namespace, but the C# reader's type map
stops at `flow` → liquid levels map to `Unknown` there. Handle `L` explicitly.

### 1.4 Real captured examples

**Current official screenshot** — <https://www.aida64.com/sites/default/files/inline-images/registry-sensorvalues_light.png>

| Value name | Type | Data |
|---|---|---|
| `Label.VDIMM` | REG_SZ | `DIMM` |
| `Label.VGPU1` | REG_SZ | `GPU Core` |
| `Label.VP12V` | REG_SZ | `+12 V` |
| `Label.VP5V` | REG_SZ | `+5 V` |
| `Label.VPCH10V` | REG_SZ | `PCH +1.0 V` |
| `Label.VVCCIO` | REG_SZ | `VCCIO` |
| `Label.VCCSA` | REG_SZ | `VCCSA` |
| `Label.VCCST` | REG_SZ | `VCC Sustain` |
| `Value.DGPU1` | REG_SZ | `32` |
| `Value.FCHA1` | REG_SZ | `1650` |
| `Value.FCHA2` | REG_SZ | `867` |
| `Value.FCPUOPT` | REG_SZ | `933` |
| `Value.FGPU1` | REG_SZ | `894` |
| `Value.PCPUIAC` | REG_SZ | `6,04` |
| `Value.PCPUPKG` | REG_SZ | `17,24` |
| `Value.PCPUUNC` | REG_SZ | `10,11` |

> ⚠️ **Decimal separator is locale-dependent.** That capture shows `6,04` / `17,24` (comma), while the
> shared-memory capture in §2.3 shows `108.56` / `1.368` (period). **Never** parse with
> `double.Parse(s)` under the ambient culture — normalise, or parse with `InvariantCulture` after
> detecting the separator. This is a real parser-breaking trap.

**Older official screenshot** (HelpMax, ~v4 era) — <http://d2nwkt1g6n1fev.cloudfront.net/helpmax/wp-content/uploads/sub/aida64/en/source/extapp_registry.png>

```
Label.FCPU   = CPU              Value.FCPU   = 2712   <- note: label/value pairing by ID
Label.SCPUCLK= CPU Clock        Value.SCPUCLK= 2712
Label.SCPUFSB= CPU FSB          Value.SCPUFSB= 201
Label.SCPUMUL= CPU Multiplier   Value.SCPUMUL= 13.5
Label.TCPU   = CPU              Value.TCPU   = 30
Label.TCPUDIO= CPU Diode        Value.TCPUDIO= 26
Label.THDD1  = ST31000528AS     Value.THDD1  = 27     <- HDD label = model name
Label.TMOBO  = Motherboard      Value.TMOBO  = 35
Label.V33V   = +3 V             Value.V33V   = 3.360
Label.VBAT   = VBAT Battery     Value.VBAT   = 3.088
Label.VCPU   = CPU Core         Value.VCPU   = 1.344
Label.VDIMM  = DIMM             Value.VDIMM  = 1.488
Label.VP12V  = +12 V            Value.VP12V  = 12.175
```

Same two prefixes across a ~decade of versions → the scheme is stable. But **labels drift**: `V33V`
was `+3 V` then, `+3.3 V` now. Never key logic off a label; key it off the ID.

**Typical IDs you asked about:**

| What | ID | Registry names |
|---|---|---|
| Total CPU usage | `SCPUUTI` | `Label.SCPUUTI` / `Value.SCPUUTI` |
| Per-core CPU usage | `SCPU1UTI` … `SCPU256UTI` | `Value.SCPU1UTI` |
| CPU package temp | `TCPUPKG` (also `TCPU`, `TCPUDIO`, `TCPUSOCK`) | `Value.TCPUPKG` |
| Per-core temp | `TCC-1-1` … `TCC-2-128` | `Value.TCC-1-1` |
| AMD CCD temp | `TCCD1` … `TCCD12` | `Value.TCCD1` |
| GPU temp | `TGPU1`, `TGPU1HOT`, `TGPU1MEM`, `TGPU1VRM` | `Value.TGPU1` |
| Fan RPM | `FCPU`, `FSYS`, `FCHA1`, `FFAN1`…`FFAN40`, `FGPU1` | `Value.FCPU` |
| Voltages | `VCPU`, `V33V`, `VP5V`, `VP12V`, `VBAT`, `VDIMM`, `VSOC` | `Value.V33V` |
| Memory used | `SUSEDMEM` (MB), `SMEMUTI` (%) | `Value.SUSEDMEM` |
| HDD temp | `THDD1`…`THDD50` (+ `THDD1TS2` for a 2nd sensor) | `Value.THDD1` |

### 1.5 Character encoding

- The registry **stores** strings as UTF-16 (`REG_SZ` is "either Unicode or ANSI depending on whether
  you use the Unicode or ANSI functions" — [MS Learn](https://learn.microsoft.com/en-us/windows/win32/sysinfo/registry-value-types)).
- **Use the W (wide) APIs** — `RegOpenKeyExW` / `RegQueryValueExW`, or .NET `RegistryKey`, or Python
  `winreg` — and you get correct UTF-16 transparently. Do **not** use the `A` variants; you'd get an
  ANSI-codepage lossy conversion for free.
- In practice labels are ASCII/English (FinalWire forces non-localized labels), so this rarely bites —
  but drive model names in `THDD*` labels can contain arbitrary bytes, so use wide APIs anyway.
- If you shell out to `reg.exe query`, output is in the console codepage — set `chcp 65001` or read the
  key properly instead. A `.reg` export from regedit is UTF-16LE with BOM.

### 1.6 Index / count value, and stale-entry cleanup

- **There is no index, count, or "number of sensors" value.** Not in either official screenshot, and no
  parser reads one. You must enumerate value names yourself (`RegEnumValue` / `GetValueNames()`).
- **Stale entries are fully cleaned up**: *"When AIDA64 is closed, it deletes both the registry path and
  the values it contains from the Registry."* (official). So the whole `SensorValues` key disappears on
  exit — including when hardware changes, because that requires a restart/re-scan, and on shutdown the
  key is deleted wholesale. You never need to garbage-collect IDs yourself.
- The set of IDs is **rebuilt each run** from detected hardware, so it varies between machines —
  a parser must be driven by what it finds, never by a hardcoded list.

### 1.7 Enabling it, and liveness

- **UI path:** `File → Preferences → Hardware Monitoring → External Applications →`
  ☑ **"Enable writing sensor values to Registry"**.
  Screenshot: <https://www.aida64.com/sites/default/files/inline-images/preferences-hwm-externalapps_light.png>
- **INI switch** (verified in a live `aida64.ini`, `[Generic]` section):
  ```
  HWMonEnableRegistry=0        ; 1 = enabled
  HWMonEnableSharedMem=1       ; shared memory
  HWMonEnableWMI=0             ; WMI
  HWMonEnableRTSS=0            ; Rivatuner OSD server
  HWMonSharedMemName=AIDA64_SensorValues
  HWMonWMIProvName=AIDA64_SensorValues
  HWMonExtAppItems=TDIMMTS2 TDIMMTS4 VCPU    ; per-sensor selection
  ```
  Plus the sensor checkboxes in that lower list — a sensor must be **both** globally enabled and
  individually ticked. `HWMonExtAppItems` holds the ticked IDs.
- **AIDA64 must be running.** The key is created at startup and deleted at exit; it is live only while
  the process runs. There is no post-exit residue to read.

---

## 2. Shared-memory interface

### 2.1 Name

```
AIDA64_SensorValues
```

- Plain **named file mapping** in the **global** namespace as seen by the creating session. Official
  Delphi sample calls `OpenFileMapping(FILE_MAP_READ, False, 'AIDA64_SensorValues')` — i.e. the bare
  name, **no `Global\` prefix**. AIDA64 runs as a normal desktop (non-service) app in the interactive
  session, so `OpenFileMapping` with the bare name from another interactive-session process works.
  (Verified in three independent readers: Delphi sample, [`SharedMemoryReader.cs`](https://github.com/Seraksab/AIDA64.SensorValues.Net/blob/main/AIDA64.SensorValues/Readers/SharedMemoryReader.cs)
  `MemoryMappedFile.OpenExisting("AIDA64_SensorValues")`, and the Rust gist.)
  If you need cross-session access you'd have to try `Global\AIDA64_SensorValues`, but that is **not
  documented** and is not what any observed reader uses.
- Name is user-configurable via `HWMonSharedMemName`.
- Requires `FILE_MAP_READ`. **Gotcha:** if AIDA64 runs elevated and your reader doesn't, you get
  `UnauthorizedAccessException` / `ERROR_ACCESS_DENIED`, not "not available" — the C# reader
  deliberately distinguishes these two cases.

### 2.2 Layout — XML fragment, not records

The buffer is **one long string, NUL-terminated** (`char*`/`PChar`), made of **concatenated XML
elements with no single root**. Official:

> *"The shared memory content is a long string value ending in a 0x00 char, making it a classic PChar or
> char\*. The string is made of XML tags, but it is not a complete XML document."*

Per record, **fixed field order**:

```xml
<temp><id>TCC-1-1</id><label>CPU #1 / Core #1</label><value>58</value></temp>
```

- Element name = **sensor type**: `sys`, `temp`, `fan`, `duty`, `volt`, `curr`, `pwr`, `flow`
- Child order is always `id`, `label`, `value`. **No unit element.**
- Records are separated by nothing — pure concatenation.
- Because there's no root element, you must parse as an **XML fragment**, or wrap it: the Rust gist does
  `format!("<root>{}</root>", xml)`. .NET uses `XmlReader` with `ConformanceLevel.Fragment`.
- **No record count, no size header.** You know the end at the NUL terminator; count = number of
  top-level elements you parsed.

### 2.3 Real captured dump

From [`Tests/TestData/Aida64Data.xml`](https://github.com/Seraksab/AIDA64.SensorValues.Net/blob/main/Tests/TestData/Aida64Data.xml)
(Ryzen 9 7900X / X670E / RTX GPU, AIDA64 ~2026). Note the file is stored pretty-printed; **on the wire
there are no newlines** — it's one continuous string:

```xml
<sys><id>SDATE</id><label>Date</label><value>09.07.2026</value></sys>
<sys><id>SCPUCLK</id><label>CPU Clock</label><value>5425</value></sys>
<sys><id>SCC-1-3</id><label>CPU Core #3 Clock</label><value>5275</value></sys>
<sys><id>SCPUMUL</id><label>CPU Multiplier</label><value>54.25</value></sys>
<sys><id>SMEMSPEED</id><label>Memory Speed</label><value>DDR5-6200</value></sys>
<sys><id>SDRAMFSB</id><label>DRAM:FSB Ratio</label><value>31:1</value></sys>
<sys><id>SMEMTIM</id><label>Memory Timings</label><value>30-38-38-36 CR1</value></sys>
<sys><id>SMOBONAME</id><label>Motherboard Name</label><value>Asus TUF Gaming X670E-Plus WiFi</value></sys>
<sys><id>SCPUUTI</id><label>CPU Utilization</label><value>21</value></sys>
<sys><id>SUSEDMEM</id><label>Used Memory</label><value>28302</value></sys>
<sys><id>SSMASTA</id><label>SMART Status</label><value>OK</value></sys>
<sys><id>SGPU1BUSTYP</id><label>GPU1 Bus Type</label><value>PCI-E 4.0 x16 @ 4.0 x16</value></sys>
<sys><id>SPRIIPADDR</id><label>Primary IP Address</label><value>192.168.1.20</value></sys>
<sys><id>SDESKRES</id><label>Desktop Resolution</label><value>5120 x 1440</value></sys>
<sys><id>SBATT</id><label>Battery</label><value>No Battery</value></sys>
<temp><id>TCPUPKG</id><label>CPU Package</label><value>71</value></temp>
<temp><id>THDD3</id><label>WD_BLACK SN850X 1000GB (S/N redacted)</label><value>58</value></temp>
<fan><id>FCPU</id><label>CPU</label><value>1170</value></fan>
<fan><id>FGPU1</id><label>GPU1</label><value>0</value></fan>
<duty><id>DGPU1</id><label>GPU1</label><value>30</value></duty>
<volt><id>VCPU</id><label>CPU Core</label><value>1.368</value></volt>
<volt><id>VP12V</id><label>+12 V</label><value>11.980</value></volt>
<pwr><id>PCPUPKG</id><label>CPU Package</label><value>108.56</value></pwr>
```

Official example output — <https://www.aida64.com/sites/default/files/inline-images/03_settings_44_e8ywrq08jml.png>

```
<temp><id>TMOBO</id><label>Motherboard</label><value>45</value></temp>
<temp><id>TCPU</id><label>CPU</label><value>35</value></temp>
<temp><id>TCC-1-1</id><label>CPU #1 / Core #1</label><value>58</value></temp>
<fan><id>FCPU</id><label>CPU</label><value>1430</value></fan>
<volt><id>VCPU</id><label>CPU Core</label><value>1.22</value></volt>
```

**Note the label differs between transports for the same ID**: registry-era `TCC-1-1` label is
`CC-1-1 (CPU #1 / Core #1)` in the ID-list doc, `CPU #1 / Core #1` in the shared-memory capture, and
`CPU Core #1 Clock` for the `SCC-1-*` variant. Labels are cosmetic; **match on `id`**.

### 2.4 Size limits

Official: *"The buffer size (the size of the shared memory block) has to be at least 10 KB. A typical
buffer size is around 1 to 3 KB, but for Abit MicroGuru 2005 based boards, for example, it can be a lot
more."*

→ **Allocate/read ≥10 KB.** Don't hardcode a small buffer — some old forum code uses `BUFFER_SIZE = 3000`
and will truncate on a modern many-sensor system. The C# reader instead reads the mapping's actual
`Capacity` and scans for the NUL.

### 2.5 Encoding — **version-dependent, this is the #1 parser-breaking issue**

- **Through v7.65.x (and earlier): ANSI** — the system codepage, per the original Delphi sample and the
  C# reader's comment *"AIDA64 writes the XML fragment using the systems ANSI code page"*.
- **From v7.99 beta (June 2025): Unicode (UTF-16LE).** FinalWire's Fiery, in
  [forums.aida64.com/topic/18385](https://forums.aida64.com/topic/18385-fixed-aida64-v799-beta-aida64_sensorvalues-bug/):
  > *"Please note that AIDA64 Shared Memory has switched from ANSI to Unicode encoding, so you will need
  > to adjust your shared memory buffer reading code accordingly. You can detect if the shared memory
  > buffer is Unicode encoded by checking the 2nd byte of the buffer: if it's a zero byte (0x00), it
  > means you're dealing with a Unicode shared memory buffer."*

**Recommended detection order** (the 2nd-byte trick alone is fragile if a BOM is ever added):

```
1. bytes[0..1] == FF FE  -> UTF-16LE with BOM   (strip BOM)
2. bytes[0..1] == FE FF  -> UTF-16BE with BOM   (strip BOM)
3. bytes[1] == 0x00      -> UTF-16LE no BOM      (FinalWire's documented test; payload starts '<'=0x3C)
4. otherwise             -> ANSI: try UTF-8 strict, fall back to Encoding.GetEncoding(GetACP())
```

Step 4 is exactly what `SharedMemoryReader.Decode()` does, and the UTF-8-first-then-ANSI order is
deliberate: ASCII payloads are valid in both, so it's a no-op for the common case and only matters for
non-ASCII drive names. Also **strip a leading U+FEFF** before handing text to your XML parser — it
rejects it.

**Registry strings are unaffected** by this change (always UTF-16 via the Win32 W APIs).

---

## 3. Practical notes for the reader

### 3.1 Refresh interval

- Governed by `Preferences → Hardware Monitoring → Update Frequency → "External applications"`.
  INI key: **`HWMonUpdateFreqExtApp`**, default **`1000`** (milliseconds) — verified in a live `aida64.ini`.
- So: **~1 s latency, worst case ~2 s** (poll + write). Do not poll faster than ~250–500 ms; you gain
  nothing and only add torn-read risk.
- Related knobs that change the *format* of the numbers, also from the live INI:
  `HWMonTempDecDigits=0`, `HWMonVoltDecDigits=3`, `HWMonCurrDecDigits=2`, `HWMonPwrDecDigits=2`,
  `HWMonClockDecDigits=0`, `HWMonTempF=0`.
  → **Decimal precision is user-configurable.** Never assume fixed precision; parse as float from text.
- **Temperatures are always Celsius** in both exports, *"even if Fahrenheit is selected in the
  Preferences menu"* (official). Same for labels: always English.

### 3.2 Torn reads

AIDA64 writes with **no synchronization** and no sequence counter. A reader can catch a half-updated
buffer and get spliced XML. From `SharedMemoryReader.cs`:

> *"Callers that poll should therefore expect an occasional `SensorValueParsingException` and simply read
> again rather than treat it as fatal."*

→ **Copy the buffer to a local snapshot first, parse the copy, and retry on parse failure.** Do not
parse in place. Same applies to the registry: enumerate names, then read values, accepting that a
label/value pair may momentarily disagree.

### 3.3 What counts as "export not available"

| Signal | Meaning | Action |
|---|---|---|
| `HKCU\Software\FinalWire` missing | AIDA64 never installed/run for this user | Not available |
| `...\FinalWire\AIDA64` exists but `SensorValues` **missing** | **Either** AIDA64 not running **or** `HWMonEnableRegistry=0` | Not available — ambiguous, see below |
| `SensorValues` exists, **zero** `Value.*` names | Enabled but no sensors ticked (`HWMonExtAppItems` empty) | Config problem — tell the user to tick sensors |
| `SensorValues` exists with `Value.*` | **AIDA64 is running and fresh** | Good |
| `OpenFileMapping` → `ERROR_FILE_NOT_FOUND` | AIDA64 not running **or** shared memory disabled | Not available |
| `OpenFileMapping` → `ERROR_ACCESS_DENIED` | AIDA64 elevated, reader isn't | **Distinct error** — prompt for elevation, don't report "not installed" |

**Key insight: "present but stale" is essentially not a failure mode.** Because AIDA64 deletes the whole
`SensorValues` key on exit and the mapping is destroyed with the session, a key/mapping that exists
implies a live exporter. You do **not** need a staleness heuristic.

The genuinely ambiguous case is *missing*: it conflates "AIDA64 isn't running" with "the export option is
off". To disambiguate, check (in order):
1. `Get-Process aida64` / `CreateToolhelp32Snapshot` — is the process alive?
2. If alive but key missing → the option is off. **This is a distinct, actionable error**: *"AIDA64 is
   running but Registry export is disabled — enable it in Preferences → Hardware Monitoring → External
   Applications."*
3. If not alive → AIDA64 isn't running.

Do **not** read `aida64.ini` to determine state: AIDA64 keeps settings in memory and rewrites the INI on
exit, so a running instance's INI is stale. (Empirical: the local `aida64.ini` still had
`HWMonEnableSharedMem=1` from a 2025-06 run while `LastUsedBuild=7.65.7400` and no live key existed.)

### 3.4 Preference ordering

Shared memory is faster and gives you type + label + value in one read
([benchmark](https://github.com/Seraksab/AIDA64.SensorValues.Net): ~256 µs vs ~844 µs per full sweep).
Registry is easier to poke at (`regedit`, Rainmeter's native `Measure=Registry`) and survives no extra
buffer/encoding handling. **Implement shared memory as primary, registry as fallback** — and note the
registry path sidesteps the §2.5 ANSI/UTF-16 mess entirely, which makes it the more robust choice if you
must support a wide range of AIDA64 versions.

### 3.5 Other transports (same IDs, same labels)

- **WMI:** `Root\WMI\AIDA64_SensorValues` (`HWMonEnableWMI`, `HWMonWMIProvName`). Also deleted when
  AIDA64 exits. [Docs](http://aida64.helpmax.net/en/external-applications/wmi/)
- **Rivatuner OSD:** shared memory named **`RTSSSharedMemoryV2`** (`HWMonEnableRTSS`). Only
  temps/voltages/fans; `HWMonRTSSLabels` toggles labels.
- **Vista Sidebar had a `HWMonUseHKLM` switch** (`HKLM\SOFTWARE\FinalWire\AIDA64\SensorValues`) — but
  that is the *sidebar gadget*, not the External-Applications export. **The sensor export is HKCU-only.**

---

## 4. Minimal correct parser (pseudocode)

```
# --- Registry path (recommended: no encoding ambiguity) ---
key = RegOpenKeyExW(HKEY_CURRENT_USER, "Software\\FinalWire\\AIDA64\\SensorValues",
                    0, KEY_READ | KEY_WOW64_64KEY)
if key == ERROR_FILE_NOT_FOUND:
    raise NotAvailable(running = ProcessExists("aida64"))   # -> "disabled" vs "not running"

labels, values = {}, {}
for (name, type, data) in RegEnumValueW(key):
    if type != REG_SZ: continue                  # tolerate/ignore anything unexpected
    if name.startswith("Label."): labels[name[6:]] = data
    elif name.startswith("Value."): values[name[6:]] = data

for id in values:
    yield Sensor(id, labels.get(id, ""), values[id], type_from_first_char(id[0]))

# --- Shared-memory path ---
h = OpenFileMappingW(FILE_MAP_READ, FALSE, "AIDA64_SensorValues")
if h == NULL:
    if GetLastError() == ERROR_ACCESS_DENIED: raise NeedsElevation
    raise NotAvailable
p = MapViewOfFile(h, FILE_MAP_READ, 0, 0, 0)
raw = read_until_NUL(p, min_bytes=10240)         # >=10 KB per spec; scan for terminator
text = decode_detect(raw)                        # BOM -> [1]==0 UTF-16LE -> UTF-8/ANSI
text = strip_BOM(text)
for elem in parse_xml_fragment("<root>"+text+"</root>"):     # no single root on the wire
    yield Sensor(elem/id, elem/label, elem/value, type=elem.tag)
# on XML parse error: discard snapshot, retry next tick (torn read), don't fail hard
```

---

## 5. Confidence

| Claim | Confidence | Basis |
|---|---|---|
| Key path, HKCU, no subkeys, REG_SZ, `Label.`/`Value.` prefixes | **High** | Two official screenshots + 3 independent parsers + Rainmeter skin configs |
| No unit value; labels never localized; temps always °C | **High** | Explicit official statements |
| No count/index value; key deleted on exit | **High** | Official statement + absence in all captures |
| ID namespace & type-first-letter mapping | **High** | Official complete ID list + live `aida64.ini` internal list agree |
| Shared memory = NUL-terminated XML fragment, `id`/`label`/`value`, ≥10 KB | **High** | Official text + official screenshot + real capture |
| ANSI ≤7.65 → UTF-16 from 7.99, 2nd-byte detection | **High** | FinalWire admin, marked **[SOLVED]** |
| Locale-dependent decimal separator | **Medium-high** | Direct observation in two captures; not documented |
| Decimal precision configurable per category | **Medium-high** | INI keys; not documented for exports |
| `KEY_WOW64_64KEY` / non-redirected HKCU path | **Medium-high** | Verified locally (32-bit exe, key at plain path); **not** officially documented |
| No third value-name prefix exists | **Medium** | Absence of evidence across all sources; parse tolerantly anyway |
| `LLIQ*` XML element name | **Low** | In the ID list, but never seen in a capture; C# reader doesn't map `L` |

**Not confirmed anywhere, and I did not invent it:** an official statement that the registry export's
value-name scheme is frozen; the exact XML element name for liquid-level sensors; whether `Global\`
prefixed mapping names are ever needed.

---

## Sources

Official FinalWire:
- [External Applications (user manual)](https://www.aida64.com/user-manual/hardware-monitoring/external-applications?language_content_entity=en) — registry path, shared-memory format, 10 KB, cleanup, English/Celsius
- [Complete Sensor value list](https://www.aida64.com/user-manual/hardware-monitoring/external-applications/complete-sensor-value-list?language_content_entity=en) — authoritative ID list
- [Update frequency](https://www.aida64.com/user-manual/hardware-monitoring/update-frequency?language_content_entity=en)
- [Registry (HelpMax mirror)](http://aida64.helpmax.net/en/external-applications/registry/) · [Shared Memory](http://aida64.helpmax.net/en/external-applications/shared-memory/) · [WMI](http://aida64.helpmax.net/en/external-applications/wmi/)
- [Registry example screenshot (current)](https://www.aida64.com/sites/default/files/inline-images/registry-sensorvalues_light.png) · [XML example (current)](https://www.aida64.com/sites/default/files/inline-images/03_settings_44_e8ywrq08jml.png) · [Preferences](https://www.aida64.com/sites/default/files/inline-images/preferences-hwm-externalapps_light.png) · [Registry example (older)](http://d2nwkt1g6n1fev.cloudfront.net/helpmax/wp-content/uploads/sub/aida64/en/source/extapp_registry.png)
- [Forum: v7.99 ANSI→Unicode switch](https://forums.aida64.com/topic/18385-fixed-aida64-v799-beta-aida64_sensorvalues-bug/)

Third-party code:
- [Seraksab/AIDA64.SensorValues.Net](https://github.com/Seraksab/AIDA64.SensorValues.Net) —
  [`RegistryReader.cs`](https://github.com/Seraksab/AIDA64.SensorValues.Net/blob/main/AIDA64.SensorValues/Readers/RegistryReader.cs),
  [`SharedMemoryReader.cs`](https://github.com/Seraksab/AIDA64.SensorValues.Net/blob/main/AIDA64.SensorValues/Readers/SharedMemoryReader.cs),
  [`Tests/TestData/Aida64Data.xml`](https://github.com/Seraksab/AIDA64.SensorValues.Net/blob/main/Tests/TestData/Aida64Data.xml)
- [RouHim gist — Rust shared-memory reader](https://gist.github.com/RouHim/91919e4a1efa3d0f920da052f47ad71c)
- [Rainmeter forum — native `Measure=Registry` with `RegValue=Value.SCPUCLK`](https://forum.rainmeter.net/viewtopic.php?t=16206) · [Rainformer AIDA64 Edition](https://forum.rainmeter.net/viewtopic.php?p=200867)
- [ComputerBild — REG_SZ confirmation](https://www.computerbild.de/artikel/cb-Tipps-Windows-Windows-CPU-Temperatur-in-wenigen-Schritten-anzeigen-31574363.html)
- [MS Learn — registry value types](https://learn.microsoft.com/en-us/windows/win32/sysinfo/registry-value-types)

Local verification (this machine):
- `HKCU\Software\FinalWire\AIDA64` present, `LastUsedBuild=7.65.7400`, `SensorValues` absent
- `C:\系统调整工具\图吧工具箱202507\tools\综合检测\AIDA64\aida64.ini` → all `HWMon*` keys quoted above
- `aida64.exe` PE header → 32-bit (`0x014c` / PE32) on 64-bit Windows; config written to non-redirected HKCU path
