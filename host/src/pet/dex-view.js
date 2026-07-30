// What the pokedex screen is showing, and how a button press moves it. Pure and
// transient: this is UI state, not save state, so it never reaches state.json
// and a restart simply closes the screen.
//
// The gesture budget is small. BOOT belongs entirely to power-save
// (docs/local-clock-mode.md) and must not be borrowed -- reusing it is exactly
// the mistake that killed the radio on 07-27. That leaves KEY, whose short
// press is already the greet gesture and the working-day bond credit, and whose
// long press is already the evolution confirm. KEY *double* was the one gesture
// the firmware sends, the dispatcher already queues, and nothing consumed.
export const DEX_OPEN_GESTURE = { key: "KEY", kind: "double" };

export function isDexOpenGesture(event) {
  return event?.key === DEX_OPEN_GESTURE.key && event?.kind === DEX_OPEN_GESTURE.kind;
}

// `view` is null when the screen is closed, otherwise { page }.
// Returns the next view, again null for closed.
//
// While it is open this takes over KEY entirely -- short turns the page instead
// of greeting, long returns instead of confirming an evolution. That is the
// point of a modal screen, and it is why the auto-close below matters: a
// forgotten pokedex would otherwise swallow the greet gesture indefinitely.
export function stepDexView(view, event, { pages = 1 } = {}) {
  if (view == null) return isDexOpenGesture(event) ? { page: 0, idleTicks: 0 } : null;
  if (event?.key !== "KEY") return view;

  switch (event.kind) {
    case "short":
    case "double":
      return { page: wrap(view.page + 1, pages), idleTicks: 0 };
    case "long":
      return null;
    default:
      return view;
  }
}

// Closes itself after a stretch with no input. Without this, walking away with
// the screen up leaves the panel stuck on the pokedex -- the buddy gone, the
// clock gone, and the greet gesture captured -- until someone presses a button.
// Ticks rather than milliseconds because the tick is the only clock this state
// is ever advanced by.
export const DEX_IDLE_TICKS_BEFORE_CLOSE = 3;   // ~3 minutes at the 60s tick

export function ageDexView(view, { limit = DEX_IDLE_TICKS_BEFORE_CLOSE } = {}) {
  if (view == null) return null;
  const idleTicks = (view.idleTicks ?? 0) + 1;
  return idleTicks >= limit ? null : { ...view, idleTicks };
}

function wrap(page, pages) {
  const total = Math.max(1, pages);
  return ((page % total) + total) % total;
}
