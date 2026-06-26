// Curated inputs for the Optimizer tab, each chosen to make a particular transformation obvious.

export interface OptDemo {
  id: string;
  title: string;
  mode: 'c' | 'asm';
  code: string;
}

export const OPT_DEMOS: OptDemo[] = [
  {
    id: 'arith',
    title: 'C — constant folding & strength reduction',
    mode: 'c',
    code: `// The naive back end materialises and spills every subexpression.
// Forge folds the constants, turns × and % by powers of two into
// shifts and masks, and recovers tight code.
int main() {
  int a = 2 + 3 * 4;        // folds to 14
  int b = a * 8;            // becomes a shift
  int c = (a * 16) / 4;     // shifts both ways
  int d = b % 8;            // becomes a mask
  return a + b + c + d;
}
`,
  },
  {
    id: 'spills',
    title: 'C — stack-spill elimination',
    mode: 'c',
    code: `// Every binary operator in the stack machine pushes its left
// operand to memory and pops it back. Forge proves those temporaries
// private, forwards the pops, and deletes the dead spill stores —
// the loads never touch memory.
int poly(int x) {
  return ((x + 1) * (x + 2) * (x + 3)) - (x * x);
}
int main() {
  int s = 0;
  for (int i = 0; i < 6; i++) s = s + poly(i);
  return s;
}
`,
  },
  {
    id: 'dce',
    title: 'C — dead code & copy elimination',
    mode: 'c',
    code: `// Dead computations and chains of copies vanish; identical
// subexpressions are computed once.
int main() {
  int x = 10;
  int unused = x * x * x;     // never observed → removed
  int a = x + 7;
  int b = x + 7;              // same value → reused
  int c = a;                  // copy chain collapses
  return c + b;
}
`,
  },
  {
    id: 'branch',
    title: 'C — constant branch folding',
    mode: 'c',
    code: `// A condition the compiler can prove constant collapses to the
// taken arm; the dead arm and its block disappear.
int main() {
  int n = 5;
  int total = 0;
  for (int i = 0; i < n; i++) {
    if (2 < 3) total += i;    // always true
    else total -= i;          // dead arm → gone
  }
  return total;
}
`,
  },
  {
    id: 'asm',
    title: 'Assembly — paste your own',
    mode: 'asm',
    code: `# Hand-written RV32 assembly is optimized too. Forge folds the
# address computation into the load, propagates the constant, and
# rematerialises the pushed value instead of round-tripping memory.
.text
main:
        addi t0, gp, 16
        lw   a0, 0(t0)
        li   t1, 5
        addi sp, sp, -4
        sw   t1, 0(sp)
        lw   t2, 0(sp)
        addi sp, sp, 4
        add  a0, a0, t2
        li   a7, 1
        ecall              # print_int
        li   a7, 93
        li   a0, 0
        ecall              # exit
`,
  },
];

export const DEFAULT_OPT_DEMO = OPT_DEMOS[1]; // the stack-spill demo shows the headline win
