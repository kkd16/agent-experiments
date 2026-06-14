// The C compiler's behavioural test battery. Each case is a complete C program plus the
// stdout it must produce. `runCase` compiles it, assembles the result with the studio's own
// assembler, runs it on the interpreter, and compares the captured output — proving the
// whole front-to-back pipeline end to end. The same battery powers the in-app "C Verify"
// panel and the headless harness.

import { compile } from './compile';
import { assemble } from '../vm/assembler';
import { Cpu } from '../vm/cpu';
import { C_EXAMPLES } from './examples';

export interface CCase {
  name: string;
  source: string;
  expect: string;
}

export interface CCaseResult {
  name: string;
  passed: boolean;
  detail: string;
}

export function runCase(c: CCase): CCaseResult {
  const r = compile(c.source);
  if (!r.ok || r.asm === null) {
    return {
      name: c.name,
      passed: false,
      detail: 'compile error: ' + r.diags.map((d) => `L${d.line} ${d.message}`).join('; '),
    };
  }
  const a = assemble(r.asm);
  if (!a.ok) {
    return {
      name: c.name,
      passed: false,
      detail: 'assembler error: ' + a.errors.map((e) => `L${e.line} ${e.message}`).join('; '),
    };
  }
  const cpu = new Cpu();
  cpu.load(a);
  cpu.run(60_000_000);
  if (cpu.status === 'error') {
    return { name: c.name, passed: false, detail: 'runtime error: ' + cpu.error };
  }
  if (cpu.output !== c.expect) {
    return {
      name: c.name,
      passed: false,
      detail: `output mismatch:\n  expected ${JSON.stringify(c.expect)}\n  got      ${JSON.stringify(cpu.output)}`,
    };
  }
  return { name: c.name, passed: true, detail: `ok (${cpu.cycles.toLocaleString()} cycles)` };
}

