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

const FLOAT_NEWTON = `# Newton's method for sqrt(2) in RV32F single precision.
#   x_{n+1} = 0.5 * (x_n + S / x_n)
.text
main:
        li   t0, 2
        fcvt.s.w fs0, t0         # S = 2.0
        fmv.s    fa0, fs0        # x = 2.0  (initial guess)
        li   t0, 0x3f000000
        fmv.w.x  fs1, t0         # 0.5 (bit pattern)
        li   s2, 10              # iterations
loop:
        beqz s2, done
        fdiv.s ft0, fs0, fa0     # S / x
        fadd.s ft0, fa0, ft0     # x + S/x
        fmul.s fa0, ft0, fs1     # * 0.5
        addi s2, s2, -1
        j    loop
done:
        li   a7, 2               # print_float(fa0)  ->  1.414214
        ecall
        li   a7, 10
        ecall
`;

const LEIBNIZ = `# Approximate pi with the Leibniz series, accumulated in single precision.
#   pi/4 = 1 - 1/3 + 1/5 - 1/7 + ...
.text
main:
        li   t0, 0
        fcvt.s.w fs0, t0         # sum   = 0.0
        li   t0, 1
        fcvt.s.w fs1, t0         # sign  = +1.0
        fcvt.s.w fs2, t0         # denom = 1.0
        li   t0, 2
        fcvt.s.w fs3, t0         # two   = 2.0
        li   s4, 200000          # number of terms
term:
        beqz s4, finish
        fdiv.s ft0, fs1, fs2     # sign / denom
        fadd.s fs0, fs0, ft0     # sum += term
        fneg.s fs1, fs1          # flip the sign
        fadd.s fs2, fs2, fs3     # denom += 2
        addi s4, s4, -1
        j    term
finish:
        li   t0, 4
        fcvt.s.w ft1, t0
        fmul.s fa0, fs0, ft1     # pi ≈ 4 * sum
        li   a7, 2
        ecall
        li   a7, 10
        ecall
`;

const DOTPROD = `# Dot product of two float vectors using the fused multiply-add (fmadd.s).
.data
# 1,2,3,4  and  5,6,7,8  as IEEE-754 single-precision bit patterns
va:     .word 0x3f800000, 0x40000000, 0x40400000, 0x40800000
vb:     .word 0x40a00000, 0x40c00000, 0x40e00000, 0x41000000
.text
main:
        la   s0, va
        la   s1, vb
        li   s2, 4
        li   t0, 0
        fcvt.s.w fs0, t0         # acc = 0.0
loop:
        beqz s2, done
        flw  ft0, 0(s0)
        flw  ft1, 0(s1)
        fmadd.s fs0, ft0, ft1, fs0   # acc = a*b + acc  (single rounding)
        addi s0, s0, 4
        addi s1, s1, 4
        addi s2, s2, -1
        j    loop
done:
        fcvt.w.s a0, fs0         # 5+12+21+32 = 70
        li   a7, 1
        ecall
        li   a7, 10
        ecall
`;

