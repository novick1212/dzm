import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

function png(width: number, height: number, rgba: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rgba)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

export function createTrayIcon(size = 32): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  const radius = size * 0.24
  const pad = Math.max(1, Math.round(size * 0.06))
  const bg = [178, 106, 0]
  const line = [255, 249, 240]

  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const offset = y * (size * 4 + 1) + 1 + x * 4
      const inRect = x >= pad && x < size - pad && y >= pad && y < size - pad
      let inRounded = false
      if (inRect) {
        const cx = Math.min(Math.max(x, pad + radius), size - pad - radius)
        const cy = Math.min(Math.max(y, pad + radius), size - pad - radius)
        inRounded = Math.hypot(x - cx, y - cy) <= radius + 0.5
      }
      if (!inRounded) {
        raw[offset + 3] = 0
        continue
      }
      const lineRow =
        (Math.abs(y - size * 0.3) < size * 0.03 || Math.abs(y - size * 0.5) < size * 0.03 || Math.abs(y - size * 0.7) < size * 0.03) &&
        x > size * 0.24 &&
        x < size * (x < size / 2 ? 0.72 : 0.8)
      const color = lineRow ? line : bg
      raw[offset] = color[0]
      raw[offset + 1] = color[1]
      raw[offset + 2] = color[2]
      raw[offset + 3] = 255
    }
  }
  return png(size, size, raw)
}
