# artist_hints Provenance 台账（M2 五批聚合 + 维护指引）

> M3-T3（spec §13 延伸）聚合。数据来源 = 各批 `tests/pe-framework/styles/m2-authoring.[a-e].test.ts`
> 注释块（rec 号/usage_count 留痕）+ 各批任务记录。authoring 时点逐名跑过 `catalog_search`。
> 采纳口径：canonical / alias grounded（usage_count ≥ 1000 或在案）；fuzzy 命中带
> `fuzzy_below_threshold` advisory 仅作候选，一律不采信；miss 弃用；验证失败留空（spec L114）。
> 库约定存**裸名**（catalog prompt_form 的 `@` 前缀不入库，nb 库同例：`guweiz` 而非 `@guweiz`）。

## 批 A — photography 7（T4，commit 4c4867f，impl-1）

| 预设 | artist_hints（落库顺序） |
| --- | --- |
| film_photography | loundraw, ross tran, wlop |
| studio_portrait | wlop, artgerm, guweiz |
| documentary_photo | loundraw, ross tran, loish |
| fashion_editorial | artgerm, mika pikazo, ross tran |
| night_street | guweiz, mika pikazo, loundraw |
| sports_action | loish, ross tran, guweiz |
| wildlife_nature | greg rutkowski, loish, ross tran |

采纳（9 名，rec 号 = catalog record_id）：wlop→@wlop(1299120)、guweiz→@guweiz(397364)、
artgerm→artgerm(94714)、greg rutkowski→@greg rutkowski(389496)、loundraw→@loundraw(665973)、
mika pikazo→@mika pikazo(735625)、ross tran→@ross tran(998912)、loish→@loish(661432)、
ask (askzy)→@ask (askzy)(102263)。

弃用（7 名）：annieleibovitz（miss）、steve mccurry（miss）、daido moriyama（fuzzy→daidouji）、
saul leiter（fuzzy→saul）、krenz cushart（fuzzy→krenz_(style)）、erik johansson（fuzzy→chiho_johansson）、
brook shaden（fuzzy→brooklyn）——均 fuzzy_below_threshold（usage_count 远低于采纳阈值）。

## 批 B — cg_3d 3 + oriental 2（T5，commit ad76da5，impl-2）

| 预设 | artist_hints |
| --- | --- |
| unreal_render | wlop, greg rutkowski, simon stalenhag |
| figure_model | （留空——无 canonical 手办画师，spec L114 规则） |
| claymation_clay | aardman, hokusai, ask (askzy) |
| ink_wash | hokusai, greg rutkowski, ask (askzy) |
| hanfu_xianxia | anmi, wlop, ask (askzy) |

采纳（新 4 名 + 复用 3 名）：simon stalenhag→@simon stalenhag(1093412)、aardman→aardman(28036)、
hokusai→@hokusai(452301)、anmi→@anmi(75427)；复用 wlop(1299120)/greg rutkowski(389496)/ask (askzy)(102263)。

弃用（2 名）：xu beihong（miss）、good smile company（仅 fuzzy 命中 goodsmile_company）。

## 批 C — dark_supernatural 2 + retro 2 + graphic 1（T6，commit 3529a47，impl-1）

| 预设 | artist_hints |
| --- | --- |
| gothic_vampire | abigail larson, gustave dore, edward gorey |
| eldritch_horror | greg rutkowski, abigail larson, loish |
| showa_retro | terada katsuya, ross tran, mika pikazo |
| vintage_photo | loundraw, ross tran, wlop |
| poster_constructivist | alphonse mucha, loish, ross tran |

采纳（新 5 名 + 复用 6 名）：abigail larson→@abigail larson(29397)、alphonse mucha→@alphonse mucha(58901)、
gustave dore→@gustave dore(397092)、edward gorey→edward gorey(288947)、terada katsuya→@terada katsuya(1183599)；
复用 greg rutkowski(397364)/loundraw(665973)/ross tran(998912)/wlop(1299120)/loish(661432)/mika pikazo(735625)。

弃用（3 名）：mary blair（仅 fuzzy 'blair'）、katsuhiro otomo（仅 fuzzy otomo_katsuhiro_(style)）、
egon schiele（仅 fuzzy egon_spengler）——均 fuzzy_below_threshold。

## 批 D — glamour_intimate sensitive 6（T7，commit e8ff991，impl-2）

artist_hints 全部**留空**（NSFW 档收紧裁定，captain/计划 T7 行——质量由 tag 组合承担；
无 catalog 验证需求）。d.test 断言 `artist_hints ≡ []` 钉死该裁定。

## 批 E — glamour_intimate explicit 4（T8，M2 收口，impl-2）

artist_hints 留空同批 D 裁定。批 E 的 catalog 验证对象为 **explicit 词表**（非画师，列此备查）：
采纳 10 词（nude/nipples/spread legs/hetero/sex/missionary/vaginal/elf/pointed ears/uncensored，
rec 号见 e.test 注释）；验证在案未用 3 词（bottomless/all fours/masturbation，留作后续扩表）。

## 维护指引

1. **新预设的 artist_hints 必须逐名过 `catalog_search`**：canonical/alias grounded 才采纳；
   fuzzy 命中带 `fuzzy_below_threshold` advisory 仅候选不采信；miss 弃用；验证失败留空（spec L114）。
2. 裸名入库（`@` 前缀是 catalog prompt_form，不入库）；rec 号/usage_count 留痕于对应批测试注释，
   本表随批次增量维护。
3. artist_max ≤ 3；NSFW 档（sensitive/explicit）artist_hints 一律留空（批 D 裁定延续）。

## style_save 维护注记（TR2 minor 收口）

同进程内对刚写入且未 git 提交的 id 二次 `style_save` 会静默覆盖且**不可从 git 恢复**
（未提交内容无历史快照，磁盘仅剩第二份）——写侧缓存镜像盲区（重复 id 检测走 registry 缓存
getStylePreset，已提交 id 全在缓存受保护；未提交产物不在缓存，二次写绕过冲突检测）。
该盲区性质为**数据丢失而非可恢复干扰**（TR2 minor 措辞经 captain 裁定修正，原「可恢复」表述不成立）；
触发条件仍窄（同进程 + 同 id + 首次写未提交），维持 low 定级。
未来硬化方向 = 写前 `existsSync` 预检。另：写入后同进程 registry 缓存不失效（重启提示分支，
见 style-save.ts 头注释与 style-save.test.ts 缓存语义用例）。
