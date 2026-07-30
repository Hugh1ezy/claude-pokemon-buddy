// The capture screen. Draws the wild pokemon -- this is where the species is
// finally revealed, row 3 having deliberately withheld it -- the ball, and the
// timing bar along the bottom.
//
// Every frame is a pure function of (state, elapsed ms), with no timers of its
// own, so the loop that drives it can be tested by handing it numbers.
import { createCanvas } from "@napi-rs/canvas";

import { sliderBands } from "../pet/capture.js";
import { STEP, hpFraction } from "../pet/capture-rules.js";
import { imageDataToFrame } from "./frame.js";
import { H, INK, PAPER, W } from "./palette.js";
import { drawShadow } from "./layout.js";
import { drawSprite } from "./sprite-pipeline.js";
import { loadBuddySprite } from "./sprites.js";

const CJK = '"Zpix"';

const BAR_X = 24;
const BAR_W = W - BAR_X * 2;
const BAR_Y = 258;
const BAR_H = 26;
const HP_X = 24;
const HP_Y = 26;
const HP_H = 20;
const TITLE_Y = 248;   // just above the timing bar, at the owner's ask
const SPRITE_SLOT = 132;
const SPRITE_TOP = 68;
const GROUND_Y = SPRITE_TOP + SPRITE_SLOT;
// Narrower and flatter than the buddy panel's, because this screen has the
// title below the ground line and a full-width ellipse would run into it.
const SHADOW_RX = 46;
const SHADOW_RY = 7;
// The ellipse sits BELOW the feet rather than across them. At GROUND_Y - 6 it
// cut through the sprite's legs and read as occlusion instead of as ground, so
// the figure moved up and the shadow moved down. Widened to +12 on a second
// look: at +6 the ellipse still met the feet, and the owner wanted daylight.
//
// Because GROUND_Y is derived from SPRITE_TOP, moving the sprite carries the
// ball and this shadow with it -- the three stay one group by construction
// rather than by three edits that have to agree.
const SHADOW_Y = GROUND_Y + 12;

// The wobble, timed from its parts rather than from a total, so halving the
// rock speed cannot silently leave the phase ending mid-rock. Halved on
// 2026-07-30 at the owner's ask: 826ms a rock, where it was 413.
const WOBBLE_DROP_MS = 260;
export const WOBBLE_ROCKS = 3;
const WOBBLE_ROCK_MS = 826;

export const PHASE = {
  AIM: "aim",
  THROW: "throw",
  HIT: "hit",
  WOBBLE: "wobble",
  CAUGHT: "caught",
  RETRY: "retry",
  ESCAPED: "escaped",
};

// Animation lengths, in ms. The throw and the wobble are the whole reason the
// outcome is not just a line of text: the owner asked for the GBA beat --
// ball flies, ball rocks, and only then do you find out.
export const PHASE_MS = {
  [PHASE.THROW]: 480,
  [PHASE.HIT]: 620,
  [PHASE.WOBBLE]: WOBBLE_DROP_MS + WOBBLE_ROCKS * WOBBLE_ROCK_MS,
  [PHASE.CAUGHT]: 1400,
  [PHASE.RETRY]: 900,
  [PHASE.ESCAPED]: 1400,
};

