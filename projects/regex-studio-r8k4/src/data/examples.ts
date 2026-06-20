// A curated library of patterns to explore. Each comes with sample text so the
// match highlighting and debugger have something interesting to chew on.

export interface Example {
  name: string;
  pattern: string;
  sample: string;
  note: string;
}

export const EXAMPLES: Example[] = [
  {
    name: 'Binary multiples of 3',
    pattern: '(0|1(01*0)*1)+',
    sample: '110 1001 111 1010 0 11',
    note: 'Classic automata example: binary strings divisible by three.',
  },
  {
    name: 'Identifier',
    pattern: '[A-Za-z_][A-Za-z0-9_]*',
    sample: 'let user_id = total2 + _tmp;',
    note: 'A C-style identifier — letter or underscore, then word characters.',
  },
  {
    name: 'Decimal number',
    pattern: '-?\\d+(\\.\\d+)?',
    sample: 'x = -3.14, y = 42, z = 0.5 and 7',
    note: 'Optional sign, integer part, optional fractional part.',
  },
  {
    name: 'Hex colour',
    pattern: '#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})',
    sample: 'bg #fff border #1a2b3c bad #12 ok #0A0A0A',
    note: 'A 3- or 6-digit hex colour code — note how {3} and {6} desugar.',
  },
  {
    name: 'Email-ish',
    pattern: '[\\w.]+@[\\w]+(\\.[\\w]+)+',
    sample: 'mail a@b.com, jane.doe@mail.co.uk, nope@no',
    note: 'A deliberately simplified email matcher.',
  },
  {
    name: 'Even binary',
    pattern: '(0|1)*0',
    sample: '10 11 100 1011 0 110',
    note: 'Binary strings that end in 0 — the smallest non-trivial DFA.',
  },
  {
    name: 'a then b runs',
    pattern: 'a+b+',
    sample: 'aabb ab aaabbbb b a abab',
    note: 'One or more a’s followed by one or more b’s.',
  },
  {
    name: 'Doubled vowel',
    pattern: '\\w*(aa|ee|oo)\\w*',
    sample: 'book feet cat seen moon dog',
    note: 'Words containing a doubled vowel — minimisation collapses a lot here.',
  },
  {
    name: 'Anbn-ish (bounded)',
    pattern: 'a{2,4}b{2,4}',
    sample: 'aabb aaabbb ab aaaabbbb aaaaabb',
    note: 'Bounded counting — see how {2,4} unrolls in the NFA.',
  },
  {
    name: 'Word boundary phone',
    pattern: '\\(?\\d{3}\\)?[-. ]?\\d{3}[-. ]?\\d{4}',
    sample: 'call (555) 123-4567 or 555.987.6543 today',
    note: 'A loose North-American phone-number pattern.',
  },
  {
    name: 'Doubled word (backref)',
    pattern: '\\b(\\w+) \\1\\b',
    sample: 'the the cat sat on on the mat',
    note: 'Backreference \\1 — non-regular! Runs on the backtracking VM, not the DFA.',
  },
  {
    name: 'ISO date (captures)',
    pattern: '(\\d{4})-(\\d{2})-(\\d{2})',
    sample: 'released 2026-06-20, patched 2026-07-01',
    note: 'Three capture groups — see the year/month/day spans in the capture table.',
  },
  {
    name: 'Anchored integer',
    pattern: '^-?\\d+$',
    sample: '42\nabc\n-7\n3.5',
    note: 'Anchors ^ and $ — try multiline input; only whole-line integers fully match.',
  },
  {
    name: 'Password rule (lookahead)',
    pattern: '(?=.*\\d)(?=.*[a-z]).{6,}',
    sample: 'abc123 short Ab1 password9',
    note: 'Two positive lookaheads require a digit and a lowercase letter — a classic assertion.',
  },
  {
    name: 'Catastrophic backtracking',
    pattern: '(a+)+$',
    sample: 'aaaaaaaaaaaaaaaaaaaaaaaa!',
    note: 'ReDoS: open the ReDoS tab — it proves the exponential blow-up and synthesises the attack.',
  },
  {
    name: 'Named captures (date)',
    pattern: '(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})',
    sample: 'ship 2026-06-20, freeze 2026-07-01',
    note: 'Named groups (?<name>…). The capture table shows names; \\k<year> back-references one.',
  },
  {
    name: 'Named backref (doubled word)',
    pattern: '\\b(?<w>\\w+) \\k<w>\\b',
    sample: 'the the cat sat on on the mat',
    note: 'A named backreference \\k<w> — non-regular, so it runs on the backtracking VM only.',
  },
  {
    name: 'Evil CSV (ReDoS)',
    pattern: '(.*,)*$',
    sample: 'a,b,c,d,e,f,g,h!',
    note: 'A classic exponential pattern hiding in a CSV validator — the ReDoS tab finds and demonstrates it.',
  },
  {
    name: 'Quadratic (polynomial)',
    pattern: '\\s*\\s*$',
    sample: '          x',
    note: 'Two adjacent stars — not exponential, but quadratic. The ReDoS tab fits the degree from the curve.',
  },
];

export const DEFAULT_EXAMPLE = EXAMPLES[1];