const MANDEL_FLOAT = `# Mandelbrot set in real RV32F floating point → the 128x128 framebuffer.
.equ FB, 0x20000000
.text
main:
        li   s0, FB
        li   s8, 64              # max iterations
        li   t0, 128
        fcvt.s.w fs5, t0         # 128.0
        li   t0, 35
        fcvt.s.w ft0, t0
        li   t0, 10
        fcvt.s.w ft1, t0
        fdiv.s ft0, ft0, ft1     # 3.5
        fdiv.s fs0, ft0, fs5     # dx = 3.5 / 128
        li   t0, 3
        fcvt.s.w ft0, t0
        fdiv.s fs1, ft0, fs5     # dy = 3.0 / 128
        li   t0, -5
        fcvt.s.w ft0, t0
        li   t0, 2
        fcvt.s.w ft1, t0
        fdiv.s fs2, ft0, ft1     # xmin = -2.5
        li   t0, -3
        fcvt.s.w ft0, t0
        fdiv.s fs3, ft0, ft1     # ymin = -1.5
        li   t0, 4
        fcvt.s.w fs4, t0         # 4.0  (escape radius squared)

        li   s1, 0               # py
        fmv.s fa1, fs3           # cy = ymin
row:
        li   t0, 128
        bge  s1, t0, fbdone
        li   s2, 0               # px
        fmv.s fa0, fs2           # cx = xmin
col:
        li   t0, 128
        bge  s2, t0, nextrow
        li   t0, 0
        fcvt.s.w ft2, t0         # zx = 0
        fcvt.s.w ft3, t0         # zy = 0
        li   s7, 0               # iter
iter:
        fmul.s ft4, ft2, ft2     # zx^2
        fmul.s ft5, ft3, ft3     # zy^2
        fadd.s ft6, ft4, ft5     # |z|^2
        flt.s  t1, fs4, ft6      # 4.0 < |z|^2  ->  escaped
        bnez t1, plot
        bge  s7, s8, plot
        fmul.s ft7, ft2, ft3     # zx*zy
        fadd.s ft7, ft7, ft7     # 2*zx*zy
        fadd.s ft3, ft7, fa1     # zy = 2*zx*zy + cy
        fsub.s ft4, ft4, ft5     # zx^2 - zy^2
        fadd.s ft2, ft4, fa0     # zx = zx^2 - zy^2 + cx
        addi s7, s7, 1
        j    iter
plot:
        andi t0, s7, 15
        slli t1, s1, 7
        add  t1, t1, s2
        add  t1, t1, s0
        sb   t0, 0(t1)
        addi s2, s2, 1
        fadd.s fa0, fa0, fs0     # cx += dx
        j    col
nextrow:
        addi s1, s1, 1
        fadd.s fa1, fa1, fs1     # cy += dy
        j    row
fbdone:
        li   a7, 10
        ecall
`;

const ATOMIC = `# RV32A atomics: 100 amoadd.w increments of a shared counter.
.data
counter: .word 0
.text
main:
        la   s0, counter
        li   s1, 0               # i
        li   s2, 100
loop:
        bge  s1, s2, done
        li   t0, 1
        amoadd.w zero, t0, (s0)  # counter += 1 (atomic read-modify-write)
        addi s1, s1, 1
        j    loop
done:
        lw   a0, 0(s0)           # 100
        li   a7, 1
        ecall
        li   a7, 10
        ecall
`;

const COUNTERS = `# Zicsr hardware counters: time a loop with rdcycle.
.text
main:
        rdcycle s0               # snapshot the cycle counter
        li   t0, 0               # acc
        li   t1, 1               # i
        li   t2, 1001
sum:
        bge  t1, t2, sdone
        add  t0, t0, t1
        addi t1, t1, 1
        j    sum
sdone:
        rdcycle s1               # snapshot again
        sub  a0, s1, s0          # cycles elapsed in the loop
        li   a7, 1
        ecall                    # print the cycle count
        li   a0, ' '
        li   a7, 11
        ecall
        mv   a0, t0              # the sum 1..1000 = 500500
        li   a7, 1
        ecall
        li   a7, 10
        ecall
`;

const RVC = `# RV32C — the compressed (16-bit) extension.
#
# Two ways to get compressed code: write c.* mnemonics by hand (as below), or let the
# assembler shrink eligible base instructions for you. The ".option rvc" directive (or the
# "Compress (RVC)" toolbar toggle) turns that on — open the Disassembly tab and watch the
# addresses step by 2, and the words shrink to 16 bits, with identical behaviour.
.option rvc
.data
msg:    .string "sum 1..20 = "
.text
main:
        la    a0, msg
        li    a7, 4            # print_string
        ecall
        c.li  a0, 0            # acc  (hand-written compressed: c.li)
        c.li  t0, 1            # i
loop:
        c.add a0, t0           # acc += i        (c.add)
        c.addi t0, 1           # i++             (c.addi)
        li    t1, 21
        blt   t0, t1, loop     # this 32-bit branch interleaves freely with 16-bit ops
        li    a7, 1
        ecall                  # print 210
        li    a7, 10
        ecall
`;

