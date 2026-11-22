// storage-v2 — 两层 profile 存储的纯函数层 + 内置覆盖 namespace（spec §7.1）
// 内置层：只读 builtin profiles + settings 覆盖（enabled/sort）；自定义层：customProfiles（不变）。
// 纯模块：不落日志（工具层记 action 摘要）。

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings';
import { getPresetRoot } from '../resources/resolve.js';

export interface BuiltinOverride {
  enabled: boolean;
  sort?: number;
}
export interface OverridesSection {
  builtinOverrides: Record<string, BuiltinOverride>;
}

export interface OverridesApi {
  get(): Record<string, BuiltinOverride>;
  all(): Record<string, BuiltinOverride>;
  set(id: string, o: BuiltinOverride | null): Promise<void>;
}

/**
 * 文件回退存储（2026-11-22，DSH settings API 演进兼容）。
 *
 * DSH dsh-settings 0.2.2-rc.5 起，服务端 `register/get/update/replace` 的任意 namespace
 * API 被整体移除（SettingsForms 只剩 configure/describe/update-by-entry-id，settings 改为
 * 插件自带 Config 驱动）。本插件的三块 namespace 数据（customProfiles / overrides /
 * blueprints）在大 JSON blob 形态下不适合搬进 Config 表单字段，因此服务端 API 缺失时退化为
 * 进程内字典 + 预设根下 JSON 文件（data/runtime/prompt-forge/settings.json）的写穿存储：
 * get() 同步读内存（工具调用路径不允许异步），update/replace 改内存后异步落盘（tmp+rename
 * 原子替换；落盘失败仅记 stderr，内存仍为本进程权威——与 feedback.sqlite 的兜底纪律一致）。
 */
const FILE_STORE_RELPATH = join('data', 'runtime', 'prompt-forge', 'settings.json');
let fileStoreCache: Record<string, Record<string, unknown>> | undefined;

function loadFileStore(): Record<string, Record<string, unknown>> {
  if (fileStoreCache) return fileStoreCache;
  const empty: Record<string, Record<string, unknown>> = {};
  const root = getPresetRoot();
  if (!root) return empty;
  try {
    const raw = readFileSync(join(root, FILE_STORE_RELPATH), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    fileStoreCache =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, Record<string, unknown>>)
        : empty;
  } catch {
    fileStoreCache = empty; // 首次使用/损坏 → 空表起步（与 feedback 首用即建一致）
  }
  return fileStoreCache!;
}

function persistFileStore(): void {
  const root = getPresetRoot();
  const store = loadFileStore();
  if (!root) return; // 无根（裸插件调试）→ 仅内存
  const target = join(root, FILE_STORE_RELPATH);
  try {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    renameSync(tmp, target);
  } catch (error) {
    // 落盘失败不抛——内存权威，写失败下次进程内仍可读；stderr 留痕供诊断。
    process.stderr.write(`prompt-forge: settings file store persist failed: ${String(error)}\n`);
  }
}

function fileBackedScope<T>(ns: string): SettingsScope<T> {
  return {
    get: () => (loadFileStore()[ns] ?? {}) as T,
    // 本插件没有 watch 消费方（原复用路径同为 no-op）。
    watch: () => () => {},
    update: async (patch: object) => {
      const store = loadFileStore();
      const current = store[ns] ?? {};
      store[ns] = { ...current, ...patch };
      persistFileStore();
    },
    replace: async (section: object) => {
      const store = loadFileStore();
      store[ns] = { ...(section as Record<string, unknown>) };
      persistFileStore();
    },
  };
}

/**
 * register-or-reuse：settings namespace 在同一进程内只允许注册一次（重复 register 抛
 * "already registered"，整个 preset mount 失败）。本插件随 preset 挂载，同一进程里可能
 * 多次走到 apply（mount 失败重试、standing mount 按文件戳重建），而旧注册可能仍驻留，
 * 因此冲突时退化为 document 级 API（get/update/replace）复用既有注册，而不是让 mount 失败。
 *
 * 2026-11-22：DSH dsh-settings 0.2.2-rc.5 移除了服务端 register API（SettingsForms 无
 * register 字段，调用即 TypeError 且会击穿整个 apply → 14 工具全灭，见 KNOWN-ISSUES #30）。
 * 服务端缺 register 时退化到文件回退存储，绝不因 settings API 形态让 mount 失败。
 */
export function registerOrReuseNamespace<T>(
  ctx: Context,
  ns: ReturnType<typeof settingsNamespace>,
  schema: z<T>,
): SettingsScope<T> {
  if (typeof ctx.settings?.register !== 'function') {
    return fileBackedScope<T>(String(ns));
  }
  try {
    return ctx.settings.register(ns, schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('already registered')) throw error;
    return {
      get: () => ctx.settings.get(ns) as T,
      // 复用路径拿不到原注册的 watcher 集合；本插件没有 watch 消费方，no-op 即可。
      watch: () => () => {},
      update: (patch: object) => ctx.settings.update(ns, patch),
      replace: (section: object) => ctx.settings.replace(ns, section),
    };
  }
}

/**
 * 旧→新 namespace section 一次性惰性迁移（prompt-master → prompt-forge 改名，2026-11-22）。
 * 改 namespace key 是数据契约变更：老用户数据落在 prompt-master-* 旧 key 下。本函数在注册新
 * key 之后调用——仅当新 key 尚无数据、旧 key 有数据时把旧 section 搬过来（幂等：搬过一次后
 * 新 key 非空，后续调用短路；旧 key 数据只复制不删除，任何迁移失败都不丢数据）。迁移尽力而
 * 为：读取/写入失败静默跳过，绝不阻塞插件加载（与蓝图落库 fail-open 同一纪律）。
 */
