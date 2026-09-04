# V1.1 Stage 1 Migration Report

- **时间**: 2026-09-04T11:10:56.803Z
- **模式**: DRY-RUN（计划报告，零写入）
- **目标**: `undefined/(dry-run 未指定)` @ `main`
- **路径规范**: assets/{asset-uuid}/{langCode}/{filename}（Q1 冻结）
- **待迁移**: 1 张

| # | Image ID | 源 (storage_path) | 目标 (source_path) | git blob sha | sha256 | HEAD | 结论 |
| - | -------- | ----------------- | ------------------ | ------------ | ------ | ---- | ---- |
| 01 | `4b928bec-c1ef-474d-ab56-13269a25b8ef` | `5d5449a9-a48c-4123-973b-5e1c37b3a431/en/01-15822bee.jpg` | `assets/5d5449a9-a48c-4123-973b-5e1c37b3a431/en/tu1.jpg` | `7a20f0e88a87…` | `2280d6064f59…` | (dry-run) | 🟡 PLAN (896.2 KB) |

## 结论

🟡 DRY-RUN — 以上为迁移计划；确认目标仓库后以 --execute + STAGE1_CONFIRM=yes 执行。
