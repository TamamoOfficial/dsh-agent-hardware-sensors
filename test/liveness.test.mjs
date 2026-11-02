import { processesAlive, AIDA64_IMAGES, HWINFO_IMAGES } from '../lib/liveness.js'
const r = await processesAlive([...AIDA64_IMAGES, ...HWINFO_IMAGES])
console.log('probe result:', JSON.stringify(r))
console.log('probe_failed:', !!r.__probe_failed)
// 本机两个软件都没在运行 ⇒ 应全 false 且探针本身成功
const allImages = [...AIDA64_IMAGES, ...HWINFO_IMAGES].map(s=>s.toLowerCase())
const ok = !r.__probe_failed && allImages.every(k => r[k] === false)
console.log(ok ? 'PASS (both absent, probe worked)' : 'NOTE: software is running or probe failed')
// 反向验证探针有效性：一个必定存在的进程必须被识别
const self = await processesAlive(['TaskDataHost.exe','svchost.exe','RuntimeBroker.exe'])
console.log('sanity (svchost should be true):', JSON.stringify(self))
if (self['svchost.exe'] !== true) { console.log('FAIL: probe cannot see running processes'); process.exit(1) }
console.log('ALL PASS')
