// A tiny C standard library — written in C — that the `cc` compiler links in front of the
// user's program and compiles through the very same pipeline. The only magic is a handful of
// `__sys_*` / `__lsr` builtins (lowered by codegen to `ecall` / a single instruction); every
// real routine here (malloc, the string functions, printf with its va_arg loop) is ordinary
// C, so the compiler is exercised by its own runtime.

export const PRELUDE_SOURCE = `
// ---- low-level memory ----
void *malloc(int n) {
  return __sys_sbrk((n + 3) & ~3);
}
void free(void *p) {
  // bump allocator: freeing is a no-op
}
void *memset(void *dst, int c, int n) {
  char *p = dst;
  int i = 0;
  while (i < n) { p[i] = c; i = i + 1; }
  return dst;
}
void *memcpy(void *dst, void *src, int n) {
  char *d = dst;
  char *s = src;
  int i = 0;
  while (i < n) { d[i] = s[i]; i = i + 1; }
  return dst;
}

// ---- strings ----
int strlen(char *s) {
  int n = 0;
  while (s[n] != 0) n = n + 1;
  return n;
}
int strcmp(char *a, char *b) {
  int i = 0;
  while (a[i] != 0 && a[i] == b[i]) i = i + 1;
  return a[i] - b[i];
}
char *strcpy(char *d, char *s) {
  int i = 0;
  while (s[i] != 0) { d[i] = s[i]; i = i + 1; }
  d[i] = 0;
  return d;
}

// ---- character / line output ----
int putchar(int c) {
  __sys_print_char(c);
  return c;
}
void print_int(int n) {
  __sys_print_int(n);
}
void print_str(char *s) {
  __sys_print_str(s);
}
int puts(char *s) {
  __sys_print_str(s);
  __sys_print_char(10);
  return 0;
}
int rand() {
  return __sys_rand();
}
void exit(int code) {
  __sys_exit(code);
}

// ---- printf ----
void __print_hex(int x) {
  int started = 0;
  int i = 28;
  while (i >= 0) {
    int d = __lsr(x, i) & 15;
    if (d != 0 || started != 0 || i == 0) {
      started = 1;
      if (d < 10) __sys_print_char('0' + d);
      else __sys_print_char('a' + d - 10);
    }
    i = i - 4;
  }
}
int printf(char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int i = 0;
  while (fmt[i] != 0) {
    char c = fmt[i];
    if (c == '%') {
      i = i + 1;
      char k = fmt[i];
      if (k == 'd') __sys_print_int(va_arg(ap, int));
      else if (k == 'u') __sys_print_uint(va_arg(ap, int));
      else if (k == 'x') __print_hex(va_arg(ap, int));
      else if (k == 'c') __sys_print_char(va_arg(ap, int));
      else if (k == 's') __sys_print_str(va_arg(ap, char*));
      else if (k == '%') __sys_print_char('%');
      else { __sys_print_char('%'); __sys_print_char(k); }
    } else {
      __sys_print_char(c);
    }
    i = i + 1;
  }
  va_end(ap);
  return 0;
}
`;
