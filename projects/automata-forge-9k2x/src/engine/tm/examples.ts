// A curated gallery of Turing machines: deciders for languages that climb past the lower levels of
// the Chomsky hierarchy (aⁿbⁿcⁿ and w#w are *not* even context-free — the v4 CFL pumping tab proves
// it — yet a TM decides them), a couple of transducers that are fun to watch compute, and Radó's
// famous 3-state busy beaver. Every decider here is differential-tested against an independent
// predicate over all strings up to a length bound (see the throwaway harness in the journal).

export type TMKind = 'decider' | 'transducer' | 'runner'

export interface TMExample {
  name: string
  source: string
  input: string
  note: string
  kind: TMKind
}

export const TM_EXAMPLES: TMExample[] = [
  {
    name: 'aⁿbⁿcⁿ — the canonical non-CFL',
    kind: 'decider',
    input: 'aabbcc',
    note:
      'Equal runs of a, then b, then c. This language is NOT context-free (the v4 CFL pumping tab proves it) — but this Turing machine decides it, by crossing off one a, one b and one c each pass.',
    source: `start: q0
accept: acc

# Each pass: cross one a→X, one b→Y, one c→Z, then return left and repeat.
q0 X -> q0 X R       // skip crossed a's
q0 a -> q1 X R       // cross an a, go find a matching b
q0 Y -> q5 Y R       // no a's left: verify only Y's and Z's remain
q0 _ -> acc _ S      // nothing left at all (n = 0)

q1 a -> q1 a R
q1 Y -> q1 Y R
q1 b -> q2 Y R       // cross a b, go find a matching c

q2 b -> q2 b R
q2 Z -> q2 Z R
q2 c -> q3 Z L       // cross a c, turn around

q3 a -> q3 a L        // walk back to the left end
q3 b -> q3 b L
q3 c -> q3 c L
q3 X -> q3 X L
q3 Y -> q3 Y L
q3 Z -> q3 Z L
q3 _ -> q0 _ R       // restart the next pass

q5 Y -> q5 Y R        // final check: all b's and c's must be crossed
q5 Z -> q5 Z R
q5 _ -> acc _ S`,
  },
  {
    name: 'w#w — equality, also non-CFL',
    kind: 'decider',
    input: 'abb#abb',
    note:
      'The string is some w, a separator #, then the SAME w again (over {a,b}). Like aⁿbⁿcⁿ this is not context-free — a stack can match w against its reverse, but not against a forward copy. The TM marks each left symbol and matches it past the #.',
    source: `start: q0
accept: acc

q0 X -> q0 X R        // skip already-matched symbols on the left
q0 Y -> q0 Y R
q0 a -> ma X R        // remember an 'a', go match it on the right
q0 b -> mb X R
q0 # -> chk # R       // whole left side matched — check the right has nothing left

ma a -> ma a R        // carry the 'a' rightward to the #
ma b -> ma b R
ma # -> ma2 # R
ma2 X -> ma2 X R      // then to the first unmatched symbol after the #
ma2 Y -> ma2 Y R
ma2 a -> back X L     // it must be an 'a' — mark it, return

mb a -> mb a R
mb b -> mb b R
mb # -> mb2 # R
mb2 X -> mb2 X R
mb2 Y -> mb2 Y R
mb2 b -> back Y L     // it must be a 'b'

back a -> back a L     // return to the left end
back b -> back b L
back X -> back X L
back Y -> back Y L
back # -> back # L
back _ -> q0 _ R

chk X -> chk X R       // the right side must be entirely matched too
chk Y -> chk Y R
chk _ -> acc _ S`,
  },
  {
    name: '0ⁿ1ⁿ — equal 0s then 1s',
    kind: 'decider',
    input: '000111',
    note:
      'The classic non-regular language, decided by crossing the leftmost 0 and the leftmost 1 each pass until both run out together.',
    source: `start: q0
accept: acc

q0 X -> q0 X R
q0 0 -> q1 X R        // cross a 0, go find a 1
q0 Y -> q3 Y R        // no 0's left: verify only crossed 1's remain
q0 _ -> acc _ S       // empty input

q1 0 -> q1 0 R
q1 Y -> q1 Y R
q1 1 -> q2 Y L        // cross a 1, turn around

q2 0 -> q2 0 L
q2 Y -> q2 Y L
q2 X -> q2 X L
q2 _ -> q0 _ R

q3 Y -> q3 Y R
q3 _ -> acc _ S`,
  },
  {
    name: 'Binary palindrome',
    kind: 'decider',
    input: '10101',
    note:
      'Reads the leftmost symbol, erases it, walks to the rightmost symbol and checks it matches, erases it too, and repeats inward — accepting even- and odd-length palindromes over {0,1}.',
    source: `start: s
accept: acc

s 0 -> have0 _ R      // remember & erase the leftmost symbol
s 1 -> have1 _ R
s _ -> acc _ S        // empty string is a palindrome

have0 0 -> have0 0 R   // run to the right end
have0 1 -> have0 1 R
have0 _ -> chk0 _ L

have1 0 -> have1 0 R
have1 1 -> have1 1 R
have1 _ -> chk1 _ L

chk0 0 -> back _ L     // rightmost must match the remembered symbol
chk0 _ -> acc _ S      // only the centre symbol remained (odd length)
chk1 1 -> back _ L
chk1 _ -> acc _ S

back 0 -> back 0 L      // return to the new left end
back 1 -> back 1 L
back _ -> s _ R`,
  },
  {
    name: 'Nondeterministic — contains “aa”',
    kind: 'decider',
    input: 'baab',
    note:
      'A nondeterministic machine: in state q reading an a it may either keep scanning OR guess that the “aa” starts here. The simulator searches the configuration tree breadth-first for any accepting branch.',
    source: `start: q
accept: acc

q a -> q a R          // keep scanning…
q b -> q b R
q a -> chk a R        // …OR guess the run starts at this 'a'  (two rules ⇒ nondeterministic)
chk a -> acc a S`,
  },
  {
    name: 'Binary increment (+1)',
    kind: 'transducer',
    input: '10111',
    note:
      'A transducer, not a decider: it rewrites a most-significant-bit-first binary number to its successor. Watch the carry ripple right-to-left through a run of 1s.',
    source: `start: r
accept: acc

r 0 -> r 0 R          // run to the least-significant bit
r 1 -> r 1 R
r _ -> add _ L

add 1 -> add 0 L      // 1 + carry = 0, carry onward
add 0 -> acc 1 S      // 0 + carry = 1, done
add _ -> acc 1 S      // carry past the MSB: prepend a 1`,
  },
  {
    name: 'Unary addition',
    kind: 'transducer',
    input: '111+11',
    note:
      'Computes 1ᵃ + 1ᵇ = 1ᵃ⁺ᵇ by turning the “+” into a 1 and erasing one 1 from the right end.',
    source: `start: f
accept: acc

f 1 -> f 1 R
f + -> g 1 R          // the '+' becomes a '1'…
g 1 -> g 1 R
g _ -> back _ L
back 1 -> acc _ S     // …and one '1' is erased from the end`,
  },
  {
    name: 'Busy beaver BB(3)',
    kind: 'runner',
    input: '',
    note:
      'Radó’s 3-state, 2-symbol busy beaver: started on a blank tape it halts after 14 steps having written six 1s — the most a 3-state machine can do. A tiny program with surprisingly large output, and a reminder that “does it halt?” is undecidable in general.',
    source: `start: A
accept: H
blank: 0

A 0 -> B 1 R
A 1 -> C 1 L
B 0 -> A 1 L
B 1 -> B 1 R
C 0 -> B 1 L
C 1 -> H 1 R`,
  },
]
