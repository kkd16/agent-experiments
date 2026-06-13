// Bundled example programs. Each is real RV32IM assembly that assembles and runs in the
// in-app verification suite, so they double as living documentation and regression tests.

export interface Example {
  id: string;
  title: string;
  blurb: string;
  /** Which output panel best shows the result. */
  focus: 'console' | 'framebuffer';
  code: string;
}

const HELLO = `# Print a string with the print_string syscall (a7 = 4).
.data
msg:    .string "Hello, RISC-V! Welcome to the studio.\\n"
.text
main:
        la   a0, msg          # a0 = address of the string
        li   a7, 4            # syscall 4 = print_string
        ecall
        li   a7, 10           # syscall 10 = exit
        ecall
`;

const FIB = `# Print the first 15 Fibonacci numbers, space-separated.
.data
sep:    .string " "
.text
main:
        li   s0, 0            # a = fib(0)
        li   s1, 1            # b = fib(1)
        li   s2, 15           # how many to print
        li   s3, 0            # i = 0
loop:
        bge  s3, s2, done
        mv   a0, s0
        li   a7, 1            # print_int(a)
        ecall
        la   a0, sep
        li   a7, 4            # print " "
        ecall
        add  t0, s0, s1      # next = a + b
        mv   s0, s1
        mv   s1, t0
        addi s3, s3, 1
        j    loop
done:
        li   a7, 10
        ecall
`;

const GCD = `# Euclid's algorithm via a recursive-style tail loop and the M-extension 'rem'.
.text
main:
        li   a0, 1071
        li   a1, 462
        call gcd             # a0 = gcd(1071, 462) = 21
        li   a7, 1
        ecall                # print the answer
        li   a7, 10
        ecall

# gcd(a0, a1) -> a0
gcd:
        beqz a1, gcd_done
        rem  t0, a0, a1      # t0 = a0 % a1   (RV32M)
        mv   a0, a1
        mv   a1, t0
        j    gcd
gcd_done:
        ret
`;

const BUBBLE = `# Bubble-sort an array in .data, then print it ascending.
.data
arr:    .word 5, 2, 9, 1, 7, 3, 8, 4, 6, 0
count:  .word 10
.text
main:
        la   s0, arr
        la   t0, count
        lw   s1, 0(t0)       # n
        li   s2, 0           # i = 0
outer:
        addi t3, s1, -1
        bge  s2, t3, print   # i >= n-1  ->  sorted
        li   s3, 0           # j = 0
inner:
        sub  t4, t3, s2      # (n-1-i)
        bge  s3, t4, outer_next
        slli t5, s3, 2       # j * 4
        add  t6, s0, t5      # &arr[j]
        lw   a0, 0(t6)
        lw   a1, 4(t6)
        ble  a0, a1, no_swap
        sw   a1, 0(t6)       # swap
        sw   a0, 4(t6)
no_swap:
        addi s3, s3, 1
        j    inner
outer_next:
        addi s2, s2, 1
        j    outer
print:
        li   s3, 0
ploop:
        bge  s3, s1, pdone
        slli t5, s3, 2
        add  t6, s0, t5
        lw   a0, 0(t6)
        li   a7, 1
        ecall                # print_int
        li   a0, ' '
        li   a7, 11
        ecall                # print_char ' '
        addi s3, s3, 1
        j    ploop
pdone:
        li   a7, 10
        ecall
`;

const REVERSE = `# Reverse a string in place (well, print it backwards char by char).
.data
msg:    .string "racecar reversed is still neat"
.text
main:
        la   s0, msg
        mv   t0, s0
len:
        lb   t1, 0(t0)       # find the NUL terminator
        beqz t1, gotlen
        addi t0, t0, 1
        j    len
gotlen:
        addi t0, t0, -1      # last character
rev:
        blt  t0, s0, done
        lb   a0, 0(t0)
        li   a7, 11
        ecall                # print_char
        addi t0, t0, -1
        j    rev
done:
        li   a7, 10
        ecall
`;

const MULDIV = `# RV32M showcase: multiply, signed/unsigned divide and remainder.
.data
nl:     .string "\\n"
.text
main:
        li   a0, 123456
        li   a1, 789
        mul  a0, a0, a1      # 123456 * 789
        li   a7, 1
        ecall
        call newline

        li   a0, 1000000
        li   a1, 7
        div  a2, a0, a1      # quotient
        rem  a3, a0, a1      # remainder
        mv   a0, a2
        li   a7, 1
        ecall
        li   a0, ' '
        li   a7, 11
        ecall
        mv   a0, a3
        li   a7, 1
        ecall
        call newline

        li   a7, 10
        ecall
newline:
        la   a0, nl
        li   a7, 4
        ecall
        ret
`;

