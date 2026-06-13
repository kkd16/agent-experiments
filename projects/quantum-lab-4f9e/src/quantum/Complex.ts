export class Complex {
  re: number;
  im: number;
  constructor(re: number, im = 0) {
    this.re = re;
    this.im = im;
  }

  static zero(): Complex { return new Complex(0, 0); }
  static one(): Complex { return new Complex(1, 0); }
  static i(): Complex { return new Complex(0, 1); }
  static fromPolar(r: number, theta: number): Complex {
    return new Complex(r * Math.cos(theta), r * Math.sin(theta));
  }

  add(other: Complex): Complex {
    return new Complex(this.re + other.re, this.im + other.im);
  }

  sub(other: Complex): Complex {
    return new Complex(this.re - other.re, this.im - other.im);
  }

  mul(other: Complex): Complex {
    return new Complex(
      this.re * other.re - this.im * other.im,
      this.re * other.im + this.im * other.re
    );
  }

  scale(s: number): Complex {
    return new Complex(this.re * s, this.im * s);
  }

  conj(): Complex {
    return new Complex(this.re, -this.im);
  }

  abs(): number {
    return Math.sqrt(this.re * this.re + this.im * this.im);
  }

  abs2(): number {
    return this.re * this.re + this.im * this.im;
  }

  phase(): number {
    return Math.atan2(this.im, this.re);
  }

  neg(): Complex {
    return new Complex(-this.re, -this.im);
  }

  div(other: Complex): Complex {
    const d = other.abs2();
    return new Complex(
      (this.re * other.re + this.im * other.im) / d,
      (this.im * other.re - this.re * other.im) / d
    );
  }

  toString(): string {
    if (Math.abs(this.im) < 1e-10) return this.re.toFixed(4);
    if (Math.abs(this.re) < 1e-10) return `${this.im.toFixed(4)}i`;
    const sign = this.im >= 0 ? '+' : '-';
    return `${this.re.toFixed(3)}${sign}${Math.abs(this.im).toFixed(3)}i`;
  }

  equals(other: Complex, eps = 1e-9): boolean {
    return Math.abs(this.re - other.re) < eps && Math.abs(this.im - other.im) < eps;
  }
}

export const C = (re: number, im = 0) => new Complex(re, im);
export const COS = (t: number) => C(Math.cos(t));
export const SIN = (t: number) => C(Math.sin(t));
export const EXP_I = (t: number) => Complex.fromPolar(1, t);
