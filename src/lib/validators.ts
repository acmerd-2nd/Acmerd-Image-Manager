/**
 * Phase 2 共享校验器 —— 密码规则与站内回跳地址的唯一实现。
 * 任何页面（登录/注册/后续找回密码）都从这里引用，禁止各自复制逻辑。
 */

/** 密码规则（Owner 指定）：至少 8 位，且包含 数字 / 大写 / 小写 中的至少两类 */
export const PASSWORD_MIN_LENGTH = 8

/** 校验失败原因（枚举，文案由 UI i18n 层渲染 —— 规则唯一实现在此，文案就近翻译） */
export type PasswordFailReason = 'too_short' | 'weak'

export interface PasswordValidation {
  ok: boolean
  /** ok=false 时的失败原因 */
  reason?: PasswordFailReason
}

export function validatePassword(password: string): PasswordValidation {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, reason: 'too_short' }
  }

  const classes = [/[0-9]/, /[A-Z]/, /[a-z]/].filter((re) => re.test(password)).length
  if (classes < 2) {
    return { ok: false, reason: 'weak' }
  }

  return { ok: true }
}

/**
 * 站内回跳地址白名单校验（防 open redirect）。
 *
 * 规则：
 * - 仅接受以单个 `/` 开头的相对路径
 * - 拒绝协议相对地址（`//evil.com`、`/\evil.com`）
 * - 拒绝反斜杠、冒号（封掉 javascript: / data: / http: 等一切 scheme）
 * - 拒绝控制字符
 * - 反复解码直到稳定（最多 3 轮），在最终形态上做检查 —— 封掉
 *   `%2F%2F`、`%252F%252F`、`%5C` 等编码/双重编码绕过
 */
export function sanitizeInternalRedirect(raw: string | null | undefined): string | null {
  if (!raw) return null
  if (raw.length > 2048) return null

  let candidate = raw
  for (let round = 0; round < 3; round++) {
    let decoded: string
    try {
      decoded = decodeURIComponent(candidate)
    } catch {
      // 非法编码序列一律拒绝
      return null
    }
    if (decoded === candidate) break
    candidate = decoded
  }

  if (!candidate.startsWith('/')) return null
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return null
  if (candidate.includes('\\')) return null
  if (candidate.includes(':')) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return null

  return candidate
}

/**
 * 语言代码白名单（Phase 4）——?lang 解析的唯一实现。
 * 规则（Owner 指定）：仅接受小写 en/de/it/fr/es；大写或非法值一律视为无效（返回 null），
 * 由调用方静默回退到默认 published 语言。
 */
const LANGUAGE_SET = new Set(['en', 'de', 'it', 'fr', 'es'])

export function parseLanguageCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  // 严格小写匹配：'EN' / 'En' / 'de-DE' / 'en ' 等一律无效
  return LANGUAGE_SET.has(raw) ? raw : null
}

/**
 * 网盘 Package URL 安全校验（Phase 5，与 0004 DB 触发器同规则的前端二次防御）。
 * 规则：必须 https；host 精确等于允许列表（禁止子串/前缀匹配）；无 userinfo/端口。
 * 绝不对未通过校验的 URL 调用 window.open。
 */
const PACKAGE_ALLOWED_HOSTS = new Set(['pan.quark.cn', 'pan.baidu.com', 'yun.baidu.com'])

export function isSafePackageUrl(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return false
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  if (u.username || u.password) return false
  if (u.port) return false
  return PACKAGE_ALLOWED_HOSTS.has(u.hostname.toLowerCase())
}