const MANDELBROT = `# Fixed-point Mandelbrot set rendered to the 128x128 memory-mapped framebuffer.
# All maths is Q12 fixed point (1.0 == 4096) — no floating point on RV32I!
.equ FB,     0x20000000      # framebuffer base
.equ W,      128
.equ H,      128
.equ XMIN,   -10240          # -2.5  in Q12
.equ STEPX,  112             #  3.5/128 in Q12
.equ YMIN,   -6144           # -1.5  in Q12
.equ STEPY,  96              #  3.0/128 in Q12
.equ ESCAPE, 16384           #  4.0   in Q12
.equ MAXIT,  32
.text
main:
        li   s0, FB
        li   s8, MAXIT
        li   s1, 0           # py
        li   s3, YMIN        # cy
row:
        li   t6, H
        bge  s1, t6, fbdone
        li   s2, 0           # px
        li   s4, XMIN        # cx
col:
        li   t6, W
        bge  s2, t6, nextrow
        li   s5, 0           # zx
        li   s6, 0           # zy
        li   s7, 0           # iter
iter:
        mul  t0, s5, s5
        srai t0, t0, 12      # zx^2  (Q12)
        mul  t1, s6, s6
        srai t1, t1, 12      # zy^2
        add  t2, t0, t1
        li   t3, ESCAPE
        bge  t2, t3, plot    # |z|^2 > 4 -> escaped
        bge  s7, s8, plot    # reached iteration cap (inside the set)
        mul  t4, s5, s6
        srai t4, t4, 12      # zx*zy
        slli t4, t4, 1       # 2*zx*zy
        add  s6, t4, s3      # zy = 2*zx*zy + cy
        sub  t5, t0, t1      # zx^2 - zy^2
        add  s5, t5, s4      # zx = zx^2 - zy^2 + cx
        addi s7, s7, 1
        j    iter
plot:
        andi t0, s7, 15      # palette index from iteration count
        slli t1, s1, 7       # py * 128
        add  t1, t1, s2      # + px
        add  t1, t1, s0      # + framebuffer base
        sb   t0, 0(t1)
        addi s2, s2, 1
        addi s4, s4, STEPX
        j    col
nextrow:
        addi s1, s1, 1
        addi s3, s3, STEPY
        j    row
fbdone:
        li   a7, 10
        ecall
`;

const RINGS = `# Concentric colour rings on the framebuffer — a quick MMIO/graphics demo.
.equ FB, 0x20000000
.text
main:
        li   s0, FB
        li   s1, 0           # py
row:
        li   t0, 128
        bge  s1, t0, done
        li   s2, 0           # px
col:
        li   t0, 128
        bge  s2, t0, nextrow
        addi t1, s2, -64     # dx
        addi t2, s1, -64     # dy
        mul  t3, t1, t1
        mul  t4, t2, t2
        add  t3, t3, t4      # dx^2 + dy^2
        srai t3, t3, 5
        andi t3, t3, 15      # ring colour
        slli t5, s1, 7
        add  t5, t5, s2
        add  t5, t5, s0
        sb   t3, 0(t5)
        addi s2, s2, 1
        j    col
nextrow:
        addi s1, s1, 1
        j    row
done:
        li   a7, 10
        ecall
`;

export const EXAMPLES: readonly Example[] = [
  { id: 'hello', title: 'Hello, RISC-V', blurb: 'print_string syscall basics', focus: 'console', code: HELLO },
  { id: 'fib', title: 'Fibonacci', blurb: 'loops, registers, print_int', focus: 'console', code: FIB },
  { id: 'gcd', title: 'GCD (Euclid)', blurb: 'call/ret + rem (RV32M)', focus: 'console', code: GCD },
  { id: 'bubble', title: 'Bubble sort', blurb: 'arrays, loads/stores, nested loops', focus: 'console', code: BUBBLE },
  { id: 'reverse', title: 'String reverse', blurb: 'byte loads, pointers, branches', focus: 'console', code: REVERSE },
  { id: 'muldiv', title: 'Multiply & divide', blurb: 'the full RV32M extension', focus: 'console', code: MULDIV },
  { id: 'mandelbrot', title: 'Mandelbrot', blurb: 'Q12 fixed-point fractal → framebuffer', focus: 'framebuffer', code: MANDELBROT },
  { id: 'rings', title: 'Colour rings', blurb: 'memory-mapped graphics', focus: 'framebuffer', code: RINGS },
];

export const DEFAULT_EXAMPLE = EXAMPLES[1]; // Fibonacci
