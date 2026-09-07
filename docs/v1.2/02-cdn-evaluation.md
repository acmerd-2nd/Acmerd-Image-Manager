# V1.2-D — R1 CDN 切换实测评估报告（jsDelivr @main）

> **依据**: docs/v1.2/01-design-gate.md §4 D12（Owner 2026-09-07 批准：只做实测评估 + 决策留档，不直接默认切换）
> **实测日期**: 2026-09-07 · **实测环境**: 本机（WARP 出口，非大陆直连）· **生产镜像**: `assets/5d5449a9-a48c-4123-973b-5e1c37b3a431/en/tu1.jpg`（917,700 B）
> **结论（建议）**: ❌ **jsDelivr 方案不可行，R1 维持现状（raw.githubusercontent.com 直出）**；如需大陆加速，另立 Change Proposal 评估 gh-proxy 类镜像或自有 CDN/代理域名。

---

## 1. D12 要求实测的三件事

| # | 实测项 | 结果 |
| --- | --- | --- |
| ① | 仓库首字符 `-`（`-Photo-Acmerd-Image-Manager`）在 `cdn.jsdelivr.net/gh/…` 下的兼容性 | **无法判定语义兼容性——jsDelivr 对 gh 面整体已停止回源服务**（见 §2），首字符问题被更上游的失败掩盖 |
| ② | 大陆可达性 | **失去评估意义**：jsDelivr 现在不代理 GitHub 内容，最终 301 到 raw.githubusercontent.com——大陆可达性与现状（raw 直链）**完全相同**，切换零收益 |
| ③ | 删除/更新后 stale 窗口 | 同上：因无 CDN 缓存层介入，**不存在 jsDelivr stale 窗口问题**；删除语义 = 现状（raw 直链，仓库删即 404） |

## 2. 决定性实测：jsDelivr `gh/` 面已整体 301 → raw.githubusercontent.com

**方法**：对本仓库与公认健康的知名仓库做同形态对照（`curl -sI`，2026-09-07）。

| 对照组 | URL | 结果 |
| --- | --- | --- |
| 本仓库 · 生产图 @main | `cdn.jsdelivr.net/gh/acmerd-2nd/-Photo-Acmerd-Image-Manager@main/assets/5d5449a9-…/en/tu1.jpg` | `301` → `Location: raw.githubusercontent.com/acmerd-2nd/-Photo-…/main/…`（`Cache-Control: public, max-age=604800`） |
| 本仓库 · README @main | `…/gh/acmerd-2nd/-Photo-Acmerd-Image-Manager@main/README.md` | `301` → raw（同上） |
| **对照** jquery @tag（公认健康仓库 + 固定 tag） | `cdn.jsdelivr.net/gh/jquery/jquery@3.7.1/README.md` | `301` → `raw.githubusercontent.com/jquery/jquery/3.7.1/README.md` |
| **对照** npm 面（jsDelivr 主服务形态） | `cdn.jsdelivr.net/npm/react@18.3.1/package.json` | `200`（正常 CDN 服务） |
| 跟随重定向终态（-L） | 本仓库生产图 | `final:200`，最终 URL = **raw.githubusercontent.com**（`2.45s / 917,700 B`，与直连 raw 一致） |

**解读**：

1. jsDelivr 的 `gh/` 路径对**所有**仓库（含 jquery 固定 tag）统一 `301 Moved Permanently` 到 `raw.githubusercontent.com`，即 jsDelivr 已不再充当 GitHub 内容的边缘缓存；`npm/` 面仍正常 CDN。这与社区长期观察到的 "jsDelivr 与 GitHub 合作变化 / raw 滥用治理" 方向一致（本次以实测为准，不做时间线考证）。
2. 因此 D12 原拟验证的三个技术问题（首字符兼容、大陆可达、stale 窗口）在当前形态下**全部失效或失去意义**——把 `VITE_GITHUB_IMAGE_CDN_BASE` 指向 jsDelivr 等价于在 raw 直链前加一次"跳转 + 一次失败缓存的中间域"，**只增延迟与脆弱性，零加速收益**。

## 3. 结论与建议

- **jsDelivr 选项：从 R1 候选中排除**（非策略选择，而是服务形态已不支持）。
- **R1 维持现状**：raw.githubusercontent.com 直出；`VITE_GITHUB_IMAGE_CDN_BASE` 切换口保留（零成本，未来任何 CDN/代理可用）。
- 如未来确认大陆访问不可接受，候选方向（**均需另立 Change Proposal，本报告不展开**）：
  1. gh-proxy 类自建/公共镜像（如 `gh-proxy.com` 形态；公共实例有滥用封禁与可用性风险）；
  2. 自有代理域名（Cloudflare 域内 Worker/页面代理 raw——注意触碰"无 Worker 图片代理"冻结不变量，须 Owner 明确解冻）；
  3. 恢复 Supabase Storage 直出（生产原件仍在，回滚即切回）。
- `@commit-sha` 永久缓存方案：按 Gate D12 **明确排除**，不评估。

## 4. 本报告未覆盖项（如实声明）

- 大陆本地实测（本机为 WARP 出口，无法代表大陆网络视角；但结论不依赖此——jsDelivr 已不服务 gh 内容，大陆可达性 = raw 现状）。
- jsDelivr purge API 接入 github-delete 流程：**无意义**（无缓存层可 purge），按 Gate 预定排除。

---

**Owner 终裁待办**：确认本报告结论 → R1 关闭（维持现状）或另立 Change Proposal。
