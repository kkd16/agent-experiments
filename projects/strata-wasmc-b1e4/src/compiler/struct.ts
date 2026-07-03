import type { Program, Ty } from './ast';

// Struct memory layout. A struct value is an i32 handle to a block in linear
// memory; its fields are packed at fixed byte offsets, each naturally aligned
// (4-byte fields on a 4-byte boundary, 8-byte `long`/`float` fields on an 8-byte
// boundary), and the whole record is padded up to an 8-byte multiple so the bump
// allocator stays 8-aligned. The wasm backend loads/stores fields at these
// offsets; the interpreter keeps the same fields in a by-reference object, so the
// two never have to agree on an address — only on observable values.

export type FieldIRType = 'i32' | 'i64' | 'f64' | 'f32';

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

/** A field's wasm value type: 8-byte `long`/`float`, 4-byte `f32`, otherwise a
 * 4-byte i32 (ints, bools, string pointers, array handles and nested struct
 * handles). */
export function fieldIRType(t: Ty): FieldIRType {
  if (t.kind === 'float') return 'f64';
  if (t.kind === 'f32') return 'f32';
  if (t.kind === 'long') return 'i64';
  return 'i32';
}

const sizeOf = (t: FieldIRType): number => (t === 'i32' || t === 'f32' ? 4 : 8);
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

// --- enum (tagged-union) layout ---------------------------------------------
// An enum value is an i32 handle to a block laid out as { i32 tag @0, payload }.
// The payload starts at offset 8 (ENUM_HEADER) so it is 8-byte aligned — every
// payload field then sits at its natural offset within the record, exactly like
// a struct field. A construction allocates only its own variant's size (the tag
// guards a match from ever reading a value as the wrong variant), so a nullary
// variant is a bare 8-byte tag word.

/** Byte offset of an enum value's payload (after the tag word). */
export const ENUM_HEADER = 8;

export interface VariantLayout {
  name: string;
  /** discriminant stored in the header word */
  tag: number;
  /** payload fields at their (header-relative) byte offsets */
  fields: FieldLayout[];
  byIndex: FieldLayout[];
  /** total allocation size for a value of this variant (8-byte aligned) */
  size: number;
}

export interface EnumLayout {
  name: string;
  variants: Map<string, VariantLayout>;
}

export function computeVariantLayout(name: string, tag: number, fieldTys: Ty[]): VariantLayout {
  const out: FieldLayout[] = [];
  let offset = ENUM_HEADER;
  fieldTys.forEach((ty, i) => {
    const irType = fieldIRType(ty);
    const sz = irType === 'i32' || irType === 'f32' ? 4 : 8;
    offset = (offset + sz - 1) & ~(sz - 1);
    out.push({ name: String(i), ty, irType, offset });
    offset += sz;
  });
  const size = Math.max(ENUM_HEADER, (offset + 7) & ~7);
  return { name, tag, fields: out, byIndex: out, size };
}

export function computeEnumLayout(name: string, variants: { name: string; fields: Ty[]; tag: number }[]): EnumLayout {
  const map = new Map<string, VariantLayout>();
  for (const v of variants) map.set(v.name, computeVariantLayout(v.name, v.tag, v.fields));
  return { name, variants: map };
}

/** Build the layout table for every `enum` declaration in a program. */
export function computeEnumLayouts(prog: Program): Map<string, EnumLayout> {
  const enums = new Map<string, EnumLayout>();
  for (const d of prog.decls) {
    if (d.kind === 'enum') enums.set(d.name, computeEnumLayout(d.name, d.variants));
  }
  return enums;
}

/** Flatten all enums to a variant-name → { enum, layout } index (for the IR
 * builder and interpreters, where a call/ident names a variant directly). */
export interface VariantInfo {
  enumName: string;
  layout: VariantLayout;
}
export function variantIndex(enums: Map<string, EnumLayout>): Map<string, VariantInfo> {
  const idx = new Map<string, VariantInfo>();
  for (const [enumName, el] of enums) for (const [vn, vl] of el.variants) idx.set(vn, { enumName, layout: vl });
  return idx;
}
