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

// `view` is null when closed, otherwise { cursor, confirming, idleTicks }.
// `cursor` indexes the ROSTER -- the species actually owned -- not the 151
// cells. Stepping cell by cell would be 151 presses to reach the end and every
// stop but a handful would be a silhouette you cannot pick anyway; hopping
// between owned entries makes the walk as long as the collection is.
//
// Returns { view, action } where action is "swap" on the press that confirms
// one. The caller applies it; this file never touches the save.
export function stepDexView(view, event, { rosterSize = 0 } = {}) {
  if (view == null) {
    return isDexOpenGesture(event)
      ? { view: { cursor: 0, confirming: false, idleTicks: 0 }, action: null }
      : { view: null, action: null };
  }
  if (event?.key !== "KEY") return { view, action: null };

  const fresh = (over) => ({ ...view, idleTicks: 0, ...over });

  if (view.confirming) {
    switch (event.kind) {
      // Confirming is the one irreversible thing in here, so it takes the
      // deliberate gesture and the easy one cancels.
      case "double": return { view: fresh({ confirming: false }), action: "swap" };
      case "short": return { view: fresh({ confirming: false }), action: null };
      case "long": return { view: null, action: null };
      default: return { view, action: null };
    }
  }

  switch (event.kind) {
    case "short": return { view: fresh({ cursor: wrap(view.cursor + 1, rosterSize) }), action: null };
    case "double": return { view: fresh({ confirming: true }), action: null };
    case "long": return { view: null, action: null };
    default: return { view, action: null };
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

// The page the grid must show to have the cursor on it. Derived rather than
// stored, so the two can never disagree about where the cursor is.
export function pageForCursor(view, roster, pageSize, dexIndexOf) {
  const species = roster?.[view?.cursor ?? 0]?.species;
  const index = species == null ? 0 : dexIndexOf(species);
  return Math.max(0, Math.floor(index / pageSize));
}

function wrap(cursor, size) {
  const total = Math.max(1, size);
  return ((cursor % total) + total) % total;
}
