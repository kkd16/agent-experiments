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

const COMPRESSED = `# RV32C: the same 1..10 sum, written almost entirely in 16-bit
# compressed instructions. Open the Disassembly tab to see each 'c.*' op take
# two bytes and expand to its full-width equivalent.
.text
main:
        c.li  t0, 0              # acc   (2 bytes)
        c.li  t1, 1              # i     (2 bytes)
loop:
        li    t2, 11
        bge   t1, t2, done
        c.add t0, t1             # acc += i
        c.addi t1, 1             # i++
        c.j   loop
done:
        c.mv  a0, t0             # a0 = 55
        li    a7, 1
        ecall
        li    a7, 10
        ecall
`;

const TIMER_IRQ = `# Machine-mode timer interrupts (Zicsr + CLINT).
# A free-running timer (mtime) drives periodic interrupts to a handler installed in
# mtvec. The handler counts ticks and re-arms the next deadline; after 8 ticks main exits.
.equ MTIME,    0x0200bff8        # CLINT mtime  (low word)
.equ MTIMECMP, 0x02004000        # CLINT mtimecmp (low word)
.equ PERIOD,   25                # cycles between interrupts
.text
main:
        la   t0, on_timer
        csrw mtvec, t0           # install the trap vector
        li   s0, 0               # tick counter
        li   s1, 8               # stop after 8 ticks
        # arm the first deadline: mtimecmp = mtime + PERIOD
        li   t0, MTIME
        lw   t1, 0(t0)
        addi t1, t1, PERIOD
        li   t2, MTIMECMP
        sw   t1, 0(t2)
        li   t0, 0x80            # mie.MTIE (bit 7)
        csrs mie, t0
        csrsi mstatus, 0x8       # mstatus.MIE (bit 3) — globally enable interrupts
spin:
        blt  s0, s1, spin        # do nothing but wait for interrupts
        mv   a0, s0              # print how many ticks we serviced
        li   a7, 1
        ecall
        li   a7, 10
        ecall

# ---- interrupt handler -------------------------------------------------------
on_timer:
        addi s0, s0, 1           # one more tick
        li   t0, MTIME           # re-arm: mtimecmp = mtime + PERIOD
        lw   t1, 0(t0)
        addi t1, t1, PERIOD
        li   t2, MTIMECMP
        sw   t1, 0(t2)
        mret                     # return to the interrupted pc (mepc)
`;

const DOUBLE_SQRT = `# RV32D: Newton's method for sqrt(2) in DOUBLE precision.
# Single precision (RV32F) only resolves ~7 digits; doubles carry ~15, so this
# prints the full 1.4142135623730951.
.text
main:
        li   t0, 2
        fcvt.d.w fa0, t0         # x  = 2.0   (the radicand)
        li   t0, 1
        fcvt.d.w fs1, t0         # g  = 1.0   (initial guess)
        li   t0, 2
        fcvt.d.w fs2, t0         # two = 2.0  (constant divisor)
        li   t1, 0
        li   t2, 20              # iterations
loop:
        bge  t1, t2, done
        fdiv.d ft0, fa0, fs1     # x / g
        fadd.d ft0, fs1, ft0     # g + x/g
        fdiv.d fs1, ft0, fs2     # g = (g + x/g) / 2
        addi t1, t1, 1
        j    loop
done:
        fmv.d fa0, fs1
        li   a7, 3               # print_double
        ecall
        li   a7, 10
        ecall
`;

