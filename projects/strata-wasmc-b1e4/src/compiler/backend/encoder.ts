// A minimal WebAssembly binary encoder: LEB128 integers, length-prefixed
// vectors, and the section framing needed to assemble a complete `.wasm` module.

export class ByteWriter {
  bytes: number[] = [];

  u8(b: number): void {
    this.bytes.push(b & 0xff);
  }
  raw(bs: number[]): void {
    for (const b of bs) this.bytes.push(b & 0xff);
  }
  /** Unsigned LEB128 (used for counts, indices, alignment). */
  u32(value: number): void {
    let v = value >>> 0;
    do {
      let byte = v & 0x7f;
      v >>>= 7;
      if (v !== 0) byte |= 0x80;
      this.bytes.push(byte);
    } while (v !== 0);
  }
  /** Signed LEB128 (used for i32.const). */
  i32(value: number): void {
    let v = value | 0;
    for (;;) {
      const byte = v & 0x7f;
      v >>= 7;
      const signBit = byte & 0x40;
      if ((v === 0 && !signBit) || (v === -1 && signBit)) {
        this.bytes.push(byte);
        break;
      }
      this.bytes.push(byte | 0x80);
    }
  }
  /** Signed LEB128 of a 64-bit BigInt (used for i64.const). */
  i64(value: bigint): void {
    let v = BigInt.asIntN(64, value);
    for (;;) {
      const byte = Number(v & 0x7fn);
      v >>= 7n;
      const signBit = byte & 0x40;
      if ((v === 0n && !signBit) || (v === -1n && signBit)) {
        this.bytes.push(byte);
        break;
      }
      this.bytes.push(byte | 0x80);
    }
  }
  f64(value: number): void {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, value, true);
    const arr = new Uint8Array(buf);
    for (let i = 0; i < 8; i++) this.bytes.push(arr[i]);
  }
  f32(value: number): void {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, value, true);
    const arr = new Uint8Array(buf);
    for (let i = 0; i < 4; i++) this.bytes.push(arr[i]);
  }
  name(s: string): void {
    const utf8 = new TextEncoder().encode(s);
    this.u32(utf8.length);
    for (const b of utf8) this.bytes.push(b);
  }
}

/** Encode a vector: count followed by each element's bytes. */
export function vec(items: number[][]): number[] {
  const w = new ByteWriter();
  w.u32(items.length);
  for (const it of items) w.raw(it);
  return w.bytes;
}

/** Frame a section: id, byte-length, content. */
export function section(id: number, content: number[]): number[] {
  const w = new ByteWriter();
  w.u8(id);
  w.u32(content.length);
  w.raw(content);
  return w.bytes;
}

export const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
export const WASM_VERSION = [0x01, 0x00, 0x00, 0x00];

// Value types.
export const VT_I32 = 0x7f;
export const VT_I64 = 0x7e;
export const VT_F64 = 0x7c;
export const VT_F32 = 0x7d;
