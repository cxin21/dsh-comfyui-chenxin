import { readFileSync } from 'node:fs';
import { compileAnima, auditAnima } from './dist/src/pe-framework/dialect/anima.js';

const base = 'C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin/temp/research/verify2';
const r1 = JSON.parse(readFileSync(base + '/bb394685/assistant.txt', 'utf8')).slots; // 真实 intent 首轮产出（上轮引发 blocker）
const r2 = JSON.parse(readFileSync(base + '/b5cc0d8d/assistant.txt', 'utf8')).slots; // 真实 intent 修复轮产出（上轮最终稿来源）

for (const [name, slots] of [
  ['intent-R1(原始)', r1],
  ['intent-R2(修复)', r2],
]) {
  console.log('\n================ ' + name + ' ================');
  const c = compileAnima(slots, { variant: 'base', dropUnresolvedMiss: true });
  const gates = auditAnima(c.positive, c.negative, { variant: 'base', slots: c.positive ? slots : slots });
  console.log('POSITIVE:\n' + c.positive);
  console.log('\nNEGATIVE:\n' + c.negative);
  console.log('\nsubstitutions:', JSON.stringify(c.substitutions));
  console.log('assumptions:', JSON.stringify(c.assumptions));
  const critical = gates.filter((g) => g.severity === 'critical');
  const important = gates.filter((g) => g.severity === 'important');
  console.log('gates: critical=' + critical.length + ' important=' + important.length);
  for (const g of [...critical, ...important])
    console.log('  [' + g.severity + '][' + g.rule + '] ' + g.detail.slice(0, 140));
  console.log('phase_status:', JSON.stringify(c.phase_status));
}