const PAGING = `# Supervisor mode + Sv32 virtual memory.
# M-mode builds a two-level page table: identity "megapages" (4 MiB) for code/data/stack,
# plus a remapped 4 KiB page that points VA 0x40000000 at a physical buffer. It enables
# Sv32 paging and 'mret's into S-mode. The supervisor code then uses ordinary syscalls —
# an M-mode trap handler acts as a "supervisor-call gate", forwarding each S-mode ecall to
# the host environment. Open the MMU tab to watch the walk and the TLB.
.equ ROOT, 0x10020000            # root page table   (4 KiB aligned)
.equ L2,   0x10021000            # second-level page table
.equ BUF,  0x10022000            # the physical frame that VA 0x40000000 maps to
.text
main:
        # --- build the page tables (in M-mode, writes go straight to physical memory) ---
        li   t0, ROOT
        li   t1, 0x000000CF      # V R W X A D, leaf → identity megapage vpn1=0   (code)
        sw   t1, 0(t0)
        li   t1, 0x040000CF      #              leaf → identity megapage vpn1=64  (data+tables)
        sw   t1, 256(t0)
        li   t1, 0x1FF000CF      #              leaf → identity megapage vpn1=511 (stack)
        sw   t1, 2044(t0)
        li   t1, 0x04008401      # V only, non-leaf → L2 table  (covers VA 0x40000000)
        sw   t1, 1024(t0)
        li   t0, L2
        li   t1, 0x040088C7      # V R W A D, leaf → BUF  (the remapped 4 KiB page)
        sw   t1, 0(t0)
        # --- turn translation on ---
        li   t0, 0x80010020      # satp = MODE(Sv32) | (ROOT >> 12)
        csrw satp, t0
        sfence.vma
        # --- install the supervisor-call gate and drop into S-mode ---
        la   t0, gate
        csrw mtvec, t0
        csrr t0, mstatus
        li   t1, 0xFFFFE7FF      # MPP <- 0
        and  t0, t0, t1
        li   t1, 0x800           # MPP <- S (01)
        or   t0, t0, t1
        csrw mstatus, t0
        la   t0, smain
        csrw mepc, t0
        mret                     # → S-mode at smain, with virtual memory live

# ---- supervisor code (every address below is virtual) ----------------------
smain:
        la   a0, banner
        li   a7, 4
        ecall                    # a plain syscall — traps to the gate, which forwards it
        li   t0, 0x40000000      # the remapped virtual address...
        li   t1, 0xCAFE
        sw   t1, 0(t0)           # ...store lands in the physical buffer BUF
        la   a0, msg1
        li   a7, 4
        ecall
        li   t0, 0x10022000      # read the buffer back via its identity mapping
        lw   a0, 0(t0)           # same physical frame → 0xCAFE
        li   a7, 34              # print_hex
        ecall
        la   a0, nl
        li   a7, 4
        ecall
        li   a7, 10              # exit (forwarded through the gate, then halts)
        ecall

# ---- the supervisor-call gate (M-mode) --------------------------------------
# An ecall from S-mode is environment-call-from-S (cause 9). We re-issue the same syscall
# in M-mode (where ecall is the host call), then return to just past the S-mode ecall.
gate:
        csrr t6, mcause
        li   t5, 9
        bne  t6, t5, ghalt
        csrr t6, mepc
        addi t6, t6, 4           # resume after the ecall
        csrw mepc, t6
        ecall                    # M-mode ecall = host syscall (halts here if a7 = exit)
        mret
ghalt:
        li   a7, 10
        ecall
.data
banner: .asciz "Supervisor mode + Sv32 paging\\n"
msg1:   .asciz "wrote 0xcafe to VA 0x40000000; read back PA 0x10022000: "
nl:     .asciz "\\n"
`;

const SOFT_IRQ = `# Machine software interrupts (the CLINT msip / self-IPI).
# Writing bit 0 of the memory-mapped 'msip' register raises mip.MSIP — a machine *software*
# interrupt (cause 3), the mechanism a core uses to kick itself or another hart. The handler
# acks it by clearing msip. Here we self-trigger 4 times and count them.
.equ MSIP, 0x02000000            # CLINT msip for hart 0
.text
main:
        la   t0, on_soft
        csrw mtvec, t0           # install the trap vector
        li   t0, 0x8             # mie.MSIE (bit 3) — enable machine software interrupts
        csrs mie, t0
        csrsi mstatus, 0x8       # mstatus.MIE — globally enable interrupts
        li   s0, 0               # count of IPIs serviced
        li   s1, 4               # send 4
loop:
        bge  s0, s1, done
        li   t0, MSIP            # raise a software interrupt to ourselves...
        li   t1, 1
        sw   t1, 0(t0)           # ...mip.MSIP set — taken before the next instruction
        nop                      # (the interrupt preempts here; handler returns to it)
        j    loop
done:
        mv   a0, s0              # print how many we serviced
        li   a7, 1
        ecall
        li   a7, 10
        ecall

# ---- software-interrupt handler ---------------------------------------------
on_soft:
        addi s0, s0, 1           # one more IPI
        li   t0, MSIP
        sw   zero, 0(t0)         # ack: clear msip → mip.MSIP
        mret
`;