const TIMER_IRQ = `# Machine-mode timer interrupts via the CLINT.
#
# Install a handler in mtvec, program the timer (mtimecmp = mtime + INTERVAL), enable the
# timer interrupt (mie.MTIE) and interrupts globally (mstatus.MIE), then sit in a wfi loop.
# Each time mtime reaches mtimecmp the handler fires, bumps a counter, reschedules the next
# tick, and returns with mret. After five ticks we disable interrupts and print the count.
.equ MTIMECMP, 0x02004000      # CLINT timer-compare (low word)
.equ MTIME,    0x0200bff8      # CLINT time (low word)
.equ INTERVAL, 40

.text
main:
        la    t0, on_timer
        csrw  mtvec, t0          # install the trap vector (direct mode)
        li    s0, 0              # tick counter
        li    s1, 5              # stop after 5 ticks
        li    s2, MTIMECMP
        li    s3, MTIME

        lw    t0, 0(s3)          # read mtime
        addi  t0, t0, INTERVAL
        sw    t0, 0(s2)          # mtimecmp = mtime + INTERVAL

        li    t0, 0x80           # mie.MTIE (bit 7)
        csrs  mie, t0
        csrsi mstatus, 0x8       # mstatus.MIE (bit 3) — interrupts on
loop:
        bge   s0, s1, done
        wfi                      # wait for the next timer interrupt
        j     loop
done:
        csrci mstatus, 0x8       # interrupts off before using the console
        mv    a0, s0
        li    a7, 1
        ecall                    # print 5
        li    a0, 10
        li    a7, 11
        ecall                    # newline
        li    a7, 10
        ecall                    # exit

# Timer interrupt handler. Only clobbers t0 (dead in the wfi loop), so no save/restore.
        .align 2
on_timer:
        addi  s0, s0, 1          # one more tick
        lw    t0, 0(s2)
        addi  t0, t0, INTERVAL
        sw    t0, 0(s2)          # schedule the next tick
        mret                     # return to the interrupted pc (mepc)
`;

