/**
 * V1.1 D2：zh-CN 文案字典（默认语言）。
 * 硬规则（Owner 裁决）：V1.1 新建 UI 必须从第一天起使用 i18n key，
 * 禁止"先写中文后补国际化"。
 */
export const zh = {
  // Phase C 起逐项填充；此骨架先行锁定 key 结构与 t() 契约
  common: {
    loading: '加载中…',
    error: '出错了，请稍后重试',
    retry: '重试',
  },
} // 不用 as const：字典值需放宽为 string，en 等语言才能满足同构赋值

export type Dictionary = typeof zh
