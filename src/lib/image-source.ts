import type { ImageSourceRow } from '@/types/database'

/**
 * V1.1 D3/D4：图片最终 URL 统一出口（makeImageUrl）。
 *
 * 设计 Gate 裁决：
 * - `source_url` 不落库（衍生值），最终 URL 一律由此函数动态计算；
 *   未来切换 CDN / commit-pinned URL / jsDelivr / 代理出口只改本文件，不动数据。
 * - provider='supabase_storage'：沿用 Supabase Storage public URL（storage_path 含
 *   bucket 名，形如 images/{asset}/{lang}/{file}，与 V1.0 约定一致）。
 * - provider='github'：raw.githubusercontent.com 直链；大陆可访问性风险（Gate R1）
 *   通过 GITHUB_IMAGE_CDN_BASE 预留切换口——设置该环境变量后整体切换到
 *   CDN/代理前缀（如 jsDelivr 或 Cloudflare 代理），无需迁移数据。
 */

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '')
const SUPABASE_STORAGE_PUBLIC = `${SUPABASE_URL}/storage/v1/object/public`

/** GitHub 图片 CDN 出口；未设置时回落 raw.githubusercontent.com（R1 风险：大陆不可靠） */
const GITHUB_IMAGE_CDN_BASE = import.meta.env.VITE_GITHUB_IMAGE_CDN_BASE as string | undefined

export interface GithubImageRepoConfig {
  owner: string
  repo: string
  branch: string
}

const GITHUB_REPO: GithubImageRepoConfig = {
  owner: (import.meta.env.VITE_GITHUB_IMAGES_OWNER as string | undefined) ?? '',
  repo: (import.meta.env.VITE_GITHUB_IMAGES_REPO as string | undefined) ?? '',
  branch: (import.meta.env.VITE_GITHUB_IMAGES_BRANCH as string | undefined) ?? 'main',
}

function supabasePublicUrl(storagePath: string): string {
  // storage_path 含 bucket 名（images/...），public URL 需去掉第一段（V1.0 既有约定）
  const withoutBucket = storagePath.split('/').slice(1).join('/')
  return `${SUPABASE_STORAGE_PUBLIC}/images/${withoutBucket}`
}

function githubRawUrl(sourcePath: string): string {
  if (GITHUB_IMAGE_CDN_BASE) {
    return `${GITHUB_IMAGE_CDN_BASE.replace(/\/$/, '')}/${sourcePath}`
  }
  return `https://raw.githubusercontent.com/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}/${GITHUB_REPO.branch}/${sourcePath}`
}

/** 计算图片来源行最终可访问 URL；非法行（provider 与路径不匹配）返回 null */
export function makeImageUrl(image: Pick<ImageSourceRow, 'provider' | 'storage_path' | 'source_path'>): string | null {
  switch (image.provider) {
    case 'supabase_storage':
      return image.storage_path ? supabasePublicUrl(image.storage_path) : null
    case 'github':
      return image.source_path ? githubRawUrl(image.source_path) : null
    default:
      return null
  }
}

/**
 * V1.4 站点品牌 Logo URL 出口（与图片同源，统一走 githubRawUrl / CDN 切换口）。
 * path 为空（未配置 logo）返回 undefined，调用方回落纯文字（<img src> 接受 undefined）。
 */
export function brandLogoUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  return githubRawUrl(path)
}

/**
 * V1.7.0：合集本地上传封面 URL 出口（与 Logo 同源，走 githubRawUrl / CDN 切换口）。
 * path 为空（未上传，回落选中的资产图 cover_image_id）返回 undefined。
 */
export function collectionCoverUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  return githubRawUrl(path)
}

/**
 * V1.5 B2：360° 序列帧 URL 唯一出口（Gate §40/§41）。
 * 帧与普通图片同仓同分支，故直接复用 makeImageUrl 的 github 分支；
 * 未来 GitHub → CDN 切换只改本文件，前后台组件零改动。
 * index 仅为语义携带（播放顺序以数组顺序 = frame_index 为准，绝不依赖文件名排序）。
 */
export interface Frame360Source {
  /** 1-based 帧序号 */
  index: number
  /** 仓库内路径，形如 assets/{assetId}/360/{sequenceId}/0001.png */
  path: string
}

export function make360FrameUrl(frame: Frame360Source): string | null {
  if (!frame?.path) return null
  return makeImageUrl({ provider: 'github', storage_path: null, source_path: frame.path })
}
