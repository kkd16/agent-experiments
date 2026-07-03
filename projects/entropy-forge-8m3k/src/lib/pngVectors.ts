// pngVectors.ts — frozen known-answer PNG test vectors.
//
// These are real PNG files produced by an *independent* encoder — Node's own
// zlib (`zlib.deflateSync` for the IDAT, `zlib.crc32` for the chunk CRCs), which
// shares no code with this lab's DEFLATE. Decoding them with our from-scratch
// `decodePNG` and hashing the resulting RGBA must reproduce `rgbaHash` — a hash
// computed from the *source* pixel pattern, before any of our code touched it. A
// match therefore proves our decoder reproduces the exact intended pixels of a
// real-world, third-party-compressed PNG: genuine interoperability, verified
// headlessly (no browser needed). The Image Studio adds the reverse proof — the
// browser's own PNG decoder renders our encoder's output — at runtime.

export interface PngVector {
  name: string
  width: number
  height: number
  colorType: number
  bitDepth: number
  interlace: number
  rgbaHash: number // FNV-1a (32-bit) of the expected width·height·4 RGBA bytes
  b64: string
}

export const PNG_VECTORS: PngVector[] = [
  { name: "truecolour 8-bit", width: 16, height: 10, colorType: 2, bitDepth: 8, interlace: 0, rgbaHash: 3570210037, b64: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAIAAAAy3EnLAAABiElEQVR4nAXBoa6FIBgA4D9YbyCxnXAC5YS7UTzhVjeoNpNkZmfObnIUM5uFKA/A2IxUN3wBXsBgNXq/DwAAwQ+BVwkfBt8GKgn1AO0EnYHewbjBvMOSYb3APxAB8A/CL4I/Jf4yXDW4lrgdcDfh3uDR4XnDy47XjP2F44MPAPpC9EPot6QVo3VDW0m7gfYTHQ2dHV02uu7UZxovejw0A/AP4l/Cq5LXjLcN7yTvBz5OfDZ8cXzduN95zPy4eH74CSC+SFRE1KVomega0UsxDmKexGLE6oTfRNzFkUW+xPmIG0BVSNVEtaXqmOobNUo1D2qZ1GqUdypu6thVzuq81P2oAkDXSLdEd6XumR4bPUu9DHqdtDc6On1sOu/6zPq+dPFoBGBbZDti+9KOzM6NXaRdB+snG409nM2bPXd7Z1tcFj32DRA6FHoSxjLMLCxNWGXwQ4hTOEzILpxbuPdQ5ICu8H7CL0DqURpJmsu0sLQ2ycsUh3RMKZt0unRvqdgTyul9pd8n/f0DJH/i4U6zpB4AAAAASUVORK5CYII=" },
  { name: "truecolour interlaced (Adam7)", width: 13, height: 11, colorType: 2, bitDepth: 8, interlace: 1, rgbaHash: 192780863, b64: "iVBORw0KGgoAAAANSUhEUgAAAA0AAAALCAIAAAFc16CgAAABgUlEQVR4nAXBIWhcMQAG4J/BY66u5GAXAq9QcaqFkR0pJO6Y2ODEg5ikomp1J0JFCQdzFWcedYuZOHEqUxMNK0zUBSbOxdUtVK8QcWLfBwAVABpq+w0HGACuPZv2HfBwflX9s/FLCCACPQDh59Hvej+BaKvYln07AySEnDo5j3KoctXLjZE7IEGkwaVdTIealn3amtQADsE3jk8i31Z+1vNfhn8EBTQwAhnoAAWAyiMtZ6NcZHnVybWS30D9VPth9Jvsnzp/UP49aJrptB7TPqfTLt2q9Ae0zXXbjW2S213XmmpfQPlC8/3ILzN/6fiN4m8ABsreCnak2bFj05GdRDbL7LyyecdUzxaKfTZsACyoPRZ2pq1ydhjtdbTrbO+r3XX2sbd7Zf8aewACaDgRYaHDtQubMfyIYZ/Daw2TLlz04VKFryZsgQJazkW50uXelaexvMZymouu5a4rD315UeWdKZ8AAkqUIGtNHh05jOQikttMHippHfnQkxtFfhry7z8thqkWG2Mw1wAAAABJRU5ErkJggg==" },
  { name: "grayscale 4-bit", width: 10, height: 6, colorType: 0, bitDepth: 4, interlace: 0, rgbaHash: 4058708851, b64: "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAGBAAAAAAaa70bAAAAI0lEQVR4nGNgVHZN72QQMgmrmMUAYq5mADH3MICYZxlAzHsAwIENEvr04DcAAAAASUVORK5CYII=" },
  { name: "RGBA 8-bit", width: 9, height: 9, colorType: 6, bitDepth: 8, interlace: 0, rgbaHash: 38021077, b64: "iVBORw0KGgoAAAANSUhEUgAAAAkAAAAJCAYAAADgkQYQAAAAsUlEQVR4nBXMQREAMQgEwYhABCLyWAmIQESeIwARON2rawF9zkFxcB50D66D+uB30By8B50TOAJl4BuoAnegF3gCbeBzEkXiTHQTV6JO/BJN4s1/ujguyovvRXVxX/Qunov2/lOhKJyFbuEq1IVfoSm89U+No1E2vo2qcTd6jafR9j89FA/nQ/fheqgffg/Nw/v+aXAMysF3UA3uQW/wDNr5p0WxOBfdxbWoF79Fs3gXffCxjTkcv/vbAAAAAElFTkSuQmCC" },
  { name: "palette 2-bit interlaced", width: 12, height: 8, colorType: 3, bitDepth: 2, interlace: 1, rgbaHash: 489907717, b64: "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAIAgMAAAHHjcb0AAAADFBMVEX/AAAA/wAAAP8oKCilCFfsAAAAAnRSTlP/gAgPs2oAAAAbSURBVHicY2AAgxUMKxiUFECovACBNm7ciIwB0UANvdf0T2IAAAAASUVORK5CYII=" },
]

// Portable base64 → bytes (works under Node and the browser without atob/Buffer).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export function base64ToBytes(s: string): Uint8Array {
  const lut = new Int16Array(256).fill(-1)
  for (let i = 0; i < B64.length; i++) lut[B64.charCodeAt(i)] = i
  let clean = ''
  for (const ch of s) if (ch !== '=' && lut[ch.charCodeAt(0)] >= 0) clean += ch
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8))
  let acc = 0, bits = 0, o = 0
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | lut[clean.charCodeAt(i)]
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, o)
}

/** FNV-1a (32-bit) — the same hash the vectors were frozen with. */
export function fnv1a(b: Uint8Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < b.length; i++) {
    h ^= b[i]
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
