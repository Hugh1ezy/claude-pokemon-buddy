import { GLYPHS, renderGlyph, SIZE } from "./gen-ganzhi-font.mjs";

const rowBytes = Math.ceil(SIZE / 8);
let anyIssue = false;
GLYPHS.forEach((ch, i) => {
  const bitmap = renderGlyph(ch);
  const rowHasInk = (y) => {
    for (let x = 0; x < SIZE; x++) {
      const byte = bitmap.bytes[y * rowBytes + (x >> 3)];
      if ((byte >> (7 - (x & 7))) & 1) return true;
    }
    return false;
  };
  const colHasInk = (x) => {
    for (let y = 0; y < SIZE; y++) {
      const byte = bitmap.bytes[y * rowBytes + (x >> 3)];
      if ((byte >> (7 - (x & 7))) & 1) return true;
    }
    return false;
  };
  const top = rowHasInk(0);
  const bottom = rowHasInk(SIZE - 1);
  const left = colHasInk(0);
  const right = colHasInk(SIZE - 1);
  if (top || bottom || left || right) {
    anyIssue = true;
    console.log(`glyph ${i} (${ch}): edge ink -- top=${top} bottom=${bottom} left=${left} right=${right}`);
  }
});
if (!anyIssue) console.log("no glyph touches the canvas edge -- no clipping");