const STIMER = `# Preemptive SUPERVISOR timer interrupts (the Sstc extension).
# M-mode delegates the supervisor timer interrupt to S (mideleg bit 5) and drops into S-mode.
# The supervisor arms 'stimecmp' — a compare that drives mip.STIP straight from the timer, with
# no machine-mode mediation — and a periodic S-timer interrupt (cause 5) preempts a busy loop.
.equ PERIOD, 40                  # cycles between ticks
.text
main:                            # --- machine mode ---
        li   t0, 0x20            # mideleg bit 5 (supervisor timer) → handle it in S-mode
        csrw mideleg, t0
        la   t0, gate            # an M-mode gate forwards S-mode ecalls (print/exit)
        csrw mtvec, t0
        csrr t0, mstatus
        li   t1, 0xFFFFE7FF      # MPP <- 0
        and  t0, t0, t1
        li   t1, 0x800           # MPP <- S
        or   t0, t0, t1
        csrw mstatus, t0
        la   t0, smain
        csrw mepc, t0
        mret                     # → S-mode at smain

smain:                          # --- supervisor mode ---
        la   t0, on_stimer
        csrw stvec, t0           # supervisor trap vector
        li   s0, 0               # ticks serviced
        li   s1, 5               # stop after 5
        csrr t0, time            # arm the first deadline: stimecmp = time + PERIOD
        addi t0, t0, PERIOD
        csrw stimecmp, t0
        li   t0, 0x20            # sie.STIE (bit 5)
        csrs sie, t0
        csrsi sstatus, 0x2       # sstatus.SIE (bit 1) — enable S-mode interrupts
spin:
        blt  s0, s1, spin        # do nothing but wait to be preempted
        mv   a0, s0
        li   a7, 1               # print the tick count (traps to the gate)
        ecall
        li   a7, 10
        ecall

# ---- supervisor timer handler (S-mode) --------------------------------------
on_stimer:
        addi s0, s0, 1           # one more tick
        csrr t0, time            # re-arm (writing a future compare also clears STIP)
        addi t0, t0, PERIOD
        csrw stimecmp, t0
        sret                     # return to the interrupted pc (sepc)

# ---- supervisor-call gate (M-mode): forward an S-mode ecall to the host ------
gate:
        csrr t6, mepc
        addi t6, t6, 4
        csrw mepc, t6
        ecall                    # M-mode ecall = host syscall (halts if a7 = exit)
        mret
`;

const DEMAND = `# Demand paging — an OS that maps memory lazily, on the page fault.
# A 64 KiB virtual window (VA 0x40000000+) starts entirely UNMAPPED. As the supervisor walks
# it, each first touch raises a store page fault (cause 15); the S-mode handler allocates a
# fresh physical frame from a pool, installs a leaf PTE for the faulting page, and 'sret's to
# RETRY the very instruction that faulted — which now succeeds. Open the MMU tab to watch new
# leaves appear in the page table as the program runs. It writes i+1 into page i and sums the
# read-backs (1+2+…+16 = 136).
.equ ROOT,   0x10020000          # root page table
.equ L2,     0x10021000          # L2 table for the demand window (starts all-invalid)
.equ FRAMES, 0x10030000          # base of the free-frame pool (16 × 4 KiB)
.text
main:                            # --- machine mode: build the base address space ---
        li   t0, ROOT
        li   t1, 0x000000CF      # V R W X A D → identity megapage vpn1=0   (code)
        sw   t1, 0(t0)
        li   t1, 0x040000CF      #              identity megapage vpn1=64  (data/tables/frames)
        sw   t1, 256(t0)
        li   t1, 0x1FF000CF      #              identity megapage vpn1=511 (stack)
        sw   t1, 2044(t0)
        li   t1, 0x04008401      # V only, non-leaf → L2  (covers VA 0x40000000, vpn1=256)
        sw   t1, 1024(t0)        # root[256] = L2
        # initialise the frame allocator's bump pointer
        li   t0, FRAMES
        la   t1, next_frame
        sw   t0, 0(t1)
        # turn on Sv32
        li   t0, 0x80010020      # satp = Sv32 | (ROOT >> 12)
        csrw satp, t0
        sfence.vma
        # delegate load/store page faults (causes 13 & 15) to S-mode
        li   t0, 0xA000          # bit 13 | bit 15
        csrw medeleg, t0
        la   t0, strap
        csrw stvec, t0
        la   t0, gate            # M gate forwards S-mode ecalls
        csrw mtvec, t0
        csrr t0, mstatus
        li   t1, 0xFFFFE7FF
        and  t0, t0, t1
        li   t1, 0x800           # MPP <- S
        or   t0, t0, t1
        csrw mstatus, t0
        la   t0, smain
        csrw mepc, t0
        mret                     # → S-mode at smain, virtual memory live

smain:                          # --- supervisor mode: walk the unmapped window ---
        li   s0, 0               # running sum
        li   s1, 0x40000000      # base of the demand-paged window
        li   s2, 0               # page index i
        li   s3, 16              # touch 16 pages
sloop:
        bge  s2, s3, sdone
        slli t0, s2, 12          # offset = i * 4096 → a fresh page each iteration
        add  t0, s1, t0
        addi t1, s2, 1           # value to store = i + 1
        sw   t1, 0(t0)           # first touch → store page fault → handler maps the page
        lw   t2, 0(t0)           # now mapped: read it back
        add  s0, s0, t2
        addi s2, s2, 1
        j    sloop
sdone:
        la   a0, msg
        li   a7, 4
        ecall
        mv   a0, s0              # 1+2+…+16 = 136
        li   a7, 1
        ecall
        la   a0, nl
        li   a7, 4
        ecall
        li   a7, 10
        ecall

# ---- supervisor page-fault handler: demand-map the faulting page ------------
# A handler must preserve every register it touches: it 'sret's back to the *faulting
# instruction*, which still depends on its original operands. We stash t0 in sscratch to free a
# base register, save t1-t6 to a scratch block, do the work, then restore everything.
strap:
        csrw sscratch, t0        # free up t0
        la   t0, tsave           # base of the register save block
        sw   t1, 4(t0)
        sw   t2, 8(t0)
        sw   t3, 12(t0)
        sw   t4, 16(t0)
        sw   t5, 20(t0)
        sw   t6, 24(t0)
        csrr t1, sscratch
        sw   t1, 0(t0)           # save the original t0 too
        # --- compute and install the leaf PTE for the faulting page ---
        csrr t1, stval           # faulting virtual address
        srli t1, t1, 12
        andi t1, t1, 0x3FF       # vpn0 = index into the L2 table
        slli t1, t1, 2           # × 4 bytes per PTE
        li   t2, L2
        add  t1, t2, t1          # &L2[vpn0]
        la   t2, next_frame      # allocate a frame: f = *next_frame; *next_frame += 4096
        lw   t3, 0(t2)
        li   t6, 0x1000
        add  t4, t3, t6
        sw   t4, 0(t2)
        srli t3, t3, 12          # frame PPN
        slli t3, t3, 10          # into PTE bits [31:10]
        ori  t3, t3, 0x7         # V R W  (A/D are set by hardware on access)
        sw   t3, 0(t1)           # install the leaf PTE
        sfence.vma               # make the new mapping visible (flush the TLB)
        # --- restore the saved registers and retry the faulting instruction ---
        la   t0, tsave
        lw   t1, 4(t0)
        lw   t2, 8(t0)
        lw   t3, 12(t0)
        lw   t4, 16(t0)
        lw   t5, 20(t0)
        lw   t6, 24(t0)
        lw   t0, 0(t0)
        sret                     # retry the faulting store — it now succeeds

# ---- supervisor-call gate (M-mode) ------------------------------------------
gate:
        csrr t6, mepc
        addi t6, t6, 4
        csrw mepc, t6
        ecall
        mret
.data
next_frame: .word 0
tsave:      .space 28            # save block for t0-t6 across the trap
msg:        .asciz "demand-paged 16 fresh frames; sum of pages = "
nl:         .asciz "\\n"
`;