export async function renderCaptureFrame({ species, phase, elapsed = 0, state, zh, rules, kind, before }) {
  const canvas = createCanvas(W, H);
  const g = canvas.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.fillStyle = PAPER;
  g.fillRect(0, 0, W, H);
  g.fillStyle = INK;

  // The HP bar animates DOWN across the hit phase rather than snapping: a bar
  // that has already dropped by the time you look at it does not read as
  // damage, it reads as a different number.
  const shown = phase === PHASE.HIT && before
    ? hpFraction(before) + (hpFraction(rules) - hpFraction(before)) * Math.min(1, elapsed / PHASE_MS[PHASE.HIT])
    : hpFraction(rules ?? { hp: 1 });
  if (phase !== PHASE.CAUGHT && phase !== PHASE.ESCAPED) drawHpBar(g, shown, zh);

  g.font = `800 14px ${CJK}`;
  const title = titleFor(phase, zh, kind, rules);
  g.fillText(title, Math.round((W - g.measureText(title).width) / 2), TITLE_Y);

  const sprite = await loadBuddySprite(species);
  const spriteX = Math.round((W - SPRITE_SLOT) / 2);

  // The pokemon is hidden from the moment the ball lands until the outcome is
  // known -- that is what makes the wobble suspenseful rather than decorative.
  const hidden = phase === PHASE.WOBBLE || phase === PHASE.CAUGHT;
  // The ground. Same dithered ellipse the buddy panel puts under the buddy, so
  // the two screens agree about what a floor looks like. Drawn before whatever
  // stands on it, and kept below the sprite's feet and above the title.
  if (!hidden) drawShadow(g, W / 2, SHADOW_Y, SHADOW_RX, SHADOW_RY);
  if (!hidden) {
    const flee = phase === PHASE.ESCAPED ? Math.round((elapsed / PHASE_MS[PHASE.ESCAPED]) * 90) : 0;
    // A struck pokemon flinches sideways -- the cheapest hit feedback that is
    // not a colour change, on a panel with no colours to change.
    const flinch = phase === PHASE.HIT ? Math.round(Math.sin(elapsed / 45) * 5 * (1 - Math.min(1, elapsed / PHASE_MS[PHASE.HIT]))) : 0;
    drawSprite(g, sprite.gray, {
      x: spriteX + flinch, y: SPRITE_TOP - flee, maxSize: SPRITE_SLOT, srcW: sprite.w, srcH: sprite.h,
    });
  }

  if (phase === PHASE.THROW) drawThrown(g, elapsed / PHASE_MS[PHASE.THROW], kind);
  if (phase === PHASE.HIT) drawSparks(g, W / 2, SPRITE_TOP + SPRITE_SLOT / 2, elapsed);
  if (phase === PHASE.WOBBLE) {
    const { fall, tilt } = wobbleAt(elapsed);
    drawShadow(g, W / 2, SHADOW_Y, BALL_R, SHADOW_RY);
    drawBall(g, W / 2, GROUND_Y - BALL_R + 4 - fall, tilt);
  }
  if (phase === PHASE.CAUGHT) {
    drawShadow(g, W / 2, SHADOW_Y, BALL_R, SHADOW_RY);
    drawBall(g, W / 2, GROUND_Y - BALL_R + 4, 0);
    drawCaughtStars(g, W / 2, GROUND_Y - BALL_R + 4, elapsed);
  }
  if (phase === PHASE.RETRY) drawBurst(g, W / 2, GROUND_Y - BALL_R + 4, elapsed / PHASE_MS[PHASE.RETRY]);

  // The timing bar stays up through every phase except the two that end the
  // encounter, so the piece does not vanish and reappear between throws.
  if (phase !== PHASE.CAUGHT && phase !== PHASE.ESCAPED) {
    drawBar(g, state, phase === PHASE.AIM ? elapsed : state.frozenAt ?? elapsed);
  }

  return imageDataToFrame(g.getImageData(0, 0, W, H), W, H);
}

// Says which throw this is, because the first two are worth spending
// deliberately: they are the practice that makes the third hittable.
function titleFor(phase, zh, kind, rules) {
  switch (phase) {
    case PHASE.CAUGHT: return `捉到了！${zh}`;
    case PHASE.RETRY: return "差一点⋯⋯再来！";
    case PHASE.ESCAPED: return `${zh} 跑掉了`;
    default:
      if (kind !== STEP.ATTACK) return "投球！";
      // While aiming, this is the throw you are ABOUT to make; once it has
      // landed, `thrown` has already advanced, so the hit frame must name the
      // one that just connected or it counts to 3 out of 2.
      return `攻击 ${clampAttack(phase === PHASE.AIM ? (rules?.thrown ?? 0) + 1 : rules?.thrown ?? 1)}/2`;
  }
}

function clampAttack(n) {
  return Math.min(2, Math.max(1, n));
}

