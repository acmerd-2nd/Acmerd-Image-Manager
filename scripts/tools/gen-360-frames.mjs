// 生成 360° 走查用的合成帧序列（旋转指针盘 + 帧号刻度），用于 B2 后台上传/预览实走。
// 纯 Node（zlib + 手写 PNG 编码），无第三方依赖；输出 RGBA PNG，尺寸可调。
// 用法：node scripts/tools/gen-360-frames.mjs <outDir> <frameCount>
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const outDir = process.argv[2] ?? '.scratch/360-frames'
const count = Number(process.argv[3] ?? 36)
const W = 320
const H = 320

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
const crc32 = (buf) => {
  let c = ~0
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return ~c ^ 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(outDir, { recursive: true })
const cx = W / 2
const cy = H / 2
for (let i = 1; i <= count; i++) {
  const angle = (i - 1) / count // 0 → 1 一整圈
  const rgba = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx
      const dy = y - cy
      const r = Math.hypot(dx, dy)
      let cr = 245, cg = 246, cb = 248 // 背景
      let a = 255
      const inRing = Math.abs(r - 120) < 3
      const ang = (Math.atan2(dy, dx) + Math.PI * 2) / (Math.PI * 2)
      // 指针：从中心沿 angle 方向的窄扇形
      let da = Math.abs(ang - angle)
      da = Math.min(da, 1 - da)
      const inPointer = r > 12 && r < 132 && da < 0.035
      // 每 1/12 圈的粗刻度（提供转速参照）
      const tickAng = (Math.round(ang * 12) / 12)
      const nearTick = Math.abs(ang - tickAng) < 0.008 && r > 100 && r < 140
      if (inRing) (cr = 120), (cg = 126), (cb = 134)
      if (nearTick) (cr = 70), (cg = 76), (cb = 86)
      if (inPointer) (cr = 226), (cg = 62), (cb = 46)
      if (r < 12) (cr = 40), (cg = 44), (cb = 52)
      rgba.writeUInt8(cr, (y * W + x) * 4)
      rgba.writeUInt8(cg, (y * W + x) * 4 + 1)
      rgba.writeUInt8(cb, (y * W + x) * 4 + 2)
      rgba.writeUInt8(a, (y * W + x) * 4 + 3)
    }
  }
  const name = `${String(i).padStart(4, '0')}.png`
  writeFileSync(join(outDir, name), encodePng(W, H, rgba))
}
console.log(`generated ${count} frames -> ${outDir}`)
