// The C type universe for the `cc` compiler.
//
// We model exactly the subset the rest of the compiler needs: the integer types
// (`int` = 32-bit, `char` = 8-bit signed), `void`, pointers, arrays, function types,
// and `struct`s. Sizes and alignment follow the RV32 ABI (everything is 4-byte aligned
// except `char`, which is byte-aligned). Type objects are plain data; helpers below build
// and inspect them.

export type TypeKind = 'void' | 'int' | 'char' | 'ptr' | 'array' | 'func' | 'struct';

export interface Member {
  name: string;
  type: CType;
  offset: number;
}

export interface CType {
  kind: TypeKind;
  size: number; // bytes; -1 for incomplete
  align: number;
  // ptr / array element type, or func return type
  base?: CType;
  // array length (-1 = unknown / decayed)
  len?: number;
  // function types
  params?: CType[];
  variadic?: boolean;
  // struct
  tag?: string;
  members?: Member[];
  complete?: boolean;
}

export const tVoid: CType = { kind: 'void', size: 1, align: 1 };
export const tInt: CType = { kind: 'int', size: 4, align: 4 };
export const tChar: CType = { kind: 'char', size: 1, align: 1 };

export function pointerTo(base: CType): CType {
  return { kind: 'ptr', size: 4, align: 4, base };
}

export function arrayOf(base: CType, len: number): CType {
  const elem = base.size < 0 ? 0 : base.size;
  return { kind: 'array', size: elem * len, align: base.align, base, len };
}

export function funcType(ret: CType, params: CType[], variadic = false): CType {
  return { kind: 'func', size: 1, align: 1, base: ret, params, variadic };
}

export function structType(tag: string | undefined): CType {
  return { kind: 'struct', size: -1, align: 1, tag, members: [], complete: false };
}

/** Fill in a struct's members + final size/alignment (C layout rules). */
export function layoutStruct(st: CType, members: { name: string; type: CType }[]): void {
  let offset = 0;
  let align = 1;
  const laid: Member[] = [];
  for (const m of members) {
    const a = m.type.align;
    offset = alignUp(offset, a);
    laid.push({ name: m.name, type: m.type, offset });
    offset += m.type.size;
    if (a > align) align = a;
  }
  st.members = laid;
  st.align = align;
  st.size = alignUp(offset, align);
  st.complete = true;
}

export function alignUp(n: number, a: number): number {
  return Math.floor((n + a - 1) / a) * a;
}

export function isInteger(t: CType): boolean {
  return t.kind === 'int' || t.kind === 'char';
}

export function isPointer(t: CType): boolean {
  return t.kind === 'ptr';
}

export function isPointerLike(t: CType): boolean {
  return t.kind === 'ptr' || t.kind === 'array';
}

export function isScalar(t: CType): boolean {
  return isInteger(t) || t.kind === 'ptr';
}

export function isVoid(t: CType): boolean {
  return t.kind === 'void';
}

/** The element type a pointer/array points at (or void if not pointer-like). */
export function elementOf(t: CType): CType {
  return t.base ?? tVoid;
}

/** Array types decay to a pointer to their element in most expression contexts. */
export function decay(t: CType): CType {
  if (t.kind === 'array') return pointerTo(t.base!);
  if (t.kind === 'func') return pointerTo(t);
  return t;
}

export function sameType(a: CType, b: CType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'ptr':
      return sameType(a.base!, b.base!);
    case 'array':
      return a.len === b.len && sameType(a.base!, b.base!);
    case 'struct':
      return a === b || (!!a.tag && a.tag === b.tag);
    case 'func':
      return sameType(a.base!, b.base!);
    default:
      return true;
  }
}

export function typeName(t: CType): string {
  switch (t.kind) {
    case 'void':
      return 'void';
    case 'int':
      return 'int';
    case 'char':
      return 'char';
    case 'ptr':
      return `${typeName(t.base!)}*`;
    case 'array':
      return `${typeName(t.base!)}[${t.len}]`;
    case 'struct':
      return `struct ${t.tag ?? '<anon>'}`;
    case 'func':
      return `${typeName(t.base!)}(${(t.params ?? []).map(typeName).join(', ')}${t.variadic ? ', ...' : ''})`;
  }
}
