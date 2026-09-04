[setup] isolated db acmerd_phase10_reg_mhxckd created
[migrate] 0001..0007 applied (7 files)
[seed] 8 published assets + 2 tags（供 I1–I4 基线）

--- R3 Asset Regression（Create/Edit/Publish/Archive/Delete/Cover）---
  PASS  R3-1 Create：admin 插入 draft asset
  PASS  R3-2 Edit：name/description 更新并回读一致
  PASS  R3-3 Publish 终守卫：无 published 语言+图 → PUBLISH_BLOCKED
  PASS  R3-4 Publish：语言 published+有图后发布成功
  PASS  R3-5 Cover 守卫：跨资产 cover → COVER_MISMATCH
  PASS  R3-6 Cover：同资产图设为封面成功
  PASS  R3-7 Unpublish：published→draft，guest 不可见
  PASS  R3-8 Archive：archived 后 guest 不可见
  PASS  R3-9 Restore（archived→draft）：guest 仍不可见（draft 态）
  PASS  R3-9b 重新发布后恢复可见
  PASS  R3-10 状态化审计：published/unpublished/archived/restored 四语义全留痕（allowlist 内） — asset.archived,asset.created,asset.published,asset.restored,asset.unpublished,asset.updated
  PASS  R3-11 user UPDATE assets → 0 行旁路（回读未变）

--- R4 Language Regression（EN/DE/IT/FR/ES × Draft/Published/Switch）---
  PASS  R4-1 五语言 en/de/it/fr/es 全部可创建（CHECK 通过）
  PASS  R4-2 非法语言码 zh → CHECK 拒绝
  PASS  R4-3 同资产同语言重复 → unique 拒绝
  PASS  R4-4 双层可见性：asset published + 仅 en published → language_count=1
  PASS  R4-5 Switch：de/it 相继 published → language_count=3
  PASS  R4-6 Unpublish：de 回 draft → language_count=2
  PASS  R4-7 draft 语言下的图不计入 guest 可见面（image_count 只算 published 语言：en+it 各 1 图） — image_count=2
  PASS  R4-8 语言审计（0007 五语义）：created/published/unpublished 留痕 — asset_language.created,asset_language.published,asset_language.unpublished
  PASS  R4-9 user 写 asset_languages → 0 行旁路
  PASS  R3-12 Delete：asset 删除后语言/图级联清零 — langs=0 images=0

[migrate] 0008 applied — I1–I4 复验
  PASS  I1a search_assets 签名保持 (p_q, p_tags)
  PASS  I1a search_assets_paged 含 total
  PASS  I1b/I3 search 结果 0008 前后 canonical 一致（NO-DRIFT，6 fixture） — drift=0
  PASS  I2 分页并集=全量、无重复 — union=10 full=10
  PASS  I2a 分页拼接顺序与全量一致
  PASS  I4 anon 只见 published（数量=admin 视角 published 数，无 draft 泄漏） — n=10 pub=10

[result] PASS=28 FAIL=0
[cleanup] isolated db acmerd_phase10_reg_mhxckd dropped
