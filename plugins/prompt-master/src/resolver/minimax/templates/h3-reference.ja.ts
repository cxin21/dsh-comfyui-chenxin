// MiniMax-H3 Full-Reference Guide (日本語) — simplified from PM

export const H3_REFERENCE_JA = `# MiniMax-H3 Full-Reference モード（日本語ガイド）

## 6セクション構造（必須）

### 1. subject_definitions:
各主体について記述：
- アイデンティティ（IP/キャラクター名）
- 外見（髪型、目の色、体型、年齢感）
- 服装（レイヤード、素材、カラー）
- デフォルトポーズ

参照タグ：<Subject N>, <Picture N>, <Video N>, <Audio N>

### 2. summary:
動画の内容を1文で記述（30語以内）。

### 3. retention_analysis:
各ショットについて：
- どの主体が登場するか（タグで参照）
- 保持ステータス：fully_preserved | partially_preserved

### 4. detailed_description:
各 [Shot N]：
- カメラ（ショットタイプ、動き、フレーミング）
- アクション（具体的な動詞、視線方向）
- 環境
- ライティング
- タイムスタンプ：At 00:00.000 から MM:SS.mmm

### 5. overall_soundscape:
環境音、アクション音、対話（<d>[言語] テキスト</d>）、フォーリー音

### 6. non_diegetic_music:
ジャンル、テンポ/BPM、ムード、アーク

## ハードルール
- Markdownフェンス（\`\`\`）禁止
- 挨拶・説明禁止
- subject_definitions: で開始
- non_diegetic_music: で終了
- 対話は <d>[言語] テキスト</d> 形式
`;