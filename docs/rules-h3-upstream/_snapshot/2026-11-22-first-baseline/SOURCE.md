# SOURCE.md — 2026-11-22 首次基线快照溯源

official_dir: skills/h3-prompt-writing
source_url: https://raw.githubusercontent.com/MiniMax-AI/MiniMax-H3/main/skills/h3-prompt-writing/SKILL.md
commit: 199b7d0e1fd95e7b3eafa8c15eca692534142427
tag: none（官方仓截至本快照抓取日无 release、无 tag；以 main HEAD commit 为版本锚点）

以上 4 个键（official_dir / source_url / commit / tag）为
`scripts/check_h3_upstream.py` 的机器可读契约行，请保持行首键名不动。

## 抓取信息

- 抓取日期：2026-11-22（Asia/Shanghai）
- 上游仓库：https://github.com/MiniMax-AI/MiniMax-H3
- 快照锚点：main 分支 HEAD commit `199b7d0e1fd95e7b3eafa8c15eca692534142427`
  （2026-10-28T10:13:57Z，"Merge pull request #83 from SammanthaLLM/main"）
- 抓取方式：`gh api repos/MiniMax-AI/MiniMax-H3/contents/skills/h3-prompt-writing/<file>`
  带 `Accept: application/vnd.github.raw` header，逐文件落盘
- verbatim 校验：4 个文件逐一 `git hash-object` 与上游 tree API 返回的 blob SHA
  完全一致（见下表第 3 列），一字未改
- 本快照目录与官方 `skills/h3-prompt-writing/` 子树 1:1 镜像（`scripts/check_h3_upstream.py`
  的对比契约要求；SOURCE.md 是唯一额外文件）

## 官方当时最新 release/tag

无。`GET /repos/MiniMax-AI/MiniMax-H3/releases` 返回空数组（0 个 release），
`GET /repos/MiniMax-AI/MiniMax-H3/tags` 返回空数组（0 个 tag）。官方未使用
GitHub Releases 机制发布版本，仓库演进只体现在 main 分支 commit 上。

## 文件清单与哈希

| 快照内相对路径 | sha256 | 上游 blob SHA（git hash-object 校验一致） |
| --- | --- | --- |
| `SKILL.md` | `a7000443588ca3f145e3b3fd8900f14e0325dc460bd811268fac89a9dc8e56d0` | `b6d9b2839384a588763a9c24315225dd8ce19d56` |
| `agents/openai.yaml` | `7770c9d784b7251ab882ee29a738219a3f01811e57ba7fc7822fa83eb8438c1a` | `8151bd25e3dc29bdb67c8049e39c34c60c3f08f8` |
| `references/base-en.txt` | `2cfebc096a6e08370f288d468d90b60f7f9bcb938f94bf090816e910e48e75fc` | `40cf586a634d677d6b7107b367cf0ec9621be728` |
| `references/ref-en.txt` | `1e574f356716ad55612247ffb7bbccbcdb484ad96599d63c7dca1af186b1fab7` | `7ae1b2d07d743fd2392258a96449be9e9e322d35` |

## 仓库内同名 skill 的其他两份镜像（未进本快照，仅为事实记录）

官方仓存在三份 h3-prompt-writing 目录，本快照以 README 安装命令与
`skills-lock.json`（`"skillPath": "skills/h3-prompt-writing/SKILL.md"`）指向的
顶层 `skills/h3-prompt-writing/` 为基线。另外两份镜像的当时状态：

- `.claude/skills/h3-prompt-writing/` 与 `.agents/skills/h3-prompt-writing/`：
  两份互为字节一致（同 blob SHA）；其中 `agents/openai.yaml`、`references/base-en.txt`、
  `references/ref-en.txt` 与顶层副本一致（blob SHA 相同），唯 `SKILL.md` 不同：
  上游 blob `066429d78f72b080a52350a5b165e52cb31b0bca`，缺顶层副本末尾的
  "## Tips for Better Results" 5 行小节（PR #44 只改了顶层副本）。
- `skills-lock.json`（上游根目录，blob `7051fccb4d01d120ac3396f130e3c5a90490fb33`）
  记录 `h3-prompt-writing` 的 `computedHash`：
  `3d01859464bc9438585c8fdbf7fcd4b4c54404fadd3f1a64ab7970ae8877d086`
  （该哈希与当前两个 SKILL.md 变体的 sha256 均不一致，系 2026-08-07 安装时的
  旧内容快照，之后 skill 文件又改过；如实记录，不解读）。

来源：
- tree API：https://api.github.com/repos/MiniMax-AI/MiniMax-H3/git/trees/main?recursive=1
- skills-lock.json：https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills-lock.json
- skills/README.md：https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/README.md
- 详细历史与命令记录：`plugins/prompt-forge/docs/research/2026-11-22-issue-19-h3-official-skill-snapshot.md`
