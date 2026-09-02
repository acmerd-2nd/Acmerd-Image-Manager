/**
 * Phase 2 共享校验器 —— 密码规则与站内回跳地址的唯一实现。
 * 任何页面（登录/注册/后续找回密码）都从这里引用，禁止各自复制逻辑。
 */

/** 密码规则（Owner 指定）：至少 8 位，且包含 数字 / 大写 / 小写 中的至少两类 */
export const PASSWORD_MIN_LENGTH = 8

export interface PasswordValidation {
  ok: boolean
  /** 面向用户的中文错误说明；ok 为 true 时为 null */
  message: string | null
}

export function validatePassword(password: string): PasswordValidation {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, message: `密码至少 ${PASSWORD_MIN_LENGTH} 位` }
  }

  const classes = [/[0-9]/, /[A-Z]/, /[a-z]/].filter((re) => re.test(password)).length
  if (classes < 2) {
    return {
      ok: false,
      message: '密码需包含数字、大写字母、小写字母中的至少两类',
    }
  }

  return { ok: true, message: null }
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
