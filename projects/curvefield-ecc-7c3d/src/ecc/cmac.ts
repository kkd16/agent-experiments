// AES-CMAC — the Cipher-based Message Authentication Code (NIST SP 800-38B,
// RFC 4493). The standard way to turn a block cipher into a secure MAC.
//
// Plain CBC-MAC is only secure for fixed-length messages — an attacker who sees
// the MACs of two messages can forge the MAC of their concatenation. CMAC fixes
// this with a one-key derivation trick (OMAC1): from L = E_K(0) derive two
// subkeys K1, K2 by a shift-and-conditional-XOR in GF(2¹²⁸), and XOR the right
// subkey into the final block — K1 if the message filled its last block exactly,
// K2 (with 10* padding) otherwise. That single distinguishing bit is what closes
// the length-extension hole.
//
// CMAC is what AES-CCM (Wi-Fi WPA2, Bluetooth LE, TLS's AES-CCM suites) and
// AES-SIV use as their authenticator, and it is a NIST-approved PRF in its own
// right. Built on this lab's from-scratch `aes.ts` and pinned to RFC 4493's test
// vectors in `selftest.ts`.

import { expandKey, encryptBlock, type AesKey } from './aes'

const Rb = 0x87 // the GF(2¹²⁸) reduction byte for the CMAC subkey shift

/** One left-shift of a 16-byte big-endian value, with the CMAC conditional XOR. */
function shiftSubkey(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(16)
  const msb = input[0] & 0x80
  for (let i = 0; i < 16; i++) {
    out[i] = ((input[i] << 1) | (i < 15 ? input[i + 1] >> 7 : 0)) & 0xff
  }
  if (msb) out[15] ^= Rb
  return out
}

export interface CmacSubkeys {
  L: Uint8Array
  K1: Uint8Array
  K2: Uint8Array
}

/** Derive the CMAC subkeys K1, K2 from the block cipher key (RFC 4493 §2.3). */
export function cmacSubkeys(key: Uint8Array | AesKey): CmacSubkeys {
  const k = 'roundKeys' in key ? key : expandKey(key)
  const L = encryptBlock(k, new Uint8Array(16))
  const K1 = shiftSubkey(L)
  const K2 = shiftSubkey(K1)
  return { L, K1, K2 }
}

function xor16(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = a[i] ^ b[i]
  return out
}

/** AES-CMAC of a message. Returns a 16-byte tag (truncate for shorter tags). */
export function cmac(key: Uint8Array | AesKey, msg: Uint8Array): Uint8Array {
  const k = 'roundKeys' in key ? key : expandKey(key)
  const { K1, K2 } = cmacSubkeys(k)

  const n = Math.max(1, Math.ceil(msg.length / 16))
  const complete = msg.length > 0 && msg.length % 16 === 0

  // last block: whole → ⊕K1; partial/empty → 10* pad then ⊕K2
  let last: Uint8Array = new Uint8Array(16)
  const lastOff = (n - 1) * 16
  if (complete) {
    last.set(msg.subarray(lastOff, lastOff + 16))
    last = xor16(last, K1)
  } else {
    const rem = msg.length - lastOff
    last.set(msg.subarray(lastOff, lastOff + rem))
    last[rem] = 0x80 // the single 1 bit, then zeros
    last = xor16(last, K2)
  }

  let x: Uint8Array = new Uint8Array(16)
  for (let i = 0; i < n - 1; i++) {
    const blk = msg.subarray(i * 16, i * 16 + 16)
    x = encryptBlock(k, xor16(x, blk))
  }
  return encryptBlock(k, xor16(x, last))
}

function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

/** Constant-time CMAC verification. */
export function cmacVerify(key: Uint8Array | AesKey, msg: Uint8Array, tag: Uint8Array): boolean {
  return ctEqual(cmac(key, msg).subarray(0, tag.length), tag)
}
