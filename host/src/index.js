import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { cryAudioId } from "./pet/cry-audio.js";
import { cryFor } from "./pet/cries.js";
import { loadConfig, saveConfig } from "./config.js";
import { resolveEvolution } from "./pet/evolution.js";
import { rollPersonality } from "./pet/personality.js";
import { applyBondTick, applyOfflineBond, heartsFromHalves } from "./pet/bond.js";
import { dexProgress, normalizeDex, recordCapture, recordSeen } from "./pet/dex.js";
import { stepEncounter } from "./pet/encounter.js";
import { buildEncounterContext } from "./pet/encounter-context.js";
import { loadEncounterTable } from "./pet/encounter-table.js";
import { SPECIES_DEX, isDexSpecies, zhName } from "./pet/species-meta.js";
import { isFrozenSpecies, pinFrozenGrowth, rosterEntries, swapActiveBuddy } from "./pet/roster.js";
import { applyDailyGrowth, deriveMood, expToNextLevel, PARAMS } from "./pet/sim.js";
import { buildUsedDays, settleDays } from "./pet/settlement.js";
import { applyPetTransitions, drainEvolutionIntents, ensurePet, evolutionContext } from "./pet/transitions.js";
import { runOnboarding, runTutorial } from "./pet/onboarding.js";
import { createBuddyAnimator } from "./render/buddy-animator.js";
import { playEvolutionAnimation } from "./render/evolution-anim.js";
import { renderFrame } from "./render/frame.js";
import { playSignatureAnimation } from "./render/signature-anim.js";
import { loadBuddySprite } from "./render/sprites.js";
import { loadState, saveState } from "./state.js";
import { createSaveSync } from "./save-sync.js";
import { createTransport } from "./transport/index.js";
import { captureParams } from "./pet/capture-tuning.js";
import { runCaptureSession } from "./pet/capture-session.js";
import { ageDexView, isDexCloseGesture, isDexOpenGesture, stepDexView } from "./pet/dex-view.js";
import { ENCOUNTER_DEFAULTS } from "./pet/encounter.js";
import { resolvePlace } from "./place.js";
import { PHASE, PHASE_MS, renderCaptureFrame } from "./render/capture-screen.js";
import { DEX_PAGE_SIZE, dexPageCount, renderDexConfirm, renderDexPage } from "./render/dex-screen.js";
import { SOUND } from "./transport/proto.js";
import { loadRateLimits } from "./rate-limits.js";
import { pollUsageOnce } from "./usage-poll.mjs";
import { loadUsageSnapshot, usageForDisplay } from "./usage.js";
import { startWebServer } from "./web/server.js";
import { validateSettings } from "./web/settings.js";
import { toDashboardRuntimeView } from "./web/viewmodel.js";
import { makeWeather } from "./weather.js";

export { ensurePet } from "./pet/transitions.js";
export { dashboardSensors } from "./web/viewmodel.js";

const DEFAULT_WEATHER = {
  cond: "多云",
  temp: 19,
  feels: 17,
  hi: 22,
  lo: 14,
  precip: 30,
  wind: 11,
  humidity: 64,
  degraded: true,
};

// Overlay official statusline rate-limits (5h/week %/reset) onto the ccusage
// snapshot, which now only sources cost/token totals.
//
// Deliberately no local estimate here: ccusage's totalTokens counts cache reads,
// which run one to two orders of magnitude above what a plan quota actually
// charges, so any percentage derived from it would peg at 100% and drag the
// mood to 力竭 permanently. A "--" that means "unknown" beats a number that
// means nothing.
export function mergeUsage(ccusageUsage, rateLimits) {
  return {
    ...ccusageUsage,
    p5h: rateLimits.p5h,
    pweek: rateLimits.pweek,
    resets5h: rateLimits.resets5h,
    resetsWeek: rateLimits.resetsWeek,
    official: rateLimits.official,
    rateStale: rateLimits.stale,
  };
}

