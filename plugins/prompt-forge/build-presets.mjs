/**
 * NewBie 65 预设 → 我们的 style_presets 资产（一次性数据管线，node 直跑）。
 * - 画师解析：剥离 [[x]]/{x}/(x:权重) 装饰与权重，保留裸名
 * - 每个画师走真 catalog 验证（searchCatalog，canonical/alias 才收）
 * - 分级：关键词启发（nsfw → sensitive → safe），保守分类
 * - 产出：assets/style-presets/*.json + 验证报告
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { searchCatalogSync } from './dist/src/pe-framework/dialect/anima-catalog.js';

const raw = JSON.parse(readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
const presets = raw.style_presets || raw.styles;
const keys = Object.keys(presets);
console.log('source presets:', keys.length);

function parseArtists(field) {
  if (!field) return [];
  return String(field)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) =>
      s
        .replace(/[\[\]{}]/g, '')
        .replace(/\(([^:)]+)(:[0-9.]+)?\)/g, '$1')
        .trim(),
    )
    .filter((s) => s && !/^year\s*\d+$/i.test(s) && !/^20\d{2}year$/i.test(s));
}

function parseStyleTags(field) {
  if (!field) return [];
  return String(field)
    .split(',')
    .map((s) => s.trim().replace(/\*\*/g, ''))
    .filter((s) => s && s.length > 2 && !/^(artist|year)/i.test(s))
    .slice(0, 12);
}

function classify(text) {
  const t = text.toLowerCase();
  if (/(nsfw|nude|naked|sex|porn|裸|全裸|乳交|sex_from_behind|female_ejaculation|cum)/.test(t)) return 'nsfw';
  if (/(wet|bunny|lingerie|swimsuit|泳|湿|情趣|sexy|sensual|seductive|pussy|nipples|areolae|torn)/.test(t))
    return 'sensitive';
  return 'safe';
}

const verifiedCache = new Map();
function verifyArtist(name) {
  const key = name.toLowerCase();
  if (verifiedCache.has(key)) return verifiedCache.get(key);
  let ok = false;
  try {
    // searchCatalog 现为 async 公共入口（spec §3.2）；画师存在性校验走同步双入口（semantic 永不参与）
    const hits = searchCatalogSync(name, { limit: 1 });
    const top = hits && hits[0];
    ok = !!(top && top.match_type && (top.match_type === 'canonical' || top.match_type === 'alias'));
  } catch {
    ok = false;
  }
  verifiedCache.set(key, ok);
  return ok;
}

mkdirSync('assets/style-presets', { recursive: true });
const report = { emitted: [], skipped: [], artistsAdded: new Set() };
let idx = 0;
for (const k of keys) {
  idx++;
  const v = presets[k];
  if (!v || typeof v !== 'object') {
    report.skipped.push(k + ' (no object)');
    continue;
  }
  const artistsRaw = parseArtists(v.artist);
  const artists = [];
  for (const a of artistsRaw) if (verifyArtist(a) && !artists.includes(a)) artists.push(a);
  const styleTags = parseStyleTags(v.style);
  const rating = classify(k + ' ' + String(v.style || '') + ' ' + String(v.artist || ''));
  if (artists.length < 2) {
    report.skipped.push(k + ` (verified artists ${artists.length} < 2)`);
    continue;
  }
  const slug =
    'nb' +
    String(idx).padStart(2, '0') +
    '_' +
    String(k)
      .replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 28)
      .toLowerCase();
  const preset = {
    id: slug,
    name: k,
    rating,
    source:
      'NewBie-LLM-Formatter style_presets (artists catalog-verified ' + new Date().toISOString().slice(0, 10) + ')',
    artists,
    artist_max: 3,
    style_tags: styleTags,
  };
  writeFileSync('assets/style-presets/' + slug + '.json', JSON.stringify(preset, null, 2) + '\n');
  for (const a of artists) report.artistsAdded.add(a);
  report.emitted.push(slug + ' [' + rating + '] artists=' + artists.length + ' styleTags=' + styleTags.length);
}
console.log('emitted:', report.emitted.length);
for (const e of report.emitted) console.log('  +', e);
console.log('skipped:', report.skipped.length);
for (const s of report.skipped) console.log('  -', s);
console.log('union verified artists:', report.artistsAdded.size);
writeFileSync(
  'preset-report.json',
  JSON.stringify({ emitted: report.emitted, skipped: report.skipped, artists: [...report.artistsAdded] }, null, 2),
);