export const CC_TESTS: CCase[] = [
  { name: 'arithmetic precedence', source: `int main(){ print_int(2 + 3 * 4 - 1); return 0; }`, expect: '13' },
  { name: 'printf %d', source: `int main(){ printf("x=%d\\n", 42); return 0; }`, expect: 'x=42\n' },
  {
    name: 'recursive fibonacci',
    source: `int fib(int n){ if(n<2) return n; return fib(n-1)+fib(n-2);} int main(){ int i; for(i=0;i<10;i++){ print_int(fib(i)); putchar(' ');} return 0;}`,
    expect: '0 1 1 2 3 5 8 13 21 34 ',
  },
  { name: 'pointers mutate', source: `void inc(int*p){(*p)++;} int main(){int x=41;inc(&x);print_int(x);return 0;}`, expect: '42' },
  {
    name: 'arrays sum',
    source: `int main(){int a[3];a[0]=10;a[1]=20;a[2]=30;int s=0,i;for(i=0;i<3;i++)s+=a[i];print_int(s);return 0;}`,
    expect: '60',
  },
  { name: 'while loop sum 1..100', source: `int main(){int i=0,s=0;while(i<=100){s=s+i;i++;}print_int(s);return 0;}`, expect: '5050' },
  { name: 'do-while', source: `int main(){int i=0;do{print_int(i);i++;}while(i<3);return 0;}`, expect: '012' },
  {
    name: 'break & continue',
    source: `int main(){int i;for(i=0;i<10;i++){if(i==3)continue;if(i==6)break;print_int(i);}return 0;}`,
    expect: '01245',
  },
  { name: 'ternary', source: `int main(){int x=7;print_int(x>5?100:200);return 0;}`, expect: '100' },
  {
    name: 'short-circuit && ||',
    source: `int f(){print_str("!");return 1;} int main(){int x=0;if(x&&f())putchar('a');if(x||f())putchar('b');return 0;}`,
    expect: '!b',
  },
  { name: 'compound assignment', source: `int main(){int x=10;x+=5;x*=2;x-=3;x/=2;x%=5;print_int(x);return 0;}`, expect: '3' },
  { name: 'bitwise operators', source: `int main(){printf("%d %d %d %d %d\\n",6&3,6|1,6^3,1<<4,255>>4);return 0;}`, expect: '2 7 5 16 15\n' },
  {
    name: 'globals & static arrays',
    source: `int g=42;int arr[5];int main(){int i;for(i=0;i<5;i++)arr[i]=i*i;print_int(g);for(i=0;i<5;i++){putchar(' ');print_int(arr[i]);}return 0;}`,
    expect: '42 0 1 4 9 16',
  },
  { name: 'factorial', source: `int fact(int n){return n<=1?1:n*fact(n-1);} int main(){print_int(fact(10));return 0;}`, expect: '3628800' },
  {
    name: 'ackermann(2,3)',
    source: `int ack(int m,int n){if(m==0)return n+1;if(n==0)return ack(m-1,1);return ack(m-1,ack(m,n-1));} int main(){print_int(ack(2,3));return 0;}`,
    expect: '9',
  },
  {
    name: 'bubble sort',
    source: `void sort(int*a,int n){int i,j;for(i=0;i<n-1;i++)for(j=0;j<n-1-i;j++)if(a[j]>a[j+1]){int t=a[j];a[j]=a[j+1];a[j+1]=t;}} int main(){int a[6];a[0]=5;a[1]=2;a[2]=8;a[3]=1;a[4]=9;a[5]=3;sort(a,6);int i;for(i=0;i<6;i++){print_int(a[i]);putchar(' ');}return 0;}`,
    expect: '1 2 3 5 8 9 ',
  },
  { name: 'struct fields', source: `struct Point{int x;int y;}; int main(){struct Point p;p.x=3;p.y=4;print_int(p.x*p.x+p.y*p.y);return 0;}`, expect: '25' },
  {
    name: 'struct pointers (->)',
    source: `struct Node{int val;struct Node*next;}; int main(){struct Node a;struct Node b;a.val=1;a.next=&b;b.val=2;b.next=0;struct Node*p=&a;int s=0;while(p){s+=p->val;p=p->next;}print_int(s);return 0;}`,
    expect: '3',
  },
  {
    name: 'linked list + malloc',
    source: `struct N{int v;struct N*next;}; int main(){struct N*head=0;int i;for(i=5;i>=1;i--){struct N*n=malloc(sizeof(struct N));n->v=i;n->next=head;head=n;}struct N*p=head;while(p){print_int(p->v);putchar(' ');p=p->next;}return 0;}`,
    expect: '1 2 3 4 5 ',
  },
  { name: 'strlen / strcpy', source: `int main(){char buf[20];strcpy(buf,"hello");print_int(strlen(buf));putchar(' ');print_str(buf);return 0;}`, expect: '5 hello' },
  { name: 'strcmp', source: `int main(){printf("%d %d\\n",strcmp("abc","abc"),strcmp("abc","abd")<0);return 0;}`, expect: '0 1\n' },
  { name: 'printf mixed formats', source: `int main(){printf("%s=%d (0x%x) ch=%c%%\\n","val",255,255,65);return 0;}`, expect: 'val=255 (0xff) ch=A%\n' },
  { name: 'printf %u (unsigned)', source: `int main(){printf("%u\\n",-1);return 0;}`, expect: '4294967295\n' },
  { name: 'char arithmetic', source: `int main(){char c='A';int i;for(i=0;i<5;i++)putchar(c+i);return 0;}`, expect: 'ABCDE' },
  { name: 'pointer walk over string', source: `int main(){char*s="abcdef";char*p=s;int n=0;while(*p){n++;p++;}print_int(n);return 0;}`, expect: '6' },
  { name: 'sizeof', source: `struct S{int a;char b;int c;}; int main(){printf("%d %d %d\\n",sizeof(int),sizeof(char),sizeof(struct S));return 0;}`, expect: '4 1 12\n' },
  { name: 'gcd (euclid)', source: `int gcd(int a,int b){while(b){int t=b;b=a%b;a=t;}return a;} int main(){print_int(gcd(48,36));return 0;}`, expect: '12' },
  {
    name: '9 args (register + stack passing)',
    source: `int sum9(int a,int b,int c,int d,int e,int f,int g,int h,int i){return a+b+c+d+e+f+g+h+i;} int main(){print_int(sum9(1,2,3,4,5,6,7,8,9));return 0;}`,
    expect: '45',
  },
  {
    name: '2D array diagonal',
    source: `int main(){int m[3][3];int i,j;for(i=0;i<3;i++)for(j=0;j<3;j++)m[i][j]=i*3+j;int s=0;for(i=0;i<3;i++)s+=m[i][i];print_int(s);return 0;}`,
    expect: '12',
  },
  { name: 'negative div/mod', source: `int main(){printf("%d %d\\n",-7/2,-7%2);return 0;}`, expect: '-3 -1\n' },
  {
    name: 'sieve of Eratosthenes',
    source: `int main(){int p[50];int i,j;for(i=0;i<50;i++)p[i]=1;for(i=2;i<50;i++)if(p[i])for(j=i*2;j<50;j+=i)p[j]=0;for(i=2;i<50;i++)if(p[i]){print_int(i);putchar(' ');}return 0;}`,
    expect: '2 3 5 7 11 13 17 19 23 29 31 37 41 43 47 ',
  },
  {
    name: 'function pointer',
    source: `int add(int a,int b){return a+b;} int mul(int a,int b){return a*b;} int apply(int(*f)(int,int),int x,int y){return f(x,y);} int main(){printf("%d %d\\n",apply(add,3,4),apply(mul,3,4));return 0;}`,
    expect: '7 12\n',
  },
  {
    name: 'large stack frame (4KB array)',
    source: `int main(){int a[1000];int i;for(i=0;i<1000;i++)a[i]=i;int s=0;for(i=0;i<1000;i++)s+=a[i];print_int(s);return 0;}`,
    expect: '499500',
  },
  {
    name: 'nested struct',
    source: `struct A{int x;int y;}; struct B{struct A a;int z;}; int main(){struct B b;b.a.x=3;b.a.y=4;b.z=5;print_int(b.a.x+b.a.y+b.z);return 0;}`,
    expect: '12',
  },
  {
    name: 'array of structs',
    source: `struct P{int x;int y;}; int main(){struct P pts[3];int i;for(i=0;i<3;i++){pts[i].x=i;pts[i].y=i*i;}int s=0;for(i=0;i<3;i++)s+=pts[i].x+pts[i].y;print_int(s);return 0;}`,
    expect: '8',
  },
  { name: 'pointer to pointer', source: `int main(){int x=7;int*p=&x;int**pp=&p;**pp=99;print_int(x);return 0;}`, expect: '99' },
  { name: 'global char[] init', source: `char msg[]="hi there"; int main(){print_str(msg);putchar('!');return 0;}`, expect: 'hi there!' },
  { name: 'global char* init', source: `char *g="pointer"; int main(){print_str(g);return 0;}`, expect: 'pointer' },
  { name: 'signed char overflow', source: `int main(){char c=200;int x=c;print_int(x);return 0;}`, expect: '-56' },
  { name: 'comma in for', source: `int main(){int i,j;for(i=0,j=10;i<j;i++,j--)print_int(i);return 0;}`, expect: '01234' },
  { name: 'hex & octal literals', source: `int main(){print_int(0xff);putchar(' ');print_int(010);return 0;}`, expect: '255 8' },
  { name: 'memset / memcpy', source: `int main(){char a[5];char b[5];memset(a,'x',5);a[4]=0;memcpy(b,a,5);print_str(b);return 0;}`, expect: 'xxxx' },
  { name: 'struct holding string', source: `struct S{char*name;int age;}; int main(){struct S s;s.name="Bob";s.age=30;printf("%s is %d\\n",s.name,s.age);return 0;}`, expect: 'Bob is 30\n' },
];

// Every bundled example must at least compile, assemble, and run without faulting.
export function exampleSmokeTests(): CCase[] {
  return C_EXAMPLES.map((ex) => ({ name: `example: ${ex.title}`, source: ex.code, expect: '__nocheck__' }));
}

export function runExampleSmoke(ex: { name: string; source: string }): CCaseResult {
  const r = compile(ex.source);
  if (!r.ok || r.asm === null)
    return { name: ex.name, passed: false, detail: 'compile error: ' + r.diags.map((d) => `L${d.line} ${d.message}`).join('; ') };
  const a = assemble(r.asm);
  if (!a.ok) return { name: ex.name, passed: false, detail: 'assembler error: ' + a.errors.map((e) => e.message).join('; ') };
  const cpu = new Cpu();
  cpu.load(a);
  cpu.run(60_000_000);
  if (cpu.status === 'error') return { name: ex.name, passed: false, detail: 'runtime error: ' + cpu.error };
  return { name: ex.name, passed: true, detail: `ran, ${cpu.output.length} bytes out` };
}
