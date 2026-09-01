// src/pe-framework/media/identity.ts — B4 多图身份映射（S 子集）
export interface TaggedMedia { n: number; tag: string }

export function enumerateTaggedMedia(count: number): TaggedMedia[] {
  return Array.from({ length: count }, (_, i) => ({ n: i + 1, tag: `<Picture ${i + 1}>` }))
}

export function buildIdentityDeclarations(media: TaggedMedia[], outputLang: 'zh' | 'en'): string {
  if (media.length < 2) return ''
  const lines = media.map((m) => outputLang === 'en' ? `${m.tag} = image #${m.n}` : `${m.tag} = 第 ${m.n} 张图`)
  const header = outputLang === 'en'
    ? 'Identity mapping — do not swap identities:'
    : '身份映射——不要混淆对应关系：'
  return `${header}\n${lines.join('\n')}`
}