// Top of the screen, the owner's placement. Drawn as an outline that empties
// left to right so a full bar and an empty one differ by area rather than by a
// number nobody can read at this size.
function drawHpBar(g, fraction, zh) {
  const w = W - HP_X * 2;
  g.fillStyle = INK;
  g.fillRect(HP_X, HP_Y, w, 2);
  g.fillRect(HP_X, HP_Y + HP_H - 2, w, 2);
  g.fillRect(HP_X, HP_Y, 2, HP_H);
  g.fillRect(HP_X + w - 2, HP_Y, 2, HP_H);

  const filled = Math.round((w - 8) * Math.max(0, Math.min(1, fraction)));
  g.fillRect(HP_X + 4, HP_Y + 4, filled, HP_H - 8);

  g.font = `700 12px ${CJK}`;
  g.fillText(zh, HP_X, HP_Y - 6);
}

// A: the fixed line. B: the solid block you have to hit. C: the outline around
// it that costs the throw but not the encounter.
function drawBar(g, state, t) {
  const bands = sliderBands(state, t);
  const at = (fraction) => Math.round(BAR_X + fraction * BAR_W);

  g.fillStyle = INK;
  g.fillRect(BAR_X, BAR_Y, BAR_W, 2);
  g.fillRect(BAR_X, BAR_Y + BAR_H - 2, BAR_W, 2);
  g.fillRect(BAR_X, BAR_Y, 2, BAR_H);
  g.fillRect(BAR_X + BAR_W - 2, BAR_Y, 2, BAR_H);

  // C and B fill the bar's full height rather than sitting inset in it, so the
  // piece reads as part of the bar instead of as something floating in it.
  const c0 = at(bands.c[0]);
  const c1 = at(bands.c[1]);
  g.fillRect(c0, BAR_Y, c1 - c0, 2);
  g.fillRect(c0, BAR_Y + BAR_H - 2, c1 - c0, 2);
  g.fillRect(c0, BAR_Y, 2, BAR_H);
  g.fillRect(c1 - 2, BAR_Y, 2, BAR_H);

  const b0 = at(bands.b[0]);
  g.fillRect(b0, BAR_Y, Math.max(2, at(bands.b[1]) - b0), BAR_H);

  // A last, and exactly as tall as the bar -- it used to overhang both ends,
  // which made it read as a separate marker rather than as a position in the
  // bar. Drawn last so it stays visible on top of a solid B.
  const a = at(bands.target);
  g.fillRect(a - 1, BAR_Y, 3, BAR_H);
}

// Twice the old size, and drawn as an actual pokeball rather than a dot with a
// stripe: the top half solid, the BOTTOM HALF WHITE, a band across the middle
// and a button in it. On a 1-bit panel the white lower half is what makes it
// read as a ball at a glance -- an all-black circle reads as a hole.
const BALL_R = 26;