export function migrateLegacySettingsSection(
  ctx: Context,
  currentNs: ReturnType<typeof settingsNamespace>,
  legacyNsName: string,
  sectionKey: string,
): void {
  const isEmptyTable = (v: unknown): v is undefined | Record<never, never> => {
    if (v == null) return true;
    if (typeof v !== 'object') return false;
    return Object.keys(v as object).length === 0;
  };
  try {
    if (typeof ctx.settings?.get !== 'function' || typeof ctx.settings?.update !== 'function') {
      // 服务端无 namespace API（0.2.2-rc.5+）→ 两代数据都在文件回退存储里，键名迁移同样适用。
      const store = loadFileStore();
      const current = store[String(currentNs)] as Record<string, unknown> | undefined;
      if (!isEmptyTable(current?.[sectionKey])) return;
      const legacy = store[legacyNsName] as Record<string, unknown> | undefined;
      if (isEmptyTable(legacy?.[sectionKey])) return;
      store[String(currentNs)] = { ...(current ?? {}), [sectionKey]: legacy?.[sectionKey] };
      persistFileStore();
      return;
    }
    const current = ctx.settings.get(currentNs) as Record<string, unknown> | undefined;
    if (!isEmptyTable(current?.[sectionKey])) return; // 新 key 已有数据（或迁移已完成）
    const legacy = ctx.settings.get(settingsNamespace(legacyNsName)) as
      | Record<string, unknown>
      | undefined;
    if (isEmptyTable(legacy?.[sectionKey])) return; // 旧 key 无数据 → 无迁移可做
    void ctx.settings.update(currentNs, { [sectionKey]: legacy?.[sectionKey] });
  } catch {
    // 迁移失败不影响主流程；旧数据仍在旧 key 下，下次加载重试。
  }
}

/**
 * 注册内置覆盖层 namespace（spec §7.1）。
 * schemastery 纪律：无 default 字段即 optional-by-default，绝不 .optional()。
 */
export function registerOverridesNamespace(ctx: Context): OverridesApi {
  const ns = settingsNamespace('prompt-forge-profile-overrides');
  const scope = registerOrReuseNamespace(
    ctx,
    ns,
    z.object({
      builtinOverrides: z.dict(z.object({ enabled: z.boolean(), sort: z.number() })),
    }),
  );
  migrateLegacySettingsSection(ctx, ns, 'prompt-master-profile-overrides', 'builtinOverrides');
  const read = (): Record<string, BuiltinOverride> =>
    (scope.get() as unknown as OverridesSection | undefined)?.builtinOverrides ?? {};
  return {
    get: read,
    all: read,
    set: async (id: string, o: BuiltinOverride | null) => {
      const next = { ...read() };
      if (o === null) delete next[id];
      else next[id] = o;
      await scope.update({ builtinOverrides: next });
    },
  };
}

/** 合并读取：builtins 按 overrides 过滤/重排，custom 追加其后，整体按 sort（缺省 999）+ id 稳定排序。 */
export function listProfilesMerged<T extends { id: string; sort?: number }>(
  builtins: T[],
  custom: T[],
  overrides: Record<string, BuiltinOverride>,
): T[] {
  const out: T[] = [];
  for (const b of builtins) {
    const o = overrides[b.id];
    if (o && o.enabled === false) continue;
    out.push(o?.sort !== undefined ? { ...b, sort: o.sort } : b);
  }
  out.push(...custom);
  return out.sort((x, y) => (x.sort ?? 999) - (y.sort ?? 999) || String(x.id).localeCompare(String(y.id)));
}

const IMPORT_KINDS = new Set(['expand', 'reverse', 'train']);

export function validateImportPayload(
  payload: unknown,
  builtinIds: string[],
): { ok: true; profile: Record<string, unknown> } | { ok: false; reason: string } {
  if (typeof payload !== 'object' || payload === null) return { ok: false, reason: 'payload 需为对象' };
  const p = payload as Record<string, unknown>;
  const builtinIdsSet = new Set(builtinIds);
  if (typeof p['id'] === 'string' && builtinIdsSet.has(p['id']))
    return { ok: false, reason: `id "${p['id']}" 与内置冲突：请移除 id 字段后重试（导入时会自动重铸）` };
  if (typeof p['name'] !== 'string' || !(p['name'] as string).trim()) return { ok: false, reason: 'name 必填' };
  if (typeof p['kind'] !== 'string' || !IMPORT_KINDS.has(p['kind']))
    return { ok: false, reason: `kind 需为 expand|reverse|train，得到 ${String(p['kind'])}` };
  if (typeof p['systemPrompt'] !== 'string' || !(p['systemPrompt'] as string).trim())
    return { ok: false, reason: 'systemPrompt 必填' };
  return { ok: true, profile: p };
}

/** 导入重铸：id → pe_custom_+uuid，强制 builtin:false，时间戳重置（PEProfile.createdAt/updatedAt 存在，编译门通过）。 */
export function recastImportedProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now();
  return { ...profile, id: `pe_custom_${randomUUID()}`, builtin: false, createdAt: now, updatedAt: now };
}
