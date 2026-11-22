/**
 * Host-faithful mount harness（2026-11-22，DSH 0.2.2-rc.5 服务形状）。
 *
 * ## 为什么需要它
 * host 0.2.2-rc.5 移除/改形了两个插件依赖的 seam：
 *   - settings：只保留 configure/describe/update/replace/mutate/write，**没有 register/get**
 *     （插件此前在 apply 期调 ctx.settings.register(ns, schema) → TypeError → fiber rejected
 *      → 整包 14 个工具在预设里静默失能）；
 *   - subagents：公开面只有 startActivation，**没有 start**（插件此前在 apply 期硬接线
 *     createSubagentIntentProvider(ctx)，其工厂级 guard 同样直接 throw）。
 *
 * 这个脚本按 host 的真实形状提供服务，再挂载 **dist**（不是 src），
 * 断言「14 个工具全部注册成功」——它是那场事故的回归闸门。
 *
 * 用法：npm run build && npm run verify:host-shape
 */
import { readdirSync } from 'node:fs';

const EXPECT = [
  'prompt_author', 'prompt_compile', 'prompt_audit', 'prompt_feedback',
  'prompt_expand', 'prompt_reverse', 'minimax_scenario', 'profile_list',
  'style_list', 'style_save', 'catalog_search', 'catalog_relations',
  'catalog_build', 'catalog_artist_add',
];

const { Context } = await import('@deepseek-ai/cordis');

// dsh-scope 不是本包的直接依赖（只作为 peer 装在 .pnpm 里）→ 按目录前缀定位，避免写死版本哈希。
const pnpmRoot = new URL('../node_modules/.pnpm/', import.meta.url);
const scopeDir = readdirSync(pnpmRoot).find((d) => d.startsWith('@deepseek-ai+dsh-scope@'));
if (!scopeDir) {
  console.error('SKIP: 未找到 @deepseek-ai/dsh-scope（pnpm store 里没有）');
  process.exit(0);
}
const scopeEntry = new URL(
  `../node_modules/.pnpm/${scopeDir}/node_modules/@deepseek-ai/dsh-scope/lib/index.js`,
  import.meta.url,
).href;
const { createScope } = await import(scopeEntry);

const registered = [];
const root = new Context();
root.plugin({
  name: 'host-shape-services',
  apply(ctx) {
    ctx.provide('tools', { register: (def) => { registered.push(def?.name); return () => {}; } });
    ctx.provide('llm', { stream: async function* () {} });
    // host 0.2.2-rc.5 的 settings 新表面：没有 register/get。
    ctx.provide('settings', {
      configure() {}, describe() { return {}; }, prepareDocument() {},
      async update() {}, async replace() {}, async mutate() {}, async write() {},
    });
    // host 有 subagents 服务，但没有 .start。
    ctx.provide('subagents', { resolveMaxDepth() {}, namesOf() { return []; } });
  },
});
await new Promise((r) => setTimeout(r, 500));

const scope = createScope(root, 'test-scope');
const pluginUrl = new URL('../dist/src/plugin/index.js', import.meta.url).href;
const pfMod = await import(pluginUrl);
let fiber;
try {
  fiber = scope.ctx.plugin(pfMod.default ?? pfMod, { temperature: 0.7 });
} catch (error) {
  console.log('mount rejected:', error?.message);
}
await new Promise((r) => setTimeout(r, 3000));
let state = 'n/a';
try {
  await fiber.await();
  state = 'ACTIVATED';
} catch (error) {
  state = 'REJECTED: ' + (error && error.message);
}
console.log('[promptForge] state=' + state);
console.log('registered count:', registered.length);
console.log('registered:', JSON.stringify(registered.slice().sort()));
const missing = EXPECT.filter((n) => !registered.includes(n));
console.log(missing.length ? 'MISSING: ' + JSON.stringify(missing) : 'ALL 14 PRESENT');
await scope.dispose();
process.exit(missing.length === 0 && state === 'ACTIVATED' ? 0 : 1);