// Days since 1970-01-01, counted from the LOCAL calendar date (not a raw
// UTC/timezone-shifted epoch division) -- matches the representation the
// firmware's ganzhi boundary table uses (see gen-ganzhi-table.py), so the
// device can look up today's date directly with no timezone math of its own.
export function epochDayFor(date) {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

export function shouldPlaySignature(event, pet) {
  return event?.key === "KEY" && event?.kind === "short" && pet?.readyToEvolve === false;
}

export function shouldQueueButtonForTick(event) {
  return event?.key === "KEY" && (
    event.kind === "short" ||
    event.kind === "long" ||
    event.kind === "double"
  );
}

// 串行化动作：tick 与招牌经同一队列互斥，杜绝 tick 帧插进招牌帧序列之间。
export function createActionQueue() {
  let chain = Promise.resolve();
  return {
    run(fn) {
      const result = chain.then(fn);
      chain = result.then(() => {}, () => {});
      return result;
    },
  };
}

export function createEvolutionIntentQueue() {
  const intents = [];
  return {
    push(intent) {
      intents.push(intent);
    },
    drain() {
      return intents.splice(0);
    },
  };
}

export function createButtonDispatcher({
  transport,
  getPet = () => undefined,
  getModel = () => null,
  actions = createActionQueue(),
  animator = { pause() {}, resume() {} },
  playSignature = playSignatureAnimation,
  onSignatureError = () => {},
  // The pokedex screen. Handled here rather than in the tick because the tick
  // is 60 seconds wide: routing a button through it would mean pressing KEY and
  // waiting up to a minute for the screen, which is not a screen, it is a
  // delivery. The signature animation is on this same immediate path for the
  // same reason.
  dexSource = null,           // () => ({ dex, progress }) -- null disables the screen
  renderDex = renderDexPage,
  renderConfirm = renderDexConfirm,
  swapRequests = { push() {} },
  // Cuts the tick's sleep short so a queued swap lands now rather than in up to
  // a minute. The tick is still the only thing that writes the pet -- this only
  // changes WHEN it next runs, not who owns the save. Owner, 2026-07-31:
  // confirming a swap dropped him back on the panel still showing the old
  // buddy, which reads as "nothing happened".
  wakeTick = () => {},
  // The capture minigame. Results are queued rather than applied: the tick owns
  // the pet, and a second writer to the save is exactly the kind of thing that
  // loses a buddy. Same shape as the evolution intents.
  captureResults = null,
  renderCapture = renderCaptureFrame,
  captureSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  captureNow = () => Date.now(),
  logger = null,
} = {}) {
  const tickQueue = [];
  let signatureInFlight = false;
  let dexView = null;
  let screenHeld = false;
  let captureActive = false;
  // `offeredAt` of an encounter this session has already played out. Session
  // state, not save state: it only has to cover the gap between the capture
  // ending and the tick clearing the offer, and a restart re-reads a save the
  // tick has by then already cleaned up.
  let resolvedOfferAt = null;
  let capturePress = false;
  let captureAbort = false;
  const off = transport?.onButton?.((event) => {
    // The firmware logs every press it sends; the host logged nothing, so
    // "I pressed KEY and nothing happened" had no evidence on this side at
    // all -- no way to separate a press that never arrived from one that
    // arrived and was mishandled. Logged from inside the dispatcher's single
    // listener on purpose: a second transport.onButton subscription just to
    // watch traffic would break the one-resident-listener invariant that RH3
    // pins down.
    logger?.log?.(`button ${event?.key} ${event?.kind}`);

    // Queue first, unconditionally. A short KEY press is BOTH the "greet"
    // gesture and the working-day bond credit (pet/bond.js reads it as
    // `clicked`), and the signature branch used to return before queueing --
    // so on a weekday the hourly half heart could never be earned no matter how
    // many times the button was pressed. The tick's own short-press handling is
    // gated on readyToEvolve being TRUE, which is exactly when the signature
    // does not play, so the two can never both act on the same press.
    if (shouldQueueButtonForTick(event)) tickQueue.push(event);

    // A capture in progress owns KEY entirely: the press IS the throw, and the
    // session loop reads this flag rather than being called, so a press during
    // the throw animation cannot start a second one.
    if (captureActive) {
      if (event?.key === "KEY") capturePress = true;
      // BOOT short is the universal way back to the buddy panel, from any screen
      // the host is holding. It leaves the offer standing -- see the session.
      else if (isDexCloseGesture(event)) captureAbort = true;
      return;
    }

    // KEY double is context-sensitive, and row 3 says which it will be: with a
    // wild pokemon on offer it goes to the capture screen, otherwise to the
    // pokedex. One gesture, because there is only one spare -- BOOT belongs to
    // power-save and KEY short/long are already the greet and the evolution
    // confirm.
    if (captureResults && isDexOpenGesture(event) && liveEncounter()) {
      startCapture();
      return;
    }

    // The pokedex takes KEY over completely while it is up -- short turns the
    // page instead of greeting, long returns instead of confirming. Checked
    // before the signature branch so an open screen is not painted over by a
    // greet animation the press was never meant for.
    if (dexSource && (dexView != null || isDexOpenGesture(event))) {
      handleDexButton(event);
      return;
    }

    if (!shouldPlaySignature(event, getPet())) return;
    if (signatureInFlight) return;
    const pressModel = getModel();
    if (!pressModel) return;
    signatureInFlight = true;
    actions.run(async () => {
      animator.pause();
      try { await playSignature({ transport, model: pressModel }); }
      finally { animator.resume(); }
    }).catch(onSignatureError).finally(() => { signatureInFlight = false; });
  });

  // Tell the device whether a HOST screen is up, so it can stop answering KEY
  // with the buddy's cry. The firmware has no idea whose screen is on the panel,
  // and both of the screens here answer KEY with something of their own:
  //
  // - the pokedex, where browsing is one KEY short per row, so every step of the
  //   cursor fired a cry underneath a screen that is supposed to speak only when
  //   you zoom in (owner heard it on hardware, 2026-08-03 evening);
  // - the capture screen, where KEY is the throw button. That one used to be
  //   covered by `g_bgm_active` as a side effect of the music being queued, so
  //   removing the music (2026-08-04, owner's call) would have put a cry on every
  //   throw. Covered here instead, which is the flag that actually means it.
  //
  // The two are mutually exclusive -- an open capture swallows every press before
  // the pokedex branch is reached -- so one boolean is enough for both.
  //
  // Called after EVERY assignment to dexView and to captureActive, including the
  // idle self-close and the render-failure unwind: the flag has a matching off,
  // and a missed off leaves the button silent long after the screen is gone. Sent
  // only on a transition, since the press that opens (KEY double) and the one that
  // closes (KEY long) do not cry in the firmware anyway -- there is no race to
  // win, only a state to keep honest.
  function syncScreenHold() {
    const held = dexView != null || captureActive;
    if (held === screenHeld) return;
    screenHeld = held;
    transport.setHostScreen?.(held);
  }

  // Dex page a species sits on. SPECIES_DEX is 1-based; the grid is not.
  function dexPageOf(species) {
    return Math.floor(((SPECIES_DEX[species] ?? 1) - 1) / DEX_PAGE_SIZE);
  }

  function liveEncounter() {
    const pet = getPet();
    const species = pet?.encounter?.species;
    if (typeof species !== "string" || !isDexSpecies(species)) return null;
    const offeredAt = Number(pet.encounter.offeredAt);
    if (!Number.isFinite(offeredAt)) return null;
    // An offer this session has already played is over, whatever the save still
    // says. The tick is what clears it and the tick is 60 seconds wide, so
    // without this the notice stays up after a catch and the same pokemon can
    // be caught again -- which is exactly what happened on 2026-07-31, twice
    // into the same collection. Keyed on offeredAt so the NEXT offer of the
    // same species is a different encounter and plays normally.
    if (resolvedOfferAt === offeredAt) return null;
    const left = offeredAt + ENCOUNTER_DEFAULTS.offerMs - captureNow();
    return left > 0
      ? { species, offeredAt, offerMsLeft: left, test: pet.encounter.test === true }
      : null;
  }

  function startCapture() {
    const offer = liveEncounter();
    if (!offer || captureActive) return;
    captureActive = true;
    // Before the first frame and before any press can arrive: KEY on this screen
    // is the throw, and the device has to already know not to cry on it.
    syncScreenHold();
    capturePress = false;
    captureAbort = false;

    actions.run(async () => {
      animator.pause();
      try {
        const result = await runCaptureSession({
          species: offer.species,
          zh: zhName(offer.species),
          params: captureParams(offer.species),
          render: renderCapture,
          push: (frame) => transport.push(frame),
          now: captureNow,
          sleep: captureSleep,
          pressed: () => capturePress,
          takePress: () => { capturePress = false; },
          aborted: () => captureAbort,
          phases: PHASE_MS,
          PHASE,
          playSound: (id) => transport.playSound?.(id),
          logger,
        });
        if (result.outcome !== "aborted") {
          captureResults.push({ species: offer.species, outcome: result.outcome, test: offer.test });
          // Closed here rather than after the tick writes the save: the whole
          // point is to stop the gap between the two being playable. Backing
          // out (`aborted`) deliberately does not, because nothing was thrown
          // and the offer is meant to still be there.
          resolvedOfferAt = offer.offeredAt;
          wakeTick();
        }
        logger?.log?.(`capture: ${zhName(offer.species)} ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`);
      } finally {
        captureActive = false;
        // In the `finally` for the same reason the animator resume is: every way
        // out of the session -- caught, escaped, aborted, or a renderer that threw
        // -- has to hand KEY back to the buddy, or the button stays silent on the
        // panel until the next reconnect.
        syncScreenHold();
        animator.resume();
      }
    }).catch((error) => {
      logger?.warn?.(`capture screen failed: ${errorReason(error)}`);
    });
  }

  function handleDexButton(event) {
    const source = dexSource();
    const roster = rosterEntries(source?.dex ?? {});
    const was = dexView;
    const { view: next, action } = stepDexView(dexView, event, {
      pages: dexPageCount(source?.progress?.dexTotal ?? 0),
      pageCursorCount: onPage(roster, was?.page ?? 0).length,
    });
    if (next === was && action == null) return;

    // A species cries when you ZOOM IN on it, not when the cursor passes over
    // it. Owner's call, 2026-08-03, after living with the other way round:
    // browsing is a press per species, so a cry per press turns walking the page
    // into a stack of half-played cries that never catches up with the cursor.
    // Opening the zoom is a deliberate "show me this one", and it is the one
    // press that has a sound to itself.
    //
    // Fires on the TRANSITION into the confirm view, not on being in it, so
    // re-rendering the same screen is silent. Sent as PLAY rather than via
    // setActiveCry, which would rewrite what the KEY button plays and outlive
    // the screen.
    //
    // Only owned species are in `roster`, so an undiscovered silhouette is
    // silent -- which is the point: hearing one before finding it would give it
    // away, and the black rows are not selectable anyway.
    const zoomed = Boolean(next?.confirming) && !was?.confirming;
    const zoomSpecies = zoomed ? onPage(roster, next.page)[next.cursor]?.species ?? null : null;
    if (zoomSpecies) {
      const selectedCry = cryAudioId(zoomSpecies);
      if (selectedCry != null) transport.playSound?.(selectedCry);
    }

    dexView = next;
    syncScreenHold();

    // Read before the queue runs: `action` is decided against the roster the
    // press was made against, and a tick could land in between.
    const chosen = action === "swap" ? onPage(roster, was?.page ?? 0)[was?.cursor ?? 0] : null;

    actions.run(async () => {
      if (chosen && !chosen.active) {
        swapRequests.push({ species: chosen.species });
        logger?.log?.(`pokedex: swapping to ${zhName(chosen.species)}`);
        wakeTick();
      }
      if (next == null) {
        // Nothing repaints the panel here: resuming the animator does it within
        // one frame (333ms), and duplicating the tick's render just to be 300ms
        // quicker would be a second place for the two to disagree.
        animator.resume();
        return;
      }
      if (was == null) animator.pause();
      await transport.push(await renderDexScreen(next, roster, source));
    }).catch((error) => {
      logger?.warn?.(`pokedex screen failed: ${errorReason(error)}`);
      // Do not leave the animator parked on a screen that failed to draw.
      if (dexView != null) { dexView = null; syncScreenHold(); animator.resume(); }
    });
  }

  // The owned species that fall on a given page, in dex order. The cursor
  // indexes THIS, not the roster as a whole, so turning to a page holding
  // nothing you own simply leaves no cursor rather than pointing off it.
  function onPage(roster, page) {
    return roster.filter((entry) => dexPageOf(entry.species) === page);
  }

  function renderDexScreen(view, roster, source) {
    const entry = onPage(roster, view.page)[view.cursor] ?? null;
    if (view.confirming && entry) {
      return renderConfirm({ entry, zh: zhName(entry.species), caughtAtText: entry.caughtAt ?? "--" });
    }
    return renderDex({
      dex: source.dex,
      page: view.page,
      progress: source.progress,
      cursorSpecies: entry?.species ?? null,
    });
  }

  return {
    isDexOpen() {
      return dexView != null || captureActive;
    },
    isCaptureOpen() {
      return captureActive;
    },
    // Re-push the held screen's OWN frame, so a tick that skips the buddy panel
    // does not also leave the device with nothing.
    //
    // The bug this exists for, seen 2026-08-01: the pokedex only draws on input,
    // and `shouldPush` stops the tick from painting over it. Leave it open and
    // untouched and the device receives no frame at all -- and the firmware
    // auto-enters local-clock mode after LOCAL_CLOCK_TIMEOUT_US (120s, main.cpp),
    // i.e. after two silent ticks. The pokedex's own idle-close is three ticks,
    // so the offline clock face was GUARANTEED to appear over the screen the
    // owner was looking at, for the ~60s between the two limits. Not a race: the
    // two timeouts were simply never compared. Keep this repaint if either
    // number is ever touched, and do not narrow the gap instead -- a screen with
    // no time limit at all (the capture screen) has no gap to narrow.
    //
    // Capture is deliberately not handled here: its session pushes at 20fps for
    // as long as it is up, so it feeds the link on its own.
    async repaintHeldScreen() {
      if (dexView == null) return false;
      const source = dexSource();
      // Called from inside the tick, which already holds `actions` -- going
      // through actions.run() here would deadlock against it.
      await transport.push(await renderDexScreen(dexView, rosterEntries(source?.dex ?? {}), source));
      return true;
    },
    // Driven by the tick, which is the only clock this state has. Closing on
    // its own matters because an open screen holds the animator paused and
    // swallows the greet gesture -- walking away should not cost either.
    ageDex() {
      if (dexView == null) return false;
      const next = ageDexView(dexView);
      if (next != null) { dexView = next; return false; }
      dexView = null;
      syncScreenHold();
      animator.resume();
      logger?.log?.("pokedex closed itself after no input");
      return true;
    },
    drainTickEvents() {
      return tickQueue.splice(0);
    },
    requeueForRetry(events) {
      const retry = events
        .filter((event) => event && !event.requeued)
        .map((event) => ({ ...event, requeued: true }));
      tickQueue.unshift(...retry);
      return retry.length;
    },
    stop() {
      off?.();
    },
  };
}

export async function runOneTick({
  usage,
  weather,
  room,
  statePath = "out/state.json",
  framePath = "out/frame.png",
  now = new Date(),
  today = localYmd(now),
  mock,
  transport,
  transportFactory = createTransport,
  personalityRng = Math.random,
  evolutionDelay,
  onRenderModel,
  pendingButtons,
  evolutionIntents,
  buddyName = "阿布",
  encounterRng = Math.random,
  place = null,
  // The pokedex screen holds the panel. The tick still runs in full -- bond,
  // settlement, encounters and the save all matter whether or not anyone is
  // looking -- it just does not push its frame over the screen.
  shouldPush = () => true,
  holdEncounter = () => false,
  captureResults,
  swapRequests,
  offlineBonds,
  logger = console,
} = {}) {
  if (!usage) throw new Error("usage is required");
  if (!weather) throw new Error("weather is required");

  mkdirSync(dirname(statePath), { recursive: true });
  const activeTransport = transport ?? (mock ? adaptPngTransport(mock) : await transportFactory({ framePath }));
  const buttonEvents = Array.isArray(pendingButtons)
    ? [...pendingButtons]
    : collectStandaloneButtonSnapshot(activeTransport);
  const evolutionIntentEvents = drainEvolutionIntents(evolutionIntents);
  const sensor = room ?? activeTransport.feedSensor?.();
  let pet = ensurePet(loadState(statePath), today, personalityRng);
  pet = settleDays(pet, today, {
    usedDays: buildUsedDays(pet, today, usage),
  });

  // Swaps land first, so everything below -- the frozen check, the growth, the
  // evolution, the render -- is about the pokemon actually on the panel now.
  pet = applySwapRequests(pet, swapRequests, logger);

  // A keepsake -- a form the trainer has already evolved past -- is displayed
  // but does not live: no exp, no level, no bond, no evolution. The bookkeeping
  // below still runs and is then pinned back, rather than being skipped, so the
  // day anchors keep advancing and a later swap cannot claim a day the live
  // buddy did not earn.
  const frozen = isFrozenSpecies(pet.species, pet);
  const beforeGrowth = pet;

  const creditedTokens =
    usage.todayPeriod == null || usage.todayPeriod === today ? usage.todayTokens : 0;
  pet = applyDailyGrowth(pet, { todayTokens: creditedTokens, today });
  // Bond is settled before the transitions below consume the same button events:
  // a KEY press that pays out this hour's half heart is the same press that may
  // also trigger an evolution, and both should see it.
  pet = applyBondTick(pet, {
    now,
    today,
    clicked: buttonEvents.some((event) => event?.key === "KEY" && event?.kind === "short"),
  });
  // Presses made with nothing listening. Inside the frozen pin below on
  // purpose: a keepsake earns nothing whether the owner was at a PC or not.
  pet = applyRecordedOfflineBonds(pet, offlineBonds, { now, today }, logger);

  if (frozen) pet = pinFrozenGrowth(beforeGrowth, pet);

  // Transitions are skipped outright for a keepsake rather than pinned: this is
  // where evolution happens, and a form that has already been evolved past must
  // not offer to evolve again into a species the trainer already has.
  const transition = frozen
    ? { pet, evolutionAnimation: null }
    : applyPetTransitions({
      pet,
      weather,
      room: sensor,
      now,
      buttonEvents,
      evolutionIntents: evolutionIntentEvents,
    });
  pet = transition.pet;
  const evolutionAnimation = transition.evolutionAnimation;

  // Encounters run last, on the pet as it now stands: an evolution this tick
  // changes the level and the species the conditions are read against, and the
  // dex entry the new form just earned should count toward this same roll.
  // Before the encounter tick, so a capture clears the offer the same tick it
  // lands -- otherwise the engine would see the offer still standing and the
  // notification would blink for a pokemon already in the box.
  pet = applyCaptureResults(pet, captureResults, logger, today);

  // Held still while a capture is on screen. The screen has no time limit any
  // more (the owner's call: offerMs governs the NOTIFICATION, not the aiming),
  // so without this the engine could expire the offer -- or roll a different
  // one -- under a player who is mid-throw.
  const offeredBefore = pet.encounter?.offeredAt ?? null;
  if (!holdEncounter()) {
    pet = applyEncounterTick(pet, { usage, weather, room: sensor, now, rng: encounterRng, logger });
  }

  // A new offer announces itself. Row 3 is one line on a panel nobody is
  // watching, and the offer expires on its own -- sound is the only channel
  // that reaches the owner when they are not looking at the device, which is
  // most of the time. Keyed on `offeredAt` rather than on the species, so a
  // second offer of the same species still cries and a re-render never does.
  //
  // Quiet hours are already handled by the gate wrapped around this transport,
  // so this must NOT check the clock itself or it would gate twice.
  //
  // Silent for the 133 species that have no cry yet: `cryAudioId` returns null
  // for anything outside seed/species-cries.json, and a wrong cry is worse than
  // none -- it would name the wrong pokemon out loud before the screen opens.
  const offeredNow = pet.encounter?.offeredAt ?? null;
  if (offeredNow != null && offeredNow !== offeredBefore) {
    const wildCry = cryAudioId(pet.encounter?.species);
    if (wildCry != null) activeTransport.playSound?.(wildCry);
  }

  if (evolutionAnimation) {
    saveState(statePath, pet);
    await playEvolutionAnimation({ transport: activeTransport, ...evolutionAnimation, delay: evolutionDelay });
  }

  const cryId = cryAudioId(pet.species);
  if (cryId != null) activeTransport.setActiveCry?.(cryId);
  const model = await buildRenderModel({ pet, usage, weather, room: sensor, now, buddyName, place });
  onRenderModel?.(model);
  const { pngBuffer, bitmap } = await renderFrame(model);

  saveState(statePath, pet);
  if (shouldPush()) await activeTransport.push({ pngBuffer, bitmap });

  return pet;
}

// Shared by the tick and by the cold-start first paint (paintFromDisk), so the
// two can never drift into rendering the same buddy differently.
export async function buildRenderModel({ pet, usage, weather, room, now, buddyName, place = null }) {
  const mood = deriveMood(usage);
  const sprite = await loadBuddySprite(pet.species);
  return {
    ...usage,
    now,
    weather,
    room,
    streak: pet.streak ?? 0,
    out: {
      t: weather.temp ?? 0,
      h: weather.humidity ?? 64,
    },
    // Left panel rows 3 and 4.
    dex: dexProgress(pet),
    place,
    // Row 3 says only THAT something is out there, never what -- the species is
    // the capture screen's to reveal. The key is carried anyway because the
    // renderer needs to know whether an offer is live at all.
    //
    // `until` is carried because this model is rebuilt once a TICK while the
    // animator redraws it three times a second. Without a deadline the row goes
    // on blinking for up to a minute after the offer has actually lapsed, and
    // KEY double -- which checks the real clock -- correctly refuses to open the
    // capture screen. That is exactly the "I saw the notice and the button did
    // nothing" the owner hit on 07-30.
    encounter: pet.encounter?.species
      ? {
        species: pet.encounter.species,
        until: Number.isFinite(Number(pet.encounter.offeredAt))
          ? Number(pet.encounter.offeredAt) + ENCOUNTER_DEFAULTS.offerMs
          : null,
      }
      : null,
    clockMs: now instanceof Date ? now.getTime() : null,
    buddy: {
      name: buddyName,
      spriteGray: sprite.gray,
      spriteW: sprite.w,
      spriteH: sprite.h,
      mood,
      level: pet.level,
      species: pet.species,
      readyToEvolve: pet.readyToEvolve,
      bond: pet.bond,
      // A keepsake shows what it IS -- a form already evolved past -- rather
      // than numbers it can no longer move: `Lv -`, an empty bar, five empty
      // hearts. Decided here rather than in the layout so the panel and the
      // pokedex's confirm screen cannot disagree about who is frozen.
      frozen: isFrozenSpecies(pet.species, pet),
      // Hearts show TODAY's bond, not the lifetime total the evolution threshold
      // tracks -- the row is a "did we spend time together today" gauge.
      bondHearts: isFrozenSpecies(pet.species, pet) ? 0 : heartsFromHalves(pet.bondHalves),
      expPct: isFrozenSpecies(pet.species, pet) || !Number.isFinite(pet.exp)
        ? 0
        : Math.round((pet.exp / expToNextLevel(pet.level)) * 100),
      bubble: sprite.placeholder ? "BUDDY" : cryFor(pet.species, mood),
    },
  };
}

// One tick of the encounter engine, folded into the pet. Returns the pet
// unchanged when nothing happened, so a save with no encounter history stays
// byte-identical and save-sync has nothing to publish.
//
// Never throws into the tick: a missing or unreadable table means no wild
// encounters, which is a smaller loss than a buddy that stops rendering. The
// failure is logged once and by name only -- the table's contents stay out of
// every message (see pet/encounter-table.js).
export function applyEncounterTick(pet, { usage, weather, room, now, rng = Math.random, logger = console } = {}) {
  let next = pet;

  // The starter line is unobtainable in the wild -- deliberately, since you
  // already have one -- so the only place those dex entries can light up is
  // here, on whatever the buddy currently is. Idempotent after the first tick.
  if (typeof pet.species === "string" && isDexSpecies(pet.species)) {
    const seen = recordSeen(pet, pet.species);
    if (seen.dexCaught.length !== normalizeDex(pet).dexCaught.length) {
      next = { ...next, ...seen };
      logger?.log?.(`pokedex: ${zhName(pet.species)} recorded (owned, not caught)`);
    }
  }

  let table;
  try {
    table = loadEncounterTable();
  } catch (error) {
    if (!encounterTableWarned) {
      encounterTableWarned = true;
      logger?.warn?.(`encounters disabled: ${error.message}`);
    }
    return next;
  }

  const ctx = buildEncounterContext({
    pet: next,
    usage,
    weather,
    room,
    mood: deriveMood(usage),
    now,
  });

  const { state, escaped } = stepEncounter({
    table,
    dex: normalizeDex(next),
    ctx,
    state: next.encounter ?? null,
    now: now.getTime(),
    rng,
  });

  if (escaped) logger?.log?.(`encounter: ${zhName(escaped)} left`);
  else if (state?.species && state.species !== next.encounter?.species) {
    logger?.log?.(`encounter: ${zhName(state.species)} appeared`);
  }

  if (!state || (state.species == null && next.encounter == null)) return next;
  return { ...next, encounter: state };
}

// Folds what the capture screen decided into the pet. The screen itself never
// writes the save -- it hands back a verdict and the tick applies it here, so
// there is exactly one writer no matter how the minigame ends.
export function applyCaptureResults(pet, captureResults, logger = console, today = null) {
  const results = Array.isArray(captureResults)
    ? captureResults.splice(0)
    : typeof captureResults?.drain === "function" ? captureResults.drain() : [];
  let next = pet;

  for (const result of results) {
    if (!result || typeof result.species !== "string") continue;
    // Every outcome ends the encounter -- caught, fled, or timed out. Clearing
    // it here rather than only on a catch is what stops a missed throw from
    // leaving the offer up to be thrown at again.
    if (next.encounter?.species === result.species) {
      next = { ...next, encounter: null };
    }
    // A fixture encounter plays in full and records nothing. It still cleared
    // the offer above, because the point is to rehearse the whole flow.
    if (result.test === true) {
      logger?.log?.(`pokedex: ${zhName(result.species)} was a test -- not recorded`);
      continue;
    }
    if (result.outcome !== "caught" || !isDexSpecies(result.species)) continue;

    // caughtAt is stamped here, at the only place a capture becomes real, so
    // the confirm screen has a date to show for every pokemon that has one.
    const recorded = recordCapture(next, { species: result.species, level: 5, caughtAt: today });
    next = { ...next, ...recorded.dex };
    logger?.log?.(
      `pokedex: ${zhName(result.species)} caught`
      + `${recorded.isNewToDex ? " (new)" : ""}${recorded.keptInBox ? "" : " (box full)"}`,
    );
  }
  return next;
}

// Puts a chosen pokemon on the panel. Queued from the button path and applied
// here for the same reason capture verdicts are: the tick is the only writer.
// Drains whatever the device published this tick and credits it. The device
// republishes the same mask every 30 seconds all day, so this runs constantly
// and almost always credits nothing -- which is why it only logs when the
// hearts actually moved.
export function applyRecordedOfflineBonds(pet, offlineBonds, { now, today } = {}, logger = console) {
  const pending = Array.isArray(offlineBonds)
    ? offlineBonds.splice(0)
    : typeof offlineBonds?.drain === "function" ? offlineBonds.drain() : [];
  if (pending.length === 0) return pet;

  const epochDay = epochDayFor(now);
  let next = pet;
  for (const offline of pending) {
    const before = Number(next.bondHalves ?? 0);
    next = applyOfflineBond(next, { offline, now, today, epochDay });
    const gained = Number(next.bondHalves ?? 0) - before;
    if (gained > 0) {
      logger?.log?.(`bond: credited ${gained} offline half-heart(s) from hours ${offline.hours.join(",")}`);
    }
  }
  return next;
}

export function applySwapRequests(pet, swapRequests, logger = console) {
  const requests = Array.isArray(swapRequests)
    ? swapRequests.splice(0)
    : typeof swapRequests?.drain === "function" ? swapRequests.drain() : [];
  let next = pet;

  for (const request of requests) {
    if (!request || typeof request.species !== "string") continue;
    const swapped = swapActiveBuddy(next, request.species);
    if (swapped === next) continue;    // not owned, or already on the panel
    next = swapped;
    logger?.log?.(`buddy: now showing ${zhName(request.species)}`);
  }
  return next;
}

let encounterTableWarned = false;

export async function main({
  once = process.env.CPB_ONCE === "1",
  intervalMs = Number(process.env.CPB_INTERVAL_MS ?? 60_000),
  configPath = "config.json",
  statePath = "out/state.json",
  framePath = "out/frame.png",
  usageRun,
  dashboard = process.env.CPB_DASHBOARD !== "0" && !once,
  dashboardHost = "127.0.0.1",
  dashboardPort = Number(process.env.CPB_DASHBOARD_PORT ?? 8765),
  transport: injectedTransport,
  weatherClient: injectedWeatherClient,
  pollUsage = pollUsageOnce,
  logger = console,
  nowProvider = () => new Date(),
  // Repaint the panel from disk before the first tick fetches anything. Off is
  // for callers that drive control flow off push counts -- the paint is a push
  // that is not a tick, which breaks that assumption.
  firstPaint = true,
} = {}) {
  let config = loadConfig(configPath);
  const saveSync = makeSaveSync(config.saveSync, { statePath, logger });
  // Before anything reads the save -- including the onboarding gate, which
  // would otherwise hatch a second buddy on a machine that already has one
  // published.
  await saveSync.pull();
  const transport = injectedTransport ?? await createTransport({ framePath, wifi: config.wifi });
  try {
    const initialNow = nowProvider();
    let soundNow = initialNow;
    const hostTransport = withSoundGate(transport, () => config, () => soundNow);
    let lastQuietActive = isQuietNow(config, initialNow);
    const sendEffectiveVolume = (now) => {
      transport.sendVolume?.(effectiveVolume(config, now));
    };
    sendEffectiveVolume(initialNow);
    transport.sendTime?.(initialNow.getHours(), initialNow.getMinutes(), epochDayFor(initialNow));
    let currentModel = null;
    const animator = createBuddyAnimator({
      transport: hostTransport,
      getModel: () => currentModel,
      render: renderFrame,
      logger,
    });

    await runOnboardingGate({
      statePath,
      onboarding: async () => {
        const { io, off } = makeOnboardingIo(hostTransport);
        try { return await runOnboarding(io); } finally { off?.(); }
      },
      tutorial: async () => {
        const { io, off } = makeOnboardingIo(hostTransport);
        try { await runTutorial(io); } finally { off?.(); }
      },
    });

    const weatherClient = injectedWeatherClient ?? makeWeather();
    let lastKnownUsage = null;
    let stopped = false;
    let timer = null;
    let resolveLoopSleep = null;
    // Ends the loop's sleep early. Declared HERE, next to what it closes over
    // and above every use: it was first written down beside stop(), i.e. after
    // the dispatcher that takes it, and `const` gave a temporal-dead-zone
    // ReferenceError that killed the host on startup. The device sat on its
    // local clock face until someone looked at the log.
    //
    // Safe to call at any moment: with no timer pending a tick is already
    // running, and that tick picks the queue up on its own.
    const wakeTick = () => {
      if (!timer) return;
      clearTimeout(timer);
      resolveLoopSleep?.();   // clears both `timer` and itself, then resolves
    };
    let runtime = {};
    let lastLoadUsageFailureReason = null;
    let lastPollUsageFailureReason = null;
    let deviceWasAttached = false;
    // Every save-sync guard below turns on this one question, so it gets one
    // definition. It was `Boolean(transport.getKind?.())` until 2026-08-03, and
    // getKind() returns the string "mock" when nothing is attached -- so the
    // answer was an unconditional `true`, the pull-on-arrival fired once at
    // startup and never again, the push-on-departure branch was dead code, and
    // a host idling in mock mode published over the machine that actually had
    // the device. That is how a weekend of catches was overwritten. The
    // getKind() fallback is for injected test transports that predate
    // isAttached(); it makes the same distinction, just by name.
    const deviceIsAttached = () => {
      if (transport.isAttached) return transport.isAttached();
      const kind = transport.getKind?.();
      return Boolean(kind) && kind !== "mock";
    };
    const actions = createActionQueue();
    const evolutionIntents = createEvolutionIntentQueue();
    // Same queue shape, carrying capture verdicts from the button path to the
    // tick, which is the only thing that writes the pet.
    const captureResults = createEvolutionIntentQueue();
    const swapRequests = createEvolutionIntentQueue();
    // Hours the device recorded while nothing was listening. Collected off the
    // transport rather than through the button dispatcher: these are not
    // presses happening now, they are a report about presses already made, and
    // routing them through the greet/evolution path would replay all of it.
    const offlineBonds = [];
    transport.onOfflineBond?.((event) => offlineBonds.push(event));
    const buttonDispatcher = createButtonDispatcher({
      transport: hostTransport,
      getPet: () => runtime.pet,
      getModel: () => currentModel,
      actions,
      animator,
      onSignatureError: () => {},
      // Read at press time, not captured: the dex grows while the screen is
      // closed, and a stale snapshot would show yesterday's collection.
      //
      // Falls back to the save on disk exactly like `getView` and the tick do.
      // `runtime.pet` is unset until the first tick assigns it, so without this
      // the screen is reachable in the seconds after a host start and renders
      // `dexProgress({})` -- 0/151 with all 151 silhouettes black, i.e. it
      // reports the collection as empty rather than as unknown. Observed on the
      // home PC 2026-07-30 with two entries sitting in the save.
      dexSource: () => {
        const pet = runtime.pet ?? loadState(statePath);
        return { dex: pet, progress: dexProgress(pet ?? {}) };
      },
      swapRequests,
      wakeTick,
      captureResults,
      logger,
    });
    const dashboardServer = dashboard
      ? await startDashboardServer({
          host: dashboardHost,
          port: dashboardPort,
          statePath,
          configPath,
          framePath,
          getRuntime: () => runtime,
          getConfig: () => config,
          setConfig: (next) => { config = next; },
          onSettingsChanged: (changed) => {
            if (!("volume" in changed) && !("quietHours" in changed)) return;
            const now = nowProvider();
            soundNow = now;
            lastQuietActive = isQuietNow(config, now);
            sendEffectiveVolume(now);
          },
          evolutionIntents,
          nowProvider,
        })
      : null;

    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      resolveLoopSleep?.();
      resolveLoopSleep = null;
      buttonDispatcher.stop();
      animator.stop();
      dashboardServer?.close().catch(() => {});
      transport.close?.();
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    // Get *something* on the panel before the first tick goes near a subprocess
    // or the network. Measured on a cold start: 3.1s of process and module
    // startup, then 2.7s spawning ccusage twice and polling the usage endpoint,
    // then weather, and only then the first frame -- so the device sat on its
    // local-clock fallback for ~7s with the host already attached and healthy,
    // and the same 7s over USB, which is what proved it was never a network
    // problem. Everything needed to redraw the last picture is already on disk
    // (the save, and the usage file the poller writes), so put that up now and
    // let the first real tick correct it seconds later.
    //
    // After the signal handlers on purpose: this pushes, and pushing before
    // there is a way to stop cleanly is asking for a wedged shutdown.
    //
    // Deliberately no settlement, no growth, no save -- a repaint, not a tick.
    // It must not be able to advance the buddy's day.
    if (firstPaint) await paintFromDisk();

    async function paintFromDisk() {
      try {
        const now = nowProvider();
        const pet = ensurePet(loadState(statePath), localYmd(now));
        // usageForDisplay with nothing to show returns the all-null degraded
        // shape, which renders as "--" -- the honest thing to put up until
        // ccusage answers. The official percentages come off disk and are
        // usually still fresh, so the two bars are typically right immediately.
        const usage = mergeUsage(usageForDisplay(null, null).usage, loadRateLimits());
        // No `place` here on purpose. This is the cold-start repaint that was
        // tuned from 6.9s to 2.8s, and it is not going to grow a subprocess for
        // one row of text -- the first tick is ~3s behind it and fills the row
        // in then.
        const model = await buildRenderModel({
          pet, usage, weather: DEFAULT_WEATHER, room: hostTransport.feedSensor?.() ?? null,
          now, buddyName: config.name,
        });
        currentModel = model;
        const { pngBuffer, bitmap } = await renderFrame(model);
        await hostTransport.push({ pngBuffer, bitmap });
        logger?.log?.("first paint from disk");
      } catch (error) {
        // A failed first paint costs nothing but the old wait -- the tick loop
        // is right behind it and renders the real thing regardless.
        logger?.warn?.(`first paint skipped: ${errorReason(error)}`);
      }
    }

    let lastHour = initialNow.getHours();
    async function tick() {
      await actions.run(async () => {
        const now = nowProvider();
        soundNow = now;
        transport.sendTime?.(now.getHours(), now.getMinutes(), epochDayFor(now)); // keeps the device's local-clock fallback synced
        const quietActive = isQuietNow(config, now);
        if (quietActive !== lastQuietActive) {
          lastQuietActive = quietActive;
          sendEffectiveVolume(now);
        }
        // A host that has been idling in mock mode kept simulating a buddy
        // nobody was looking at. The moment the device turns up here, that
        // local drift is the wrong save -- re-pull before the tick reads it,
        // so this machine picks up the buddy that was actually being raised
        // wherever the device just came from. (loadState re-reads from disk
        // every tick, so replacing the file is all this takes.)
        const deviceAttached = deviceIsAttached();
        if (deviceAttached && !deviceWasAttached) await saveSync.pull();
        // The device just left -- it is on its way to the other machine, and
        // this is the handoff. Publish now instead of leaving the last stretch
        // of the session sitting behind the push debounce, where it would be
        // silently dropped when the machine at the other end pulls.
        if (!deviceAttached && deviceWasAttached) await saveSync.maybePush({ force: true });
        deviceWasAttached = deviceAttached;
        // A catch is the one event worth publishing immediately rather than
        // within the next five minutes: it is rare, it is the thing the owner
        // would most notice losing, and the five-minute window is long enough
        // to span putting the device in a bag. Detected by watching the counter
        // rather than by tapping the capture path, so every route that records
        // a catch is covered by construction.
        const capturedBefore = runtime.pet?.capturedCount ?? null;
        let capturedThisTick = false;
        animator.pause();
        try {
          const snapshot = await loadUsageSnapshot({ ...config, run: usageRun });
          lastLoadUsageFailureReason = logFailureReasonTransition({
            result: snapshot,
            lastReason: lastLoadUsageFailureReason,
            logger,
            label: "loadUsageSnapshot",
          });
          const selected = usageForDisplay(snapshot, lastKnownUsage);
          lastKnownUsage = selected.lastKnown;
          const pollResult = await pollUsage().catch((error) => ({
            ok: false,
            reason: errorReason(error),
          }));
          lastPollUsageFailureReason = logFailureReasonTransition({
            result: pollResult,
            lastReason: lastPollUsageFailureReason,
            logger,
            label: "pollUsage",
          });
          const usage = mergeUsage(selected.usage, loadRateLimits());
          const weather = await loadWeatherSnapshot(weatherClient, config);
          // Inside the existing pause with the rest of the tick's I/O, not
          // outside it: netsh is tens of milliseconds against ccusage's three
          // seconds, and the pause is load-shedding that is not to be narrowed
          // (see docs/handoff.md). An unreadable SSID resolves to null, which
          // draws nothing rather than guessing the wrong place.
          const place = await resolvePlace({ places: config.places }).catch(() => null);
          const room = hostTransport.feedSensor();
          const pendingButtons = buttonDispatcher.drainTickEvents();
          buttonDispatcher.ageDex();
          // Recorded from inside shouldPush rather than asked again afterwards,
          // because a screen can open while the tick is rendering and the log
          // has to say what actually happened, not what is true a second later.
          let pushedToDevice = null;
          let pet;
          try {
            pet = await runOneTick({
              usage,
              weather,
              room,
              statePath,
              framePath,
              transport: hostTransport,
              now,
              today: localYmd(now),
              onRenderModel: (model) => { currentModel = model; },
              pendingButtons,
              evolutionIntents,
              buddyName: config.name,
              place,
              shouldPush: () => {
                pushedToDevice = !buttonDispatcher.isDexOpen();
                return pushedToDevice;
              },
              holdEncounter: () => buttonDispatcher.isCaptureOpen(),
              captureResults,
              swapRequests,
              offlineBonds,
              logger,
            });
          } catch (error) {
            buttonDispatcher.requeueForRetry(pendingButtons);
            throw error;
          }
          runtime = { usage, weather, room, pet };
          capturedThisTick = capturedBefore != null
            && Number.isFinite(pet?.capturedCount)
            && pet.capturedCount > capturedBefore;
          const hour = now.getHours();
          if (hour !== lastHour) {
            lastHour = hour;
            hostTransport.playSound?.(SOUND.HOUR);       // top-of-hour chime
          }
          // This line used to print unconditionally, which is how a whole night
          // of "wrote out/frame.png" every minute sat in the log while the device
          // was receiving nothing and sitting on its offline clock face. A log
          // that reports the render cannot be read as reporting the link.
          if (pushedToDevice === false) {
            const repainted = await buttonDispatcher.repaintHeldScreen();
            console.log(`wrote ${framePath} (panel held by ${repainted ? "pokedex" : "capture screen"}; buddy panel not pushed)`);
          } else {
            console.log(`wrote ${framePath}`);
          }
        } finally {
          animator.resume();
        }
        // Publish only from the machine holding the device: see save-sync.js's
        // header for why that guard is the whole safety story.
        if (deviceAttached) await saveSync.maybePush({ force: capturedThisTick });
      });
    }

    try {
      if (once) {
        await tick(); // once mode: let errors propagate to the exit code
        return;
      }

      await runTickLoop({
        runTick: tick,
        intervalMs,
        isStopped: () => stopped,
        beforeLoop: () => animator.start(),
        setTimer: (resolve, ms) => {
          resolveLoopSleep = () => {
            timer = null;
            resolveLoopSleep = null;
            resolve();
          };
          timer = setTimeout(resolveLoopSleep, ms);
        },
      });
    } finally {
      // Read before stop() closes the transport. Shutting down while the
      // device is still attached is the normal end of a session, and the last
      // few minutes of it are exactly what the debounce would otherwise drop.
      // Checking "attached right now" rather than "attached at some point"
      // matters: a host that idled all day in mock mode after the device left
      // must not publish that drift on its way out.
      const attachedAtExit = deviceIsAttached();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (!stopped) stop();
      if (attachedAtExit) await saveSync.maybePush({ force: true });
    }
  } catch (error) {
    // mock 模式探测 timer 是 referenced 的；启动期抛出若不释放，会把进程钉成僵尸，launchd 不重启且会在插板瞬间抢走串口。
    transport.close?.();
    throw error;
  }
}

export async function runTickLoop({
  runTick,
  intervalMs,
  isStopped,
  beforeLoop = () => {},
  setTimer = (resolve, ms) => setTimeout(resolve, ms),
  onError = (error) => console.error("buddy tick failed; continuing:", error),
}) {
  const safe = async () => {
    try {
      await runTick();
    } catch (error) {
      onError(error);
    }
  };

  await safe();
  beforeLoop();
  while (!isStopped()) {
    await new Promise((resolve) => setTimer(resolve, intervalMs));
    if (!isStopped()) await safe();
  }
}

export function startDashboardServer({
  host = "127.0.0.1",
  port = 0,
  statePath = "out/state.json",
  configPath = "config.json",
  framePath = "out/frame.png",
  getRuntime = () => ({}),
  getConfig = () => loadConfig(configPath),
  setConfig = () => {},
  onSettingsChanged = () => {},
  evolutionIntents = createEvolutionIntentQueue(),
  nowProvider = () => new Date(),
} = {}) {
  return startWebServer({
    host,
    port,
    framePath,
    getView: () => {
      const config = getConfig();
      const runtime = getRuntime();
      return toDashboardRuntimeView({
        pet: runtime.pet ?? loadState(statePath),
        usage: runtime.usage,
        weather: runtime.weather ?? DEFAULT_WEATHER,
        room: runtime.room,
        config,
      });
    },
    saveSettings: (input) => {
      const result = validateSettings(input);
      if (!result.ok) throw new Error(result.error);
      const next = { ...getConfig(), ...result.value };
      if (result.value.name === "") delete next.name;
      saveConfig(configPath, next);
      const effective = loadConfig(configPath);
      setConfig(effective);
      onSettingsChanged(result.value, effective);
      return result.value;
    },
    chooseEvolution: (to) => {
      const { evolution } = resolveCurrentEvolution({
        runtime: getRuntime(),
        statePath,
        nowProvider,
      });
      const hasChoicePrompt = !evolution.auto && evolution.candidates.length > 1;
      if (!hasChoicePrompt || !evolution.candidates.some((candidate) => candidate?.to === to)) {
        throw new Error("evolution candidate is not currently eligible");
      }
      evolutionIntents.push({ type: "choose", to });
      return { to };
    },
    grantEvolutionStone: (stone) => {
      const { evolution } = resolveCurrentEvolution({
        runtime: getRuntime(),
        statePath,
        nowProvider,
        stone,
      });
      const branch = evolution.candidates.find((candidate) => candidate?.needs?.stone === stone);
      if (!branch) throw new Error("evolution stone does not match current species");
      evolutionIntents.push({ type: "stone", stone });
      return { stone, to: branch.to };
    },
  });
}

function resolveCurrentEvolution({ runtime = {}, statePath, nowProvider, stone } = {}) {
  const pet = runtime.pet ?? loadState(statePath);
  const probePet = stone ? { ...pet, stone } : pet;
  const now = nowProvider();
  const evolution = resolveEvolution(
    probePet.species,
    evolutionContext({
      pet: probePet,
      weather: runtime.weather ?? DEFAULT_WEATHER,
      room: runtime.room,
      now,
    }),
  );
  return { pet: probePet, evolution };
}

function adaptPngTransport(transport) {
  return {
    ...transport,
    async push(frame) {
      return transport.push(frame?.pngBuffer ?? frame);
    },
  };
}

function collectStandaloneButtonSnapshot(transport) {
  const events = [];
  const off = transport?.onButton?.((event) => events.push(event));
  try {
    return events;
  } finally {
    off?.();
  }
}

export async function runOnboardingGate({
  statePath,
  // 孵化日必须是 onboarding 真正完成的那天：设备可能几天/几周后才接入，
  // 进程启动时求值会把陈旧日期写进 lastSettled，首次结算即虚增 streak/衰减 bond。
  todayProvider = () => localYmd(new Date()),
  onboarding,             // 注入：() => Promise<{species,name}>（真实由 transport io 驱动）
  tutorial = async () => {}, // 注入：() => Promise<void>；诞生落档后播放
  personalityRng = Math.random,
}) {
  const existing = loadState(statePath);
  if (existing?.hatched) {
    if (existing.tutorialDone === false) return finishTutorial(statePath, existing, tutorial);
    return existing;
  }
  const { species, name } = await onboarding();
  const today = todayProvider(); // onboarding 完成后才定孵化日
  mkdirSync(dirname(statePath), { recursive: true });
  // 诞生即落档（tutorialDone:false）→ 教程中断电也不会重孵化
  const newborn = { ...makeNewborn(species, name, today, personalityRng), tutorialDone: false };
  saveState(statePath, newborn);
  return finishTutorial(statePath, newborn, tutorial);
}

async function finishTutorial(statePath, pet, tutorial) {
  await tutorial();
  const done = { ...pet, tutorialDone: true };
  saveState(statePath, done);
  return done;
}

function makeNewborn(species, name, today, personalityRng = Math.random) {
  return {
    species, name, level: 1, exp: 0, bond: 0, streak: 0, shield: 0,
    lastSettled: today, lastGrowthDay: null, todayCreditedExp: 0, todayCreditedBond: 0,
    hatched: true, ...rollPersonality(personalityRng),
  };
}

export function makeOnboardingIo(transport) {
  const queue = [];
  const waiters = [];
  const off = transport.onButton?.((button) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(button);
      return;
    }
    if (queue.length < 8) queue.push(button);
  });
  const io = {
    push: (frame) => transport.push(frame),
    nextButton: () => {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((res) => { waiters.push(res); });
    },
    playSound: (id) => transport.playSound?.(id),
    delay: (ms) => new Promise((res) => setTimeout(res, ms)),
  };
  return { io, off };
}

