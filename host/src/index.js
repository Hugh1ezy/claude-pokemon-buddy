import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { cryAudioId } from "./pet/cry-audio.js";
import { cryFor } from "./pet/cries.js";
import { loadConfig, saveConfig } from "./config.js";
import { resolveEvolution } from "./pet/evolution.js";
import { rollPersonality } from "./pet/personality.js";
import { applyBondTick, heartsFromHalves } from "./pet/bond.js";
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
  logger = null,
} = {}) {
  const tickQueue = [];
  let signatureInFlight = false;
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

  return {
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

  const transition = applyPetTransitions({
    pet,
    weather,
    room: sensor,
    now,
    buttonEvents,
    evolutionIntents: evolutionIntentEvents,
  });
  pet = transition.pet;
  const evolutionAnimation = transition.evolutionAnimation;

  if (evolutionAnimation) {
    saveState(statePath, pet);
    await playEvolutionAnimation({ transport: activeTransport, ...evolutionAnimation, delay: evolutionDelay });
  }

  const cryId = cryAudioId(pet.species);
  if (cryId != null) activeTransport.setActiveCry?.(cryId);
  const model = await buildRenderModel({ pet, usage, weather, room: sensor, now, buddyName });
  onRenderModel?.(model);
  const { pngBuffer, bitmap } = await renderFrame(model);

  saveState(statePath, pet);
  await activeTransport.push({ pngBuffer, bitmap });

  return pet;
}

// Shared by the tick and by the cold-start first paint (paintFromDisk), so the
// two can never drift into rendering the same buddy differently.
export async function buildRenderModel({ pet, usage, weather, room, now, buddyName }) {
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
      // Hearts show TODAY's bond, not the lifetime total the evolution threshold
      // tracks -- the row is a "did we spend time together today" gauge.
      bondHearts: heartsFromHalves(pet.bondHalves),
      expPct: Number.isFinite(pet.exp) ? Math.round((pet.exp / expToNextLevel(pet.level)) * 100) : 0,
      bubble: sprite.placeholder ? "BUDDY" : cryFor(pet.species, mood),
    },
  };
}

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
    let runtime = {};
    let lastLoadUsageFailureReason = null;
    let lastPollUsageFailureReason = null;
    let deviceWasAttached = false;
    const actions = createActionQueue();
    const evolutionIntents = createEvolutionIntentQueue();
    const buttonDispatcher = createButtonDispatcher({
      transport: hostTransport,
      getPet: () => runtime.pet,
      getModel: () => currentModel,
      actions,
      animator,
      onSignatureError: () => {},
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
        const deviceAttached = Boolean(transport.getKind?.());
        if (deviceAttached && !deviceWasAttached) await saveSync.pull();
        // The device just left -- it is on its way to the other machine, and
        // this is the handoff. Publish now instead of leaving the last stretch
        // of the session sitting behind the push debounce, where it would be
        // silently dropped when the machine at the other end pulls.
        if (!deviceAttached && deviceWasAttached) await saveSync.maybePush({ force: true });
        deviceWasAttached = deviceAttached;
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
          const room = hostTransport.feedSensor();
          const pendingButtons = buttonDispatcher.drainTickEvents();
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
            });
          } catch (error) {
            buttonDispatcher.requeueForRetry(pendingButtons);
            throw error;
          }
          runtime = { usage, weather, room, pet };
          const hour = now.getHours();
          if (hour !== lastHour) {
            lastHour = hour;
            hostTransport.playSound?.(SOUND.HOUR);       // top-of-hour chime
          }
          console.log(`wrote ${framePath}`);
        } finally {
          animator.resume();
        }
        // Publish only from the machine holding the device: see save-sync.js's
        // header for why that guard is the whole safety story.
        if (deviceAttached) await saveSync.maybePush();
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
      const attachedAtExit = Boolean(transport.getKind?.());
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