export const EXAMPLES: readonly Example[] = [
  { id: 'hello', title: 'Hello, RISC-V', blurb: 'print_string syscall basics', focus: 'console', code: HELLO },
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
  { id: 'compressed', title: 'Compressed (RVC)', blurb: 'RV32C 16-bit instructions', focus: 'console', code: COMPRESSED },
  { id: 'timerirq', title: 'Timer interrupts', blurb: 'mtvec/mret + CLINT timer (traps)', focus: 'console', code: TIMER_IRQ },
  { id: 'double', title: 'Double precision √2', blurb: 'RV32D Newton iteration (15 digits)', focus: 'console', code: DOUBLE_SQRT },
  { id: 'paging', title: 'Sv32 virtual memory', blurb: 'supervisor mode + page tables + a syscall gate', focus: 'console', code: PAGING },
  { id: 'demand', title: 'Demand paging', blurb: 'page-fault handler maps fresh frames lazily', focus: 'console', code: DEMAND },
  { id: 'stimer', title: 'Supervisor timer (Sstc)', blurb: 'stimecmp preempts S-mode (cause 5)', focus: 'console', code: STIMER },
  { id: 'swint', title: 'Software interrupt (IPI)', blurb: 'CLINT msip → machine software interrupt', focus: 'console', code: SOFT_IRQ },
  { id: 'mandelbrot', title: 'Mandelbrot (fixed)', blurb: 'Q12 fixed-point fractal → framebuffer', focus: 'framebuffer', code: MANDELBROT },
  { id: 'mandelf', title: 'Mandelbrot (float)', blurb: 'RV32F fractal → framebuffer', focus: 'framebuffer', code: MANDEL_FLOAT },
  { id: 'rings', title: 'Colour rings', blurb: 'memory-mapped graphics', focus: 'framebuffer', code: RINGS },
];

export const DEFAULT_EXAMPLE = EXAMPLES[1]; // Fibonacci
