// Unicode chess glyphs. We use the solid (filled) glyphs for both colors and
// distinguish white vs black purely with CSS fill + outline, so the piece shapes
// stay identical across platforms and fonts.

export const GLYPH: Record<number, string> = {
  1: '♟', // pawn
  2: '♞', // knight
  3: '♝', // bishop
  4: '♜', // rook
  5: '♛', // queen
  6: '♚', // king
}

export const PROMO_CHOICES = [5, 4, 3, 2] // queen, rook, bishop, knight
