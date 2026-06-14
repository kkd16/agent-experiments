// Bundled C example programs for the Compiler tab. Each one compiles with `cc`, assembles,
// and runs on the studio's machine — so they double as living documentation and a smoke test.

export interface CExample {
  id: string;
  title: string;
  blurb: string;
  code: string;
}

export const C_EXAMPLES: CExample[] = [
  {
    id: 'hello',
    title: 'Hello, printf',
    blurb: 'printf with %d / %s / %x / %c — a real variadic call compiled to RISC-V.',
    code: `// Everything here is compiled to RV32IM and run on the studio's CPU.
int main() {
    char *who = "RISC-V";
    int n = 42;
    printf("Hello from %s!\\n", who);
    printf("decimal=%d  hex=0x%x  char=%c\\n", n, n, 33 + n);
    return 0;
}
`,
  },
  {
    id: 'fib',
    title: 'Recursive Fibonacci',
    blurb: 'Recursion exercising the calling convention and stack frames.',
    code: `int fib(int n) {
    if (n < 2) return n;
    return fib(n - 1) + fib(n - 2);
}

int main() {
    int i;
    for (i = 0; i < 15; i++) {
        printf("%d ", fib(i));
    }
    putchar('\\n');
    return 0;
}
`,
  },
  {
    id: 'sieve',
    title: 'Sieve of Eratosthenes',
    blurb: 'Arrays, nested loops, and pointer indexing.',
    code: `#define N 100   // (the cc front-end ignores unknown directives)

int main() {
    int prime[100];
    int i, j;
    for (i = 0; i < 100; i++) prime[i] = 1;
    for (i = 2; i < 100; i++) {
        if (prime[i]) {
            printf("%d ", i);
            for (j = i * 2; j < 100; j += i) prime[j] = 0;
        }
    }
    putchar('\\n');
    return 0;
}
`,
  },
  {
    id: 'list',
    title: 'Linked list + malloc',
    blurb: 'Structs, pointers-to-struct, and heap allocation via the sbrk syscall.',
    code: `struct Node {
    int value;
    struct Node *next;
};

struct Node *cons(int v, struct Node *tail) {
    struct Node *n = malloc(sizeof(struct Node));
    n->value = v;
    n->next = tail;
    return n;
}

int main() {
    struct Node *list = 0;
    int i;
    for (i = 1; i <= 8; i++) list = cons(i * i, list);

    int sum = 0;
    struct Node *p = list;
    while (p) {
        printf("%d ", p->value);
        sum += p->value;
        p = p->next;
    }
    printf("\\nsum of squares = %d\\n", sum);
    return 0;
}
`,
  },
  {
    id: 'mandelbrot',
    title: 'ASCII Mandelbrot',
    blurb: 'Fixed-point integer math rendering the Mandelbrot set as text.',
    code: `// Fixed-point (scale = 1000) Mandelbrot, drawn with ASCII shading.
int main() {
    char *shades = " .:-=+*#%@";
    int py, px;
    for (py = 0; py < 24; py++) {
        for (px = 0; px < 70; px++) {
            int x0 = px * 5000 / 70 - 2500;   // real in [-2.5, 2.5]
            int y0 = py * 2400 / 24 - 1200;   // imag in [-1.2, 1.2]
            int x = 0, y = 0, i = 0;
            while (i < 90) {
                int x2 = x * x / 1000;
                int y2 = y * y / 1000;
                if (x2 + y2 > 4000) break;
                int xt = x2 - y2 + x0;
                y = 2 * x * y / 1000 + y0;
                x = xt;
                i++;
            }
            putchar(shades[i * 9 / 90]);
        }
        putchar('\\n');
    }
    return 0;
}
`,
  },
  {
    id: 'fizzbuzz',
    title: 'FizzBuzz',
    blurb: 'The classic — control flow, modulo, and string output.',
    code: `int main() {
    int i;
    for (i = 1; i <= 30; i++) {
        if (i % 15 == 0) print_str("FizzBuzz");
        else if (i % 3 == 0) print_str("Fizz");
        else if (i % 5 == 0) print_str("Buzz");
        else print_int(i);
        putchar('\\n');
    }
    return 0;
}
`,
  },
  {
    id: 'sort',
    title: 'Quicksort',
    blurb: 'Recursive in-place quicksort over an int array via pointers.',
    code: `void swap(int *a, int *b) { int t = *a; *a = *b; *b = t; }

void quicksort(int *a, int lo, int hi) {
    if (lo >= hi) return;
    int pivot = a[hi];
    int i = lo - 1;
    int j;
    for (j = lo; j < hi; j++) {
        if (a[j] < pivot) { i++; swap(&a[i], &a[j]); }
    }
    swap(&a[i + 1], &a[hi]);
    int p = i + 1;
    quicksort(a, lo, p - 1);
    quicksort(a, p + 1, hi);
}

int main() {
    int a[10];
    int seed = 12345;
    int i;
    for (i = 0; i < 10; i++) { seed = seed * 1103515245 + 12345; a[i] = (seed >> 16) % 100; if (a[i] < 0) a[i] = -a[i]; }
    quicksort(a, 0, 9);
    for (i = 0; i < 10; i++) printf("%d ", a[i]);
    putchar('\\n');
    return 0;
}
`,
  },
  {
    id: 'strings',
    title: 'String toolkit',
    blurb: 'strlen / strcpy / a hand-written reverse, all in C.',
    code: `void reverse(char *s) {
    int n = strlen(s);
    int i = 0;
    int j = n - 1;
    while (i < j) {
        char t = s[i];
        s[i] = s[j];
        s[j] = t;
        i++;
        j--;
    }
}

int main() {
    char buf[32];
    strcpy(buf, "compiler");
    printf("len(%s) = %d\\n", buf, strlen(buf));
    reverse(buf);
    printf("reversed = %s\\n", buf);
    return 0;
}
`,
  },
];

export const DEFAULT_C_EXAMPLE = C_EXAMPLES[0];
