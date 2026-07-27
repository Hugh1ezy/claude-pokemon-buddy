import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { cryAudioId } from "./pet/cry-audio.js";
import { cryFor } from "./pet/cries.js";
import { loadConfig, saveConfig } from "./config.js";
import { resolveEvolution } from "./pet/evolution.js";
import { rollPersonality } from "./pet/personality.js";
import { applyDailyGrowth, daysToNextLevel, deriveMood, expToNextLevel, PARAMS } from "./pet/sim.js";
import { buildUsedDays, settleDays } from "./pet/settlement.js";
import { applyPetTransitions, drainEvolutionIntents, ensurePet, evolutionContext } from "./pet/transitions.js";
import { runOnboarding, runTutorial } from "./pet/onboarding.js";
import { createBuddyAnimator } from "./render/buddy-animator.js";
import { playEvolutionAnimation } from "./render/evolution-anim.js";
import { renderFrame } from "./render/frame.js";
import { playSignatureAnimation } from "./render/signature-anim.js";
import { loadBuddySprite } from "./render/sprites.js";
import { loadState, saveState } from "./state.js";
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
} = {}) {
  const tickQueue = [];
  let signatureInFlight = false;
  const off = transport?.onButton?.((event) => {
    if (shouldPlaySignature(event, getPet())) {
      if (signatureInFlight) return;
      const pressModel = getModel();
      if (pressModel) {
        signatureInFlight = true;
        actions.run(async () => {
          animator.pause();
          try { await playSignature({ transport, model: pressModel }); }
          finally { animator.resume(); }
        }).catch(onSignatureError).finally(() => { signatureInFlight = false; });
      }
      return;
    }

    if (shouldQueueButtonForTick(event)) tickQueue.push(event);
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

  const mood = deriveMood(usage);
  const cryId = cryAudioId(pet.species);
  if (cryId != null) activeTransport.setActiveCry?.(cryId);
  const sprite = await loadBuddySprite(pet.species);
  const model = {
    ...usage,
    now,
    weather,
    room: sensor,
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
      expPct: Number.isFinite(pet.exp) ? Math.round((pet.exp / expToNextLevel(pet.level)) * 100) : 0,
      // Day-denominated view of the same progress: the EXP bar draws one cell per
      // day this level costs, so the curve is something you read off the screen
      // instead of a flat percentage that hides how far the goalposts moved.
      expDaysNeeded: daysToNextLevel(pet.level),
      expDaysDone: Number.isFinite(pet.exp) ? pet.exp / PARAMS.levelExp : 0,
      bubble: sprite.placeholder ? "BUDDY" : cryFor(pet.species, mood),
    },
  };
  onRenderModel?.(model);
  const { pngBuffer, bitmap } = await renderFrame(model);

  saveState(statePath, pet);
  await activeTransport.push({ pngBuffer, bitmap });

  return pet;
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
} = {}) {
  let config = loadConfig(configPath);
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
    const actions = createActionQueue();
    const evolutionIntents = createEvolutionIntentQueue();
    const buttonDispatcher = createButtonDispatcher({
      transport: hostTransport,
      getPet: () => runtime.pet,
      getModel: () => currentModel,
      actions,
      animator,
      onSignatureError: () => {},
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
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (!stopped) stop();
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
