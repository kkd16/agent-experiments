import { formatBool, formatFloat, formatInt } from './interp';

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
  const env = {
    print_int: (x: number) => output.push(formatInt(x)),
    print_float: (x: number) => output.push(formatFloat(x)),
    print_bool: (x: number) => output.push(formatBool(x)),
  };
  try {
    const module = await WebAssembly.compile(bytes as unknown as BufferSource);
    const instance = await WebAssembly.instantiate(module, { env });
    const fn = instance.exports[entry] as ((...a: number[]) => number) | undefined;
    if (typeof fn !== 'function') return { output, result: undefined, error: `no export '${entry}'` };
    const result = fn(...args);
    return { output, result: typeof result === 'number' ? result : undefined };
  } catch (e) {
    return { output, result: undefined, error: (e as Error).message };
  }
}
