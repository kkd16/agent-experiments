import type { Program, Ty } from './ast';

// Struct memory layout. A struct value is an i32 handle to a block in linear
// memory; its fields are packed at fixed byte offsets, each naturally aligned
// (4-byte fields on a 4-byte boundary, 8-byte `long`/`float` fields on an 8-byte
// boundary), and the whole record is padded up to an 8-byte multiple so the bump
// allocator stays 8-aligned. The wasm backend loads/stores fields at these
// offsets; the interpreter keeps the same fields in a by-reference object, so the
// two never have to agree on an address — only on observable values.

export type FieldIRType = 'i32' | 'i64' | 'f64';

export interface FieldLayout {
  name: string;
  ty: Ty;
  irType: FieldIRType;
  /** byte offset of this field from the struct handle */
  offset: number;
}

export interface StructLayout {
  name: string;
  fields: FieldLayout[];
  /** total allocation size in bytes (8-byte aligned) */
  size: number;
  byName: Map<string, FieldLayout>;
}

/** A field's wasm value type: 8-byte `long`/`float`, otherwise a 4-byte i32
 * (ints, bools, string pointers, array handles and nested struct handles). */
export function fieldIRType(t: Ty): FieldIRType {
  if (t.kind === 'float') return 'f64';
  if (t.kind === 'long') return 'i64';
  return 'i32';
}

const sizeOf = (t: FieldIRType): number => (t === 'i32' ? 4 : 8);
const alignUp = (n: number, a: number): number => (n + a - 1) & ~(a - 1);

export function computeLayout(name: string, fields: { name: string; ty: Ty }[]): StructLayout {
  const out: FieldLayout[] = [];
  let offset = 0;
  for (const f of fields) {
    const irType = fieldIRType(f.ty);
    const sz = sizeOf(irType);
    offset = alignUp(offset, sz);
    out.push({ name: f.name, ty: f.ty, irType, offset });
    offset += sz;
  }
  const size = Math.max(8, alignUp(offset, 8)); // never allocate a zero-byte block
  const byName = new Map(out.map((f) => [f.name, f]));
  return { name, fields: out, size, byName };
}

/** Build the layout table for every `struct` declaration in a program. */
export function computeLayouts(prog: Program): Map<string, StructLayout> {
  const layouts = new Map<string, StructLayout>();
  for (const d of prog.decls) {
    if (d.kind === 'struct') layouts.set(d.name, computeLayout(d.name, d.fields));
  }
  return layouts;
}