const PAGING = `# Sv32 VIRTUAL MEMORY, by hand. Build a two-level page table, turn on paging, drop into
# SUPERVISOR mode, read memory through an ALIASED mapping, then deliberately touch an
# unmapped page and let the S-mode page-fault handler catch it and report the address.
#
# Physical layout (paging is OFF while we are in M-mode, so these writes hit RAM directly):
#   0x80000  root page table        0x81000  leaf page table        0x10000  a data frame
.text
main:
        li   t0, 0x80000          # root page table (physical), page 0x80
        li   t1, 0x81000          # leaf page table (physical), page 0x81

        # root[0] = a 4 MiB MEGAPAGE identity-mapping VA [0,4MiB) -> PA [0,4MiB).
        #   ppn=0, flags = D|A|X|W|R|V = 0xcf
        li   t2, 0xcf
        sw   t2, 0(t0)

        # root[2] = a POINTER to the leaf table (covers VA [8MiB,12MiB)).
        #   PTE = (leafPPN 0x81)<<10 | V = 0x20401
        li   t2, 0x20401
        sw   t2, 8(t0)

        # leaf[0] = a 4 KiB page mapping VA 0x00800000 -> PA 0x00010000.
        #   PTE = (ppn 0x10)<<10 | D|A|W|R|V (0xc3) = 0x40c3
        li   t2, 0x40c3
        sw   t2, 0(t1)

        # Stash a sentinel at PA 0x00010000 (reachable now via its identity address).
        li   t3, 0x10000
        li   t4, 0xbeef
        sw   t4, 0(t3)

        # Delegate page faults to S-mode and install the supervisor trap handler.
        li   t2, 0xb000           # medeleg bits 12/13/15 = fetch/load/store page fault
        csrw medeleg, t2
        la   t2, s_handler
        csrw stvec, t2

        # Turn on Sv32:  satp = MODE(1<<31) | rootPPN(0x80)
        li   t2, 0x80000080
        csrw satp, t2
        sfence.vma                # fence the (empty) TLB after changing the regime

        # Prepare to mret into SUPERVISOR mode at \`kernel\`, with a low (mapped) stack.
        li   sp, 0x00200000
        li   t2, 0x1800           # mstatus.MPP mask (bits 12:11)
        csrc mstatus, t2
        li   t2, 0x800            # MPP = 01 (supervisor)
        csrs mstatus, t2
        la   t2, kernel
        csrw mepc, t2
        mret                      # ... drop to S-mode; translation is now LIVE

kernel:
        # Supervisor mode, paging on. Read the ALIAS: VA 0x800000 resolves to PA 0x10000.
        li   t0, 0x800000
        lw   a0, 0(t0)            # loads the sentinel written via the identity map
        li   a7, 34
        ecall                     # print_hex -> 0x0000beef
        li   a0, 10
        li   a7, 11
        ecall                     # newline

        # Now touch an UNMAPPED virtual page: root[3] is invalid -> load page fault.
        li   t0, 0x00c00000
        lw   a0, 0(t0)            # faults here; control vanishes into s_handler
        li   a7, 93
        li   a0, 1
        ecall                     # (not reached)

        .align 2
s_handler:
        # We arrive here in S-mode with scause/stval describing the fault.
        csrr a0, scause
        li   a7, 1
        ecall                     # print_int -> 13 (load page fault)
        li   a0, 58
        li   a7, 11
        ecall                     # ':'
        csrr a0, stval
        li   a7, 34
        ecall                     # print_hex -> the faulting virtual address
        li   a0, 10
        li   a7, 11
        ecall                     # newline
        li   a7, 93
        li   a0, 0
        ecall                     # exit(0)
`;

const BITMANIP = `# The bit-manipulation extension (Zba / Zbb / Zbc / Zbs) — a guided tour.
# Each line prints a label and the result of exactly one new Zb instruction, so you can
# single-step it and watch the dedicated hardware do in one cycle what used to take a loop.
.data
l_pop:  .string "cpop(0xDEADBEEF)   = "      # Zbb population count
l_clz:  .string "clz(0x0000FFFF)    = "      # Zbb count-leading-zeros
l_ctz:  .string "ctz(0x00018000)    = "      # Zbb count-trailing-zeros
l_rev:  .string "rev8(0x11223344)   = "      # Zbb byte-reverse (endianness swap)
l_rot:  .string "ror(0x12345678, 8) = "      # Zbb rotate-right
l_max:  .string "max(-7, 42)        = "      # Zbb signed maximum
l_clm:  .string "clmul(0xD, 0xB)    = "      # Zbc carry-less multiply
nl:     .string "\\n"
.text
main:
        la   a0, l_pop          # --- cpop: how many bits are set ---
        li   a7, 4
        ecall
        li   t0, 0xDEADBEEF
        cpop a0, t0             # = 24
        li   a7, 1
        ecall
        call newline

        la   a0, l_clz          # --- clz: leading zeros ---
        li   a7, 4
        ecall
        li   t0, 0x0000FFFF
        clz  a0, t0             # = 16
        li   a7, 1
        ecall
        call newline

        la   a0, l_ctz          # --- ctz: trailing zeros ---
        li   a7, 4
        ecall
        li   t0, 0x00018000
        ctz  a0, t0             # = 15
        li   a7, 1
        ecall
        call newline

        la   a0, l_rev          # --- rev8: reverse byte order (hex) ---
        li   a7, 4
        ecall
        li   t0, 0x11223344
        rev8 a0, t0             # = 0x44332211
        li   a7, 34
        ecall
        call newline

        la   a0, l_rot          # --- ror: rotate right by 8 (hex) ---
        li   a7, 4
        ecall
        li   t0, 0x12345678
        li   t1, 8
        ror  a0, t0, t1         # = 0x78123456
        li   a7, 34
        ecall
        call newline

        la   a0, l_max          # --- max: signed maximum ---
        li   a7, 4
        ecall
        li   t0, -7
        li   t1, 42
        max  a0, t0, t1         # = 42
        li   a7, 1
        ecall
        call newline

        la   a0, l_clm          # --- clmul: carry-less (XOR) multiply ---
        li   a7, 4
        ecall
        li   t0, 0xD
        li   t1, 0xB
        clmul a0, t0, t1        # = 127
        li   a7, 1
        ecall
        call newline

        li   a7, 10             # exit
        ecall

newline:                       # print a single '\\n' (preserves ra; no nested calls)
        la   a0, nl
        li   a7, 4
        ecall
        ret
`;

