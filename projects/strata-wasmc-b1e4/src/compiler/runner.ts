import { formatBool, formatFloat, formatInt, formatLong } from './interp';

// Instantiate a compiled module and run an exported function, capturing
// everything it prints. The `print_*` imports route through the same formatters
// the reference interpreter uses, so the two are directly comparable.

export interface RunResult {
  output: string[];
  result: number | undefined;
  error?: string;
}

export async function runWasm(bytes: Uint8Array, entry = 'main', args: number[] = []): Promise<RunResult> {
  const output: string[] = [];
  // Set once the instance is live; `print_str` reaches back into linear memory to
  // read a string object [i32 length][bytes…] and decode it (Latin-1, one byte
  // per character — the same byte-string model the interpreter uses).
  let mem: Uint8Array | null = null;
  const readStr = (ptr: number): string => {
    if (!mem) return '';
    const len = mem[ptr] | (mem[ptr + 1] << 8) | (mem[ptr + 2] << 16) | (mem[ptr + 3] << 24);
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(mem[ptr + 8 + i]);
    return s;
  };
  const env = {
    print_int: (x: number) => output.push(formatInt(x)),
    // i64 arrives as a BigInt (WebAssembly's JS-BigInt integration, on by default
    // in every current engine and in Node), so it formats exactly like the oracle.
    print_long: (x: bigint) => output.push(formatLong(x)),
    print_float: (x: number) => output.push(formatFloat(x)),
    print_bool: (x: number) => output.push(formatBool(x)),
    print_str: (ptr: number) => output.push(readStr(ptr)),
  };
  try {
    const module = await WebAssembly.compile(bytes as unknown as BufferSource);
    const instance = await WebAssembly.instantiate(module, { env });
    const memory = instance.exports.memory as WebAssembly.Memory | undefined;
    if (memory) mem = new Uint8Array(memory.buffer);
    const fn = instance.exports[entry] as ((...a: number[]) => number) | undefined;
    if (typeof fn !== 'function') return { output, result: undefined, error: `no export '${entry}'` };
    const result = fn(...args);
    return { output, result: typeof result === 'number' ? result : undefined };
  } catch (e) {
    return { output, result: undefined, error: (e as Error).message };
  }
}
