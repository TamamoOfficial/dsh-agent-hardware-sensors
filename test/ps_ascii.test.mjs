import { SHM_PS, powershellCandidates } from '../lib/aida64.js'
let fail = 0
const bad = [...SHM_PS].filter(c => c.charCodeAt(0) > 127)
if (bad.length) { fail++; console.log('FAIL SHM_PS has non-ASCII:', JSON.stringify(bad.slice(0,10))) }
else console.log('ok SHM_PS is pure ASCII')
if (/\/\/|\/\*/.test(SHM_PS)) { fail++; console.log('FAIL SHM_PS contains JS-style comment') }
else console.log('ok SHM_PS has no JS-style comments')
if (!SHM_PS.includes("'DSHHW:NONE'") || !SHM_PS.includes("'DSHHW:DENIED'")) { fail++; console.log('FAIL missing sentinel outputs') }
else console.log('ok sentinels present')
const cands = powershellCandidates({ SystemRoot: 'C:\Windows', SystemDrive: 'C:' })
console.log('ps candidates:', JSON.stringify(cands))
console.log(fail === 0 ? 'ALL PASS' : fail + ' FAILURES')
process.exit(fail ? 1 : 0)
