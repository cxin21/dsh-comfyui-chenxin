import { readFileSync, writeFileSync } from 'node:fs';
import { compileAnima, auditAnima } from './dist/src/pe-framework/dialect/anima.js';

// 本轮（19:43 build2 宿主）真实 intent 产出——从 envelope segments 的 slot 归属精确重建
const slots = {
  count_gender: ['1girl'],
  appearance: ['black hair', 'long hair', 'hair updo', 'hair ornament', 'delicate'],
  clothing: ['hanfu', 'flowing', 'crimson sash', 'closed mouth'],
  pose_action: ['dancing', 'holding sword', 'standing'],
  expression: ['serious'],
  camera: ['three-quarter', 'dynamic angle', 'full body'],
  scene: ['courtyard', 'pavement', 'full moon'],
  detail_mood: ['night', 'fog', 'lotus', 'plum tree', 'reflection'],
  narrative:
    'She occupies the left-of-center third of the frame, full body visible, sleeves and sword arc drawing the eye diagonally across the ancient courtyard. A full moon overhead and drifting mist keep her face and figure clearly exposed without silhouette effects. Cool blue-green night tones dominate the palette with a small warm amber accent along the blade and the crimson sash as a single secondary color note.',
};

const c = compileAnima(slots, { variant: 'base', dropUnresolvedMiss: true });
const gates = auditAnima(c.positive, c.negative, { variant: 'base', slots: c.effectiveSlots ?? slots });
console.log('=== BUILD3 compile of THIS run intent slots ===');
console.log('POSITIVE:\n' + c.positive);
console.log('\nnegative:\n' + c.negative);
console.log('\nsubstitutions:', JSON.stringify(c.substitutions));
console.log('dropped:', JSON.stringify(c.dropped));
const crit = gates.filter((g) => g.severity === 'critical');
const imp = gates.filter((g) => g.severity === 'important');
console.log('gates: critical=' + crit.length + ' important=' + imp.length);
for (const g of [...crit, ...imp]) console.log('  [' + g.severity + '][' + g.rule + '] ' + g.detail.slice(0, 120));
const minors = gates.filter((g) => g.severity === 'minor').length;
console.log('minor gates:', minors);
console.log('phase_status:', JSON.stringify(c.phase_status));
