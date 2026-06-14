export type Difficulty = "easy" | "medium" | "hard";

export interface Problem {
  name: string;
  difficulty: Difficulty;
  /** one-line note on which variant of the pattern it exercises */
  note?: string;
  /** a nudge in the right direction without giving the approach away */
  hint?: string;
  /** the guided approach — how to actually attack it with this pattern */
  approach?: string;
}

export interface ComplexityRow {
  approach: string;
  time: string;
  space: string;
}

export interface Pattern {
  /** url slug */
  id: string;
  name: string;
  /** emoji used as a quick visual anchor */
  icon: string;
  /** accent color (hex) for the pattern */
  color: string;
  /** one-line hook */
  tagline: string;
  /** ordering in the roadmap */
  order: number;
  /** rough difficulty of learning the pattern */
  level: "foundational" | "core" | "advanced";

  /** The "aha" — why the pattern works, in plain language. Paragraphs. */
  intuition: string[];
  /** The mental model: a single sticky metaphor. */
  mentalModel: string;
  /** Trigger phrases — "when you see ... reach for this". */
  recognize: string[];
  /** Step-by-step of how the technique runs. */
  howItWorks: string[];
  /** Canonical code template (Python). */
  template: { lang: string; label: string; code: string };
  /** Complexity comparison rows (brute force vs pattern). */
  complexity: ComplexityRow[];
  /** Gotchas that trip people up. */
  pitfalls: string[];
  /** Representative NeetCode-150 problems (illustrative, not exhaustive). */
  problems: Problem[];
  /** ids of related patterns. */
  related: string[];
  /** key of an interactive visualizer, if any. */
  visualizer?: string;
}