export const EXAMPLES: readonly Example[] = [
  { id: 'hello', title: 'Hello, RISC-V', blurb: 'print_string syscall basics', focus: 'console', code: HELLO },
  { id: 'bitmanip', title: 'Bit manipulation (Zb)', blurb: 'Zba/Zbb/Zbc/Zbs: cpop, clz, rev8, ror, clmul', focus: 'console', code: BITMANIP },
  { id: 'paging', title: 'Virtual memory (Sv32)', blurb: 'page tables, S-mode, a page-fault handler', focus: 'console', code: PAGING },
  { id: 'rvc', title: 'Compressed (RV32C)', blurb: 'c.* 16-bit ops + .option rvc auto-compress', focus: 'console', code: RVC },
  { id: 'timer', title: 'Timer interrupts', blurb: 'CLINT timer + mtvec/mret machine-mode trap', focus: 'console', code: TIMER_IRQ },
  { id: 'fib', title: 'Fibonacci', blurb: 'loops, registers, print_int', focus: 'console', code: FIB },
  { id: 'gcd', title: 'GCD (Euclid)', blurb: 'call/ret + rem (RV32M)', focus: 'console', code: GCD },
  { id: 'bubble', title: 'Bubble sort', blurb: 'arrays, loads/stores, nested loops', focus: 'console', code: BUBBLE },
  { id: 'reverse', title: 'String reverse', blurb: 'byte loads, pointers, branches', focus: 'console', code: REVERSE },
  { id: 'muldiv', title: 'Multiply & divide', blurb: 'the full RV32M extension', focus: 'console', code: MULDIV },
  { id: 'newton', title: 'Newton √2 (float)', blurb: 'RV32F: fdiv/fadd/fmul + print_float', focus: 'console', code: FLOAT_NEWTON },
  { id: 'leibniz', title: 'Leibniz π (float)', blurb: 'RV32F series accumulation', focus: 'console', code: LEIBNIZ },
  { id: 'dotprod', title: 'Float dot product', blurb: 'flw + fused multiply-add (fmadd.s)', focus: 'console', code: DOTPROD },
  { id: 'atomic', title: 'Atomic counter', blurb: 'RV32A amoadd.w read-modify-write', focus: 'console', code: ATOMIC },
  { id: 'counters', title: 'Cycle counter', blurb: 'Zicsr rdcycle hardware counter', focus: 'console', code: COUNTERS },
  { id: 'mandelbrot', title: 'Mandelbrot (fixed)', blurb: 'Q12 fixed-point fractal → framebuffer', focus: 'framebuffer', code: MANDELBROT },
  { id: 'mandelf', title: 'Mandelbrot (float)', blurb: 'RV32F fractal → framebuffer', focus: 'framebuffer', code: MANDEL_FLOAT },
  { id: 'rings', title: 'Colour rings', blurb: 'memory-mapped graphics', focus: 'framebuffer', code: RINGS },
];

export const DEFAULT_EXAMPLE = EXAMPLES[1]; // Fibonacci
