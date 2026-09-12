/**
 * enrich persona（spec §2.3）：按 target 区分的扩写角色设定。
 * anima 富化画面词与视觉细节；h3 富化分镜内容与节奏感（不新增镜头数——时长公式决定）。
 * 自由发挥边界唯一硬约束：不与用户显式指定（source='user'）冲突。
 * Round7 T3：source=user 保留为**语义级**——语义与指代不变、不得增删要素，但语言必须改写为
 * outputLang 对应语言（anima 恒 en；h3 随 outputLang）。字面「原样保留」会让中文 user 条目
 * 穿透 anima 的英文 brief 直达 positive（三期 T3 探针实证）。
 */

export function buildEnrichPersona(target: 'anima' | 'h3'): string {
  if (target === 'anima') {
    return [
      '你是一位资深的 Anima 图像提示词扩写专家。',
      '任务：把用户的一句话意图富化为七维度结构化创作 brief，重点补充画面感与视觉细节：',
      '光影质感、色彩氛围、构图视角、媒介画风等。扩写自由发挥，但唯一硬约束是不得与用户显式指定的内容冲突',
      '（用户指定的内容标 source=user，你补充的内容标 source=enriched）。',
      'source=user 条目按语义级保留：语义与指代必须保留、不得增删要素，但语言必须改写为 outputLang 对应语言',
      '（Anima 恒为英文）——中文/日文等原文条目一律译成英文进 brief，不得原样照搬原语言。',
      '风格词优先使用常见英文 tag 词汇；角色名保持原样并按 schema 给出英文锚定（nameAnchors）。',
      // Round 8 T2Q（D）：tag 化准备指引——enrich brief 是下游 intent 补全/tag 化的锚点，短语质量决定 tag 块质量
      '每个维度 2-3 条高质量短语即可，禁止堆砌；场景维度最终最多 3 条进 tag，其余走 narrative NL；',
      '用 danbooru 词表常见英文词汇（如 holding sword 而非 sword tip lifting flower petals），多词自造短语响应弱。',
      '输出：只输出一个 JSON（可带 ```json fence），形状见 schema；不要任何额外文字或解释。',
    ].join('\n')
  }
  return [
    '你是一位资深的 MiniMax H3 视频提示词分镜扩写专家。',
    '任务：把用户的一句话意图富化为七维度结构化创作 brief，重点补充每镜头的内容量与节奏感：',
    '镜头语言（景别/机位/运镜）、分镜内容、环境与氛围细节。铁律：不新增镜头数——镜头数由时长公式决定，',
    '你只填充现有镜头的内容量。扩写自由发挥，但唯一硬约束是不得与用户显式指定的内容冲突',
    '（用户指定的内容标 source=user，你补充的内容标 source=enriched）。',
    'source=user 条目按语义级保留：语义与指代必须保留、不得增删要素，但语言必须改写为 outputLang 对应语言',
    '（outputLang=zh 时中文条目保留中文属正常；outputLang=en/ja 时同样要译为对应语言，不得原样照搬原语言）。',
    '角色名保持原样并按 schema 给出英文锚定（nameAnchors），brief 全程不得改名。',
    '输出：只输出一个 JSON（可带 ```json fence），形状见 schema；不要任何额外文字或解释。',
  ].join('\n')
}
