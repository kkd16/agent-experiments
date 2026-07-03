// corpus.ts — sample inputs that exercise different structure, so the benchmark
// tells a story: entropy coders win on skewed distributions, dictionary coders
// win on repetition, BWT wins on clustered context, and nothing beats random.

export interface Sample {
  id: string
  name: string
  note: string
  text: string
}

const declaration =
  'We hold these truths to be self-evident, that all men are created equal, that they are ' +
  'endowed by their Creator with certain unalienable Rights, that among these are Life, Liberty ' +
  'and the pursuit of Happiness. That to secure these rights, Governments are instituted among ' +
  'Men, deriving their just powers from the consent of the governed, that whenever any Form of ' +
  'Government becomes destructive of these ends, it is the Right of the People to alter or to ' +
  'abolish it, and to institute new Government.'

const lorem = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut ' +
  'labore et dolore magna aliqua '
).repeat(6)

const dna = (() => {
  // A pseudo-genome with motifs — repetitive but not trivially so.
  const motifs = ['ATGCATGC', 'GGGCCCTTT', 'TATATATA', 'ACGTACGTACGT', 'CCGGAATT']
  let s = ''
  let x = 1234567
  for (let i = 0; i < 90; i++) {
    x = (1103515245 * x + 12345) & 0x7fffffff // LCG, deterministic
    s += motifs[x % motifs.length]
  }
  return s
})()

const json =
  '{"users":[' +
  Array.from(
    { length: 12 },
    (_, i) =>
      `{"id":${i},"name":"user_${i}","active":${i % 2 === 0},"role":"member","score":${i * 7}}`,
  ).join(',') +
  ']}'

const source = `function fib(n) {
  if (n < 2) return n
  let a = 0, b = 1
  for (let i = 2; i <= n; i++) {
    const c = a + b
    a = b
    b = c
  }
  return b
}
function fact(n) {
  let r = 1
  for (let i = 2; i <= n; i++) r = r * i
  return r
}`.repeat(3)

const repetitive = 'ABABABABAB'.repeat(20) + 'CDCDCD'.repeat(15) + 'Z'.repeat(40)

// A server access log: every line shares the same field layout, so the byte
// offsets between one line's timestamp/verb/status and the next recur over and
// over — exactly the structure LZMA's rep0..rep3 distance cache is built for.
const serverlog = (() => {
  const verbs = ['GET', 'POST', 'GET', 'GET', 'PUT']
  const paths = ['/api/users', '/api/orders', '/static/app.js', '/api/users/42', '/health']
  const codes = [200, 200, 200, 404, 500, 200, 301]
  let x = 20260703
  let s = ''
  for (let i = 0; i < 28; i++) {
    x = (1103515245 * x + 12345) & 0x7fffffff
    const v = verbs[x % verbs.length]
    x = (1103515245 * x + 12345) & 0x7fffffff
    const p = paths[x % paths.length]
    x = (1103515245 * x + 12345) & 0x7fffffff
    const c = codes[x % codes.length]
    const ts = `2026-07-03T10:${String(i % 60).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}Z`
    s += `192.168.0.${10 + (i % 40)} - - [${ts}] "${v} ${p} HTTP/1.1" ${c} ${512 + ((i * 37) % 4096)} "-" "Mozilla/5.0"\n`
  }
  return s
})()

const random = (() => {
  // Deterministic high-entropy bytes rendered as printable characters.
  let x = 987654321
  let s = ''
  for (let i = 0; i < 400; i++) {
    x = (1103515245 * x + 12345) & 0x7fffffff
    s += String.fromCharCode(33 + (x % 94))
  }
  return s
})()

export const CORPUS: Sample[] = [
  { id: 'declaration', name: 'English prose', note: 'natural language, skewed letters', text: declaration },
  { id: 'lorem', name: 'Repeated lorem', note: 'phrase-level repetition', text: lorem },
  { id: 'dna', name: 'DNA motifs', note: '4-letter alphabet, motif repeats', text: dna },
  { id: 'json', name: 'JSON records', note: 'structured, keyword-heavy', text: json },
  { id: 'source', name: 'Source code', note: 'syntax + repeated functions', text: source },
  { id: 'serverlog', name: 'Server log', note: 'fixed-layout lines, recurring offsets', text: serverlog },
  { id: 'repetitive', name: 'Pathological runs', note: 'long literal runs', text: repetitive },
  { id: 'random', name: 'High entropy', note: 'near-incompressible', text: random },
]
