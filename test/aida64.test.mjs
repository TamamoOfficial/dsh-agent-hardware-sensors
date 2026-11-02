import { parseAidaNumber, parseAidaXmlFragment, decodeAidaSharedMemory, categoryOfId } from '../lib/aida64.js'
let fail = 0
const eq = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) } else console.log(`ok   ${label}`) }

// --- 数字解析：规范里出现过的全部真实形态 ---
eq('comma decimal (registry, de-DE)', parseAidaNumber('17,24').num, 17.24)
eq('comma decimal 2', parseAidaNumber('6,04').num, 6.04)
eq('dot decimal (shm)', parseAidaNumber('108.56').num, 108.56)
eq('voltage 3dp', parseAidaNumber('1.368').num, 1.368)
eq('integer', parseAidaNumber('28302').num, 28302)
eq('multiplier', parseAidaNumber('54.25').num, 54.25)
eq('non-numeric keeps text', parseAidaNumber('DDR5-6200'), { num: null, text: 'DDR5-6200' })
eq('ratio text', parseAidaNumber('31:1').num, null)
eq('thousands dot grouping', parseAidaNumber('1.234.567').num, 1234567)
eq('OK string', parseAidaNumber('OK').num, null)
eq('empty', parseAidaNumber('').num, null)

// --- 类别推断（ID 首字母）---
eq('TCPU temp', categoryOfId('TCPUPKG'), 'temperature')
eq('FCPU fan', categoryOfId('FCPU'), 'fan')
eq('TCC-1-1 temp', categoryOfId('TCC-1-1'), 'temperature')
eq('LLIQ1 liquid', categoryOfId('LLIQ1'), 'liquid')
eq('SCPUUTI system', categoryOfId('SCPUUTI'), 'system')

// --- XML 片段：官方文档样例（注意：线路上无换行，这里刻意拼成一行）---
const shmXml = [
  '<temp><id>TMOBO</id><label>Motherboard</label><value>45</value></temp>',
  '<temp><id>TCPU</id><label>CPU</label><value>35</value></temp>',
  '<temp><id>TCC-1-1</id><label>CPU #1 / Core #1</label><value>58</value></temp>',
  '<fan><id>FCPU</id><label>CPU</label><value>1430</value></fan>',
  '<volt><id>VCPU</id><label>CPU Core</label><value>1.22</value></volt>',
].join('')
const s1 = parseAidaXmlFragment(shmXml)
eq('official sample count', s1.length, 5)
eq('first is TMOBO 45C', [s1[0].id, s1[0].num, s1[0].unit], ['TMOBO', 45, '°C'])
eq('label with slash kept', s1[2].label, 'CPU #1 / Core #1')
eq('fan unit', [s1[3].id, s1[3].num, s1[3].unit], ['FCPU', 1430, 'RPM'])
eq('volt unit', [s1[4].unit, s1[4].num], ['V', 1.22])

// --- 真实捕获 dump（Ryzen 9 7900X 那份）里的非数字值与特殊标签 ---
const big = [
  '<sys><id>SDATE</id><label>Date</label><value>09.07.2026</value></sys>',
  '<sys><id>SMEMSPEED</id><label>Memory Speed</label><value>DDR5-6200</value></sys>',
  '<sys><id>SMEMTIM</id><label>Memory Timings</label><value>30-38-38-36 CR1</value></sys>',
  '<sys><id>SMOBONAME</id><label>Motherboard Name</label><value>Asus TUF Gaming X670E-Plus WiFi</value></sys>',
  '<sys><id>SCPUUTI</id><label>CPU Utilization</label><value>21</value></sys>',
  '<temp><id>THDD3</id><label>WD_BLACK SN850X 1000GB (SN-REDACTED)</label><value>58</value></temp>',
  '<pwr><id>PCPUPKG</id><label>CPU Package</label><value>108.56</value></pwr>',
  '<duty><id>DGPU1</id><label>GPU1</label><value>30</value></duty>',
  '<fan><id>FGPU1</id><label>GPU1</label><value>0</value></fan>',
].join('')
const s2 = parseAidaXmlFragment(big)
eq('dump count', s2.length, 9)
eq('date non-numeric', s2[0].num, null)
eq('mem speed text', s2[1].value, 'DDR5-6200')
eq('mobo label is field name', s2[3].label, 'Motherboard Name')
eq('mobo value is the model', s2[3].value, 'Asus TUF Gaming X670E-Plus WiFi')
eq('hdd label w/ parens', s2[5].label, 'WD_BLACK SN850X 1000GB (SN-REDACTED)')
eq('pwr unit W', [s2[6].unit, s2[6].num], ['W', 108.56])
eq('duty unit %', s2[7].unit, '%')
eq('zero rpm kept', s2[8].num, 0)

// --- 撕裂读：半截 XML 必须不崩，且能拿到已完整的记录 ---
const torn = '<temp><id>TCPU</id><label>CPU</label><value>35</value></temp><fan><id>FCPU</id><label>C'
const s3 = parseAidaXmlFragment(torn)
eq('torn: keeps complete record', s3.length, 1)

// --- 编码阶梯 ---
const ascii = '<temp><id>TCPU</id><label>CPU</label><value>35</value></temp>'
eq('ANSI bytes', decodeAidaSharedMemory(Buffer.from(ascii + '\0', 'latin1')).startsWith('<temp>'), true)
const u16 = Buffer.concat([Buffer.from([0xff,0xfe]), Buffer.from(ascii,'utf16le')])
eq('UTF-16LE + BOM', decodeAidaSharedMemory(u16), ascii)
const u16noBom = Buffer.from(ascii + '\0', 'utf16le')
eq('UTF-16LE no BOM (byte1==0)', decodeAidaSharedMemory(u16noBom), ascii)
// 非 ASCII：GBK 编码的中文标签，UTF-8 严格解码应失败并退回 GBK
const gbkBytes = Buffer.from([0x3c,0x74,0x65,0x6d,0x70,0x3e,0x3c,0x6c,0x61,0x62,0x65,0x6c,0x3e,0xce,0xc2,0xb6,0xc8,0x3c,0x2f,0x6c,0x61,0x62,0x65,0x6c,0x3e,0x3c,0x2f,0x74,0x65,0x6d,0x70,0x3e,0x00])
const gbkDecoded = decodeAidaSharedMemory(gbkBytes)
eq('GBK fallback decodes 温度', gbkDecoded.includes('温度'), true)
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`)
process.exit(fail ? 1 : 0)
