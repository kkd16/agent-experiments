// A gallery of timed automata — the canonical teaching machines, each chosen to
// exercise a different facet (invariants forcing progress, resets creating
// memory, guards carving a timed language, and the region blow-up that makes the
// symbolic zone engine worth having).

export interface TimedExample {
  id: string
  name: string
  note: string
  source: string
}

export const TIMED_EXAMPLES: TimedExample[] = [
  {
    id: 'light',
    name: 'Light switch',
    note:
      'Alur & Dill’s original. One press turns the light on; a second press within 3 time units makes it bright, otherwise it just toggles off. The clock x, reset on the first press, remembers how long ago it happened.',
    source: `clocks x
init off

loc off
loc light
loc bright

off   -> light  do x act press
light -> bright if x<3 do x act press
light -> off    if x>=3 act press
bright -> off   act press`,
  },
  {
    id: 'deadline',
    name: 'Deadline (invariant forces progress)',
    note:
      'The invariant x<=2 in "work" forbids dwelling past 2 units, but the only exit needs x>=3 — so the deadline can never be met and "done" is UNREACHABLE. Relax the invariant to x<=5 and it opens up. This is the delay/invariant interaction in miniature.',
    source: `clocks x
init idle

loc idle
loc work inv x<=2
loc done accepting

idle -> work do x act start
work -> done if x>=3 act finish`,
  },
  {
    id: 'response',
    name: 'Bounded response (a timed language)',
    note:
      'Accepts the timed word a·b exactly when b follows a after a delay in the open interval (1,2). The guard 1<x<2 (two atoms) on the second edge is the language; "bad" is the reject sink for a too-early or too-late b.',
    source: `clocks x
init q0

loc q0
loc q1 inv x<=2
loc q2 accepting
loc bad

q0 -> q1 do x act a
q1 -> q2 if x>1 act b
q1 -> bad if x<=1 act b`,
  },
  {
    id: 'traingate',
    name: 'Train / gate',
    note:
      'A train approaches (signal within [2,5] of crossing) while a controller lowers the gate. The two clocks x (train) and y (gate) run independently; the model interleaves them, and the region graph shows the fractional-order refinement that two clocks create.',
    source: `clocks x, y
init far

loc far
loc near inv x<=5
loc cross inv x<=5
loc gone

far  -> near  do x act approach
near -> cross if x>=2 do y act enter
cross -> gone if x<=5 do x,y act leave
gone -> far   act reset`,
  },
  {
    id: 'periodic',
    name: 'Periodic task',
    note:
      'Fires an action every period: the invariant p<=4 bounds the wait, the guard p>=4 forces the tick to land exactly at 4, and the reset restarts the clock. A single point in each period — the tightest kind of timing.',
    source: `clocks p
init wait

loc wait inv p<=4
loc tick

wait -> tick if p>=4 do p act fire
tick -> wait act arm`,
  },
  {
    id: 'twoclock',
    name: 'Two-clock interleaving',
    note:
      'A deliberately region-rich machine: two clocks compared to 2 with no resets, so their fractional order keeps refining as time passes. Great for watching the region automaton fan out while the zone graph stays small.',
    source: `clocks x, y
init s

loc s inv x<=2
loc t

s -> t if x>=1&y>=1 act go
t -> s do x,y act back`,
  },
  {
    id: 'watchdog',
    name: 'Watchdog timeout',
    note:
      'A service must send a heartbeat every ≤3 units or the watchdog fires. Miss the window (guard w>3 out of the "alive" invariant w<=3) and control drops to "timeout" — a safety location whose reachability answers "can the watchdog ever trip?".',
    source: `clocks w
init alive

loc alive inv w<=3
loc beat
loc timeout

alive -> beat    if w<=3 do w act heartbeat
beat  -> alive   act resume
alive -> timeout if w>=3 act fire`,
  },
]

export const DEFAULT_TIMED = TIMED_EXAMPLES[0]