function drawBall(g, cx, cy, tilt) {
  const r = BALL_R;
  g.save();
  g.translate(cx, cy);
  g.rotate(tilt);

  // White lower half first, then the black upper half over it.
  g.fillStyle = PAPER;
  g.beginPath();
  g.arc(0, 0, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = INK;
  g.beginPath();
  g.arc(0, 0, r, Math.PI, 0);
  g.fill();

  // The outline has to be drawn explicitly: without it the white half has no
  // edge against the white page and the ball looks cut in half.
  g.strokeStyle = INK;
  g.lineWidth = 3;
  g.beginPath();
  g.arc(0, 0, r - 1, 0, Math.PI * 2);
  g.stroke();

  g.fillStyle = INK;
  g.fillRect(-r, -3, r * 2, 6);

  const button = Math.round(r * 0.34);
  g.fillStyle = INK;
  g.beginPath();
  g.arc(0, 0, button + 3, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = PAPER;
  g.beginPath();
  g.arc(0, 0, button, 0, Math.PI * 2);
  g.fill();

  g.restore();
  g.fillStyle = INK;
}

// The ball falls to the ground, then rocks three times -- one rock is one
// check, which is the beat the games use and what the owner asked for. Discrete
// rather than a decaying sine: a continuous wobble reads as "it is vibrating",
// where three separate rocks with a pause between them read as three questions
// being asked. It ends upright so the caught frame does not jump.
export function wobbleAt(elapsed) {
  const drop = Math.min(1, elapsed / WOBBLE_DROP_MS);
  if (drop < 1) {
    // Ease in, so it accelerates into the ground rather than drifting down.
    return { fall: (1 - drop * drop) * 46, tilt: 0, rock: 0 };
  }

  const each = WOBBLE_ROCK_MS;
  const since = elapsed - WOBBLE_DROP_MS;
  const index = Math.min(WOBBLE_ROCKS - 1, Math.floor(since / each));
  const within = (since - index * each) / each;

  // Rock for the first 65% of each slot and sit still for the rest: the pause
  // is what separates one check from the next.
  const swing = within < 0.65 ? Math.sin((within / 0.65) * Math.PI * 2) : 0;
  // Alternate which way each rock leads, so three rocks look like three, not
  // like one motion repeated.
  return { fall: 0, tilt: swing * 0.42 * (index % 2 === 0 ? 1 : -1), rock: index + 1 };
}

// A ball for the capture, a wedge for an attack. They fly the same arc on
// purpose -- the timing you learn on the attacks has to be the timing that
// works on the throw, and a different flight would teach the wrong beat.
function drawThrown(g, u, kind) {
  const from = { x: 40, y: GROUND_Y - 4 };
  const to = { x: W / 2, y: SPRITE_TOP + SPRITE_SLOT / 2 };
  const x = Math.round(from.x + (to.x - from.x) * u);
  const y = Math.round(from.y + (to.y - from.y) * u - Math.sin(u * Math.PI) * 70);

  if (kind === STEP.ATTACK) drawStrike(g, x, y, u);
  else drawBall(g, x, y, u * Math.PI * 3);
}

// A chevron pointing where it is going, which reads as motion at 1 bit where a
// circle just reads as a dot.
function drawStrike(g, cx, cy, u) {
  const r = 9;
  g.fillStyle = INK;
  for (let i = 0; i < r; i += 1) {
    const t = i / r;
    g.fillRect(cx - r + i, cy - Math.round(r * (1 - t)), 2, Math.round(2 * r * (1 - t)) + 2);
  }
  void u;
}

// Three five-pointed stars ABOVE the ball, not a ring around it -- the owner
// was specific, and it is what the games do: the ball sits still and the stars
// pop over it.
function drawCaughtStars(g, cx, cy, elapsed) {
  const u = Math.min(1, elapsed / 620);
  const rise = 10 * u;
  const spots = [[-26, -30], [0, -40], [26, -30]];

  g.fillStyle = INK;
  spots.forEach(([dx, dy], i) => {
    // Staggered, so they appear one after another rather than all at once.
    const t = Math.min(1, Math.max(0, u * 1.6 - i * 0.2));
    if (t <= 0) return;
    drawStar5(g, cx + dx, Math.round(cy + dy - rise), Math.round(4 + t * 5));
  });
}

// A real five-pointed star: ten alternating points around a circle, filled.
// The earlier version was a four-armed sparkle, which at this size reads as a
// plus sign rather than as a star.
function drawStar5(g, cx, cy, r) {
  if (r < 3) return;
  const inner = r * 0.42;
  g.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? r : inner;
    // -PI/2 puts a point straight up, which is what makes it read as a star
    // rather than as a cog.
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
}

// Impact on an attack. Deliberately NOT stars: stars mean "caught" on this
// screen, and an attack that looked like a capture would be a lie.
function drawSparks(g, cx, cy, elapsed) {
  const u = Math.min(1, elapsed / 380);
  const spread = 12 + u * 30;
  g.fillStyle = INK;
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * Math.PI * 2 + 0.4;
    const x = Math.round(cx + Math.cos(angle) * spread);
    const y = Math.round(cy + Math.sin(angle) * spread);
    const len = Math.max(1, Math.round(6 * (1 - u)));
    g.fillRect(x - 1, y - len, 2, len * 2);
  }
}

function drawBurst(g, cx, cy, u) {
  const spread = 6 + u * 30;
  g.fillStyle = INK;
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * Math.PI * 2;
    const x = Math.round(cx + Math.cos(angle) * spread);
    const y = Math.round(cy + Math.sin(angle) * spread);
    g.fillRect(x - 2, y - 2, 4, 4);
  }
}

export const CAPTURE_GEOMETRY = { BAR_X, BAR_W, BAR_Y, BAR_H, SPRITE_TOP, SPRITE_SLOT };