function withSoundGate(transport, getConfig, getNow) {
  return {
    ...transport,
    playSound(id) {
      if (!isQuietNow(getConfig(), getNow())) transport.playSound?.(id);
    },
  };
}

async function loadWeatherSnapshot(weatherClient, config) {
  const weather = await weatherClient.get(config.lat, config.lon);
  if (weather.temp == null || weather.cond === "—") return { ...DEFAULT_WEATHER, degraded: true };
  return weather;
}

function logFailureReasonTransition({ result, lastReason, logger, label }) {
  const reason = failureReason(result);
  if (!reason) return null;
  if (reason !== lastReason) logger?.warn?.(`${label} failed: ${reason}`);
  return reason;
}

function failureReason(result) {
  if (result?.ok !== false) return null;
  return typeof result.reason === "string" && result.reason.length > 0
    ? result.reason
    : "unknown";
}

function errorReason(error) {
  return error?.message ? error.message : "error";
}

// Off unless config.json opts in: this pushes to a git remote, which is not
// something a host should start doing to someone's repo on its own.
const SAVE_SYNC_OFF = {
  pull: async () => ({ status: "disabled" }),
  maybePush: async () => ({ status: "disabled" }),
};

function makeSaveSync(settings, { statePath, logger }) {
  if (!settings?.enabled) return SAVE_SYNC_OFF;
  return createSaveSync({
    statePath,
    remote: settings.remote,
    branch: settings.branch,
    pushIntervalMs: settings.pushIntervalMs,
    logger,
  });
}

function localYmd(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isQuietNow(config, now) {
  const quietHours = config?.quietHours;
  if (!quietHours) return false;
  const { start, end } = quietHours;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start < 0 || start > 23 || end < 0 || end > 23 || start === end) return false;
  const hour = now.getHours();
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

function effectiveVolume(config, now) {
  return isQuietNow(config, now) ? 0 : volumeByte(config?.volume);
}

function volumeByte(value) {
  const volume = Number(value);
  if (!Number.isFinite(volume)) return 0;
  return Math.max(0, Math.min(100, Math.trunc(volume)));
}

const isCli = process.argv[1] && existsSync(process.argv[1])
  ? fileURLToPath(import.meta.url) === process.argv[1]
  : false;

if (isCli) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
