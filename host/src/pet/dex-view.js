// What the pokedex screen is showing, and how a button press moves it. Pure and
// transient: this is UI state, not save state, so it never reaches state.json
// and a restart simply closes the screen.
//
// Gestures, set by the owner 2026-07-30:
//
//   KEY short    move the cursor to the next owned species on this page
//   KEY long     turn the page
//   KEY double   open the confirm screen / confirm the swap
//   BOOT short   back to the buddy panel
//
// BOOT short rather than BOOT double, and this is NOT a preference. The
// firmware acts on BOOT double **by itself** (main.cpp, enter_local_clock_mode)
// -- it stops the WiFi radio and drops to the clock face without asking the
// host. A BOOT double here would therefore exit the pokedex INTO power-save
// with the radio off, and the host could not paint its way back out because
// there is no longer a link to paint over. BOOT short does nothing device-side
// in normal mode, so it is the one that can be borrowed safely. Moving return
// to BOOT double needs a firmware change (and a reflash), not a host change.
export const DEX_OPEN_GESTURE = { key: "KEY", kind: "double" };
export const DEX_CLOSE_GESTURE = { key: "BOOT", kind: "short" };

export function isDexOpenGesture(event) {
  return event?.key === DEX_OPEN_GESTURE.key && event?.kind === DEX_OPEN_GESTURE.kind;
}

export function isDexCloseGesture(event) {
  return event?.key === DEX_CLOSE_GESTURE.key && event?.kind === DEX_CLOSE_GESTURE.kind;
}

// `view` is null when closed, otherwise { page, cursor, confirming, idleTicks }.
//
// The page is explicit and the cursor is scoped to it. The cursor indexes the
// OWNED species on the current page, not the 60 cells: all but a handful of
// cells are silhouettes that cannot be picked, and stepping through them would
// be 151 presses to cross the dex. Turning the page is its own gesture so the
// whole 151 can still be browsed, including pages holding nothing you own.
//
// Returns { view, action }; action is "swap" on the press that confirms one.
// The caller applies it -- this file never touches the save.
export function stepDexView(view, event, { pages = 1, pageCursorCount = 0 } = {}) {
  if (view == null) {
    return isDexOpenGesture(event)
      ? { view: { page: 0, cursor: 0, confirming: false, idleTicks: 0 }, action: null }
      : { view: null, action: null };
  }
  if (isDexCloseGesture(event)) return { view: null, action: null };
  if (event?.key !== "KEY") return { view, action: null };

  const fresh = (over) => ({ ...view, idleTicks: 0, ...over });

  if (view.confirming) {
    switch (event.kind) {
      // Confirming is the one irreversible thing in here, so it takes the
      // deliberate gesture and the easy one cancels.
      case "double": return { view: fresh({ confirming: false }), action: "swap" };
      case "short": return { view: fresh({ confirming: false }), action: null };
      default: return { view, action: null };
    }
  }

  switch (event.kind) {
    case "short": return { view: fresh({ cursor: wrap(view.cursor + 1, pageCursorCount) }), action: null };
    // A new page gets a fresh cursor rather than carrying the old index across:
    // index 3 of one page has nothing to do with index 3 of the next, and a
    // carried index would land on an arbitrary species or off the end.
    case "long": return { view: fresh({ page: wrap(view.page + 1, pages), cursor: 0 }), action: null };
    // Nothing to confirm on a page holding nothing you own.
    case "double": return pageCursorCount > 0
      ? { view: fresh({ confirming: true }), action: null }
      : { view: fresh({}), action: null };
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

function wrap(value, size) {
  const total = Math.max(1, size);
  return ((value % total) + total) % total;
}
