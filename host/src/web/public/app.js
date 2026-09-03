const POLL_MS = 5_000;
const LOCAL_SPRITES = new Set([
  "eevee", "vaporeon", "jolteon", "flareon", "espeon", "umbreon",
  "leafeon", "glaceon", "sylveon", "bulbasaur", "ivysaur", "venusaur",
  "charmander", "charmeleon", "charizard", "squirtle", "wartortle", "blastoise",
]);
const BOX_MAX = LOCAL_SPRITES.size;
const SPECIES = {
  bulbasaur: { dex: 1, label: "妙蛙种子 Bulbasaur" },
  charmander: { dex: 4, label: "小火龙 Charmander" },
  pikachu: { dex: 25, label: "皮卡丘 Pikachu" },
  eevee: { dex: 133, label: "伊布 Eevee" },
  vaporeon: { dex: 134, label: "水伊布 Vaporeon" },
  jolteon: { dex: 135, label: "雷伊布 Jolteon" },
  flareon: { dex: 136, label: "火伊布 Flareon" },
  espeon: { dex: 196, label: "太阳伊布 Espeon" },
  umbreon: { dex: 197, label: "月亮伊布 Umbreon" },
  leafeon: { dex: 470, label: "叶伊布 Leafeon" },
  glaceon: { dex: 471, label: "冰伊布 Glaceon" },
  sylveon: { dex: 700, label: "仙子伊布 Sylveon" },
  snorlax: { dex: 143, label: "卡比兽 Snorlax" },
  ivysaur: { dex: 2, label: "妙蛙草 Ivysaur" },
  venusaur: { dex: 3, label: "妙蛙花 Venusaur" },
  charmeleon: { dex: 5, label: "火恐龙 Charmeleon" },
  charizard: { dex: 6, label: "喷火龙 Charizard" },
  squirtle: { dex: 7, label: "杰尼龟 Squirtle" },
  wartortle: { dex: 8, label: "卡咪龟 Wartortle" },
  blastoise: { dex: 9, label: "水箭龟 Blastoise" },
};
const IV_LABELS = ["HP", "攻", "防", "速", "特攻", "特防"];
const SECRET_LABELS = {
  shiny: ["✦", "闪光"],
  truck: ["🚚", "卡车"],
  oak: ["📜", "大木开场白"],
};

const form = document.getElementById("settings-form");
const statusEl = document.getElementById("settings-status");
const volume = document.getElementById("settings-volume");
const volumeValue = document.getElementById("volume-value");
let currentSpecies = null;
let pendingEvolution = null;

volume.addEventListener("input", () => {
  volumeValue.textContent = volume.value;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("保存中...");
  try {
    const body = buildSettingsBody();
    if (Object.keys(body).length === 0) {
      setStatus("没有要保存的更改", true);
      return;
    }

    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "保存失败");

    setStatus("已保存");
    await loadState();
  } catch (error) {
    setStatus(error.message, true);
  }
});

loadState();
setInterval(loadState, POLL_MS);

async function loadState() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (!res.ok) throw new Error(`state ${res.status}`);
    render(await res.json());
    setText("last-sync", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    refreshLive();
  } catch (error) {
    setStatus(`读取失败: ${error.message}`, true);
  }
}

function render(view) {
  renderUsage(view.usage ?? {});
  renderWeather(view.weather ?? {}, view.room ?? {});
  renderBuddy(view.buddy ?? {}, view.difficulty);
  renderBox(view);
  renderJourney(view.journey ?? []);
  renderSecrets(view.secrets ?? {});
  renderSettings(view.settings ?? {});
}

function renderUsage(usage) {
  setText("usage-modelled", usage.modelled ? "LOCAL/est" : "--");
  const staleSuffix = usage.rateStale ? " 旧" : "";
  setText("usage-p5h", usage.p5h == null ? formatPct(usage.p5h) : `${formatPct(usage.p5h)}${staleSuffix}`);
  setText("usage-pweek", usage.pweek == null ? formatPct(usage.pweek) : `${formatPct(usage.pweek)}${staleSuffix}`);
  setText("usage-today", `${formatMoney(usage.todayCost)} · ${formatTokens(usage.todayTokens)}`);
  setText("usage-streak", usage.streak == null ? "--" : `${usage.streak}d`);
}

function renderWeather(weather, room) {
  const weatherPrefix = weather.degraded ? "degraded " : "";
  const weatherLine = weather.cond
    ? `${weatherPrefix}${weather.cond} ${formatTemp(weather.temp)} · ${formatRange(weather.lo, weather.hi)} · 降水 ${formatPct(weather.precip)}`
    : "--";
  setText("weather-line", weatherLine);
  setText("room-line", room.t == null && room.h == null ? "--" : `${formatTemp(room.t)} · ${room.h ?? "--"}%`);
}

function renderBuddy(buddy, difficulty) {
  observeSpecies(buddy.species);
  const species = speciesInfo(buddy.species);
  setText("difficulty", difficulty ?? "--");
  setText("difficulty-lock", difficulty ?? "NORMAL · 锁定");
  setText("buddy-name", buddy.name ?? "--");
  setText("buddy-level", buddy.level == null ? "Lv.--" : `Lv.${buddy.level}`);
  setText("buddy-bond", hearts(buddy.bond));
  setText("buddy-mood", buddy.mood ?? "--");
  setText("buddy-species", species.label);
  setText("buddy-nature", buddy.nature ?? "--");
  setText("buddy-characteristic", buddy.characteristic ?? "--");
  setText("buddy-signature", buddy.characteristic ? `"${buddy.characteristic}"` : "--");
  setText("buddy-dex", species.dex ? `#${species.dex}` : "#---");

  const sprite = document.getElementById("buddy-sprite");
  sprite.src = spriteSrc(species.key);

  renderIv(buddy.iv ?? []);
  renderBadges(buddy.badges ?? []);
  renderNextEvo(buddy.nextEvo ?? {});
}

function renderIv(iv) {
  const root = document.getElementById("buddy-iv");
  root.textContent = "";
  IV_LABELS.forEach((label, index) => {
    const value = Number(iv[index] ?? 0);
    const bar = document.createElement("div");
    bar.className = "ivb";
    const fill = document.createElement("i");
    fill.style.height = `${Math.max(0, Math.min(100, Math.round((value / 31) * 100)))}%`;
    const text = document.createElement("span");
    text.textContent = label;
    bar.append(fill, text);
    root.appendChild(bar);
  });
}

function renderBadges(badges) {
  const root = document.getElementById("buddy-badges");
  root.textContent = "";
  if (badges.length === 0) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "--";
    root.appendChild(badge);
    return;
  }
  for (const badgeText of badges) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = badgeText;
    root.appendChild(badge);
  }
}

function renderNextEvo(nextEvo) {
  const bond = Number(nextEvo.bond ?? 0);
  const threshold = Number(nextEvo.threshold ?? 0);
  const pct = threshold > 0 ? Math.round((bond / threshold) * 100) : 0;
  const ready = nextEvo.ready ? " · READY" : "";
  setText("next-evo-label", threshold > 0 ? `亲密 ${bond} / ${threshold}${ready}` : "--");
  document.getElementById("next-evo-bar").style.width = `${Math.max(0, Math.min(100, pct))}%`;
  renderEvolutionControls(nextEvo);
}

function renderEvolutionControls(nextEvo) {
  const root = ensureEvolutionControls();
  if (!root) return;
  root.textContent = "";

  // Only a genuine fork puts buttons here. Nothing in this game is handed to a
  // pokemon any more -- every line that once wanted an item now asks the world
  // for something instead -- so the panel's job is to break a tie, never to
  // dispense one.
  const candidates = nextEvo.ready && Array.isArray(nextEvo.pendingCandidates) ? nextEvo.pendingCandidates : [];
  if (candidates.length === 0) {
    root.hidden = true;
    return;
  }

  root.hidden = false;
  for (const candidate of candidates) {
    if (typeof candidate?.to !== "string") continue;
    root.appendChild(makeEvolutionButton(`选择 ${speciesInfo(candidate.to).label}`, () => (
      postEvolutionIntent("/api/evolution/choose", { to: candidate.to })
    )));
  }
}

function ensureEvolutionControls() {
  let root = document.getElementById("evolution-controls");
  if (root) return root;

  const goal = document.querySelector(".goal");
  if (!goal) return null;
  root = document.createElement("div");
  root.id = "evolution-controls";
  root.style.display = "flex";
  root.style.flexWrap = "wrap";
  root.style.gap = "8px";
  root.style.marginTop = "10px";
  goal.appendChild(root);
  return root;
}

function makeEvolutionButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await onClick();
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

async function postEvolutionIntent(path, body) {
  setStatus("提交中...");
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "提交失败");
  pendingEvolution = { from: currentSpecies, to: json.to ?? null };
  setStatus("已排队");
}

function observeSpecies(species) {
  if (typeof species !== "string" || species.length === 0) return;
  if (pendingEvolution?.from && species !== pendingEvolution.from) {
    setStatus(`已进化为 ${speciesInfo(species).label}`);
    pendingEvolution = null;
  }
  currentSpecies = species;
}

function renderBox(view) {
  const root = document.getElementById("box");
  const buddy = view.buddy ?? {};
  const box = Array.isArray(view.box) && view.box.length > 0 ? view.box : buddy.species ? [buddy.species] : [];
  root.textContent = "";
  setText("box-count", `${box.length} / ${BOX_MAX}`);

  for (const item of box) {
    const species = speciesInfo(typeof item === "string" ? item : item.species);
    const slot = document.createElement("div");
    slot.className = `slot${species.key === buddy.species ? " sel" : ""}`;
    const src = spriteSrc(species.key);
    if (src) {
      const img = document.createElement("img");
      img.alt = species.label;
      img.src = src;
      slot.appendChild(img);
    } else {
      slot.textContent = species.label;
    }
    root.appendChild(slot);
  }
}

function renderJourney(journey) {
  const root = document.getElementById("journey");
  root.textContent = "";
  setText("journey-count", `${journey.length} 条`);

  if (journey.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tle";
    empty.textContent = "--";
    root.appendChild(empty);
    return;
  }

  for (const item of journey.slice(0, 8)) {
    const entry = document.createElement("div");
    entry.className = "tle";
    const date = document.createElement("span");
    date.className = "d";
    date.textContent = shortDate(item.date);
    entry.append(date, item.text ?? "");
    root.appendChild(entry);
  }
}

function renderSecrets(secrets) {
  const root = document.getElementById("secrets");
  const discovered = Array.isArray(secrets.discovered) ? secrets.discovered : [];
  const discoveredCount = Number(secrets.discoveredCount ?? discovered.length);
  const total = Number(secrets.total ?? discoveredCount);
  const lockedCount = Number(secrets.lockedCount ?? Math.max(0, total - discoveredCount));
  root.textContent = "";
  setText("secrets-count", `${discoveredCount} / ${total}`);

  for (const id of discovered) {
    const [icon, label] = SECRET_LABELS[id] ?? ["✦", id];
    const item = document.createElement("div");
    item.className = "sec";
    item.innerHTML = `<span class="ic"></span><span></span>`;
    item.children[0].textContent = icon;
    item.children[1].textContent = label;
    root.appendChild(item);
  }

  for (let i = 0; i < lockedCount; i += 1) {
    const item = document.createElement("div");
    item.className = "sec lock";
    item.innerHTML = `<span class="ic">?</span><span>???</span>`;
    root.appendChild(item);
  }
}

function renderSettings(settings) {
  if (form.contains(document.activeElement)) return; // don't overwrite an in-progress edit
  setInput("settings-name", settings.name ?? "");
  setInput("quiet-start", settings.quietHours?.start ?? "");
  setInput("quiet-end", settings.quietHours?.end ?? "");
  setInput("settings-volume", settings.volume ?? 0);
  volumeValue.textContent = String(settings.volume ?? 0);
  setInput("settings-lat", settings.lat ?? "");
  setInput("settings-lon", settings.lon ?? "");
}

function refreshLive() {
  document.getElementById("live").src = `/frame.png?_=${Date.now()}`;
}

function speciesInfo(key) {
  const normalized = String(key ?? "").toLowerCase();
  const info = SPECIES[normalized];
  if (info) return { key: normalized, ...info };
  return { key: normalized, dex: null, label: key ?? "--" };
}

function spriteSrc(key) {
  return LOCAL_SPRITES.has(key) ? `/sprites/${key}` : "";
}

function hearts(bond) {
  if (bond == null) return "--";
  const count = Math.max(0, Math.min(5, Math.round(Number(bond) / 40)));
  return `${"♥".repeat(count)}${"♡".repeat(5 - count)} ${bond}`;
}

function formatPct(value) {
  return value == null ? "--" : `${Math.round(Number(value))}%`;
}

function formatMoney(value) {
  return value == null ? "$--" : `$${Number(value).toFixed(2)}`;
}

function formatTokens(value) {
  if (value == null) return "-- tok";
  const n = Number(value);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k tok`;
  return `${n} tok`;
}

function formatTemp(value) {
  return value == null ? "--°" : `${Number(value).toFixed(1).replace(/\.0$/, "")}°`;
}

function formatRange(lo, hi) {
  return lo == null || hi == null ? "--/--" : `${formatTemp(lo)}-${formatTemp(hi)}`;
}

function shortDate(value) {
  if (!value) return "--";
  const parts = String(value).split("-");
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : value;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setInput(id, value) {
  const input = document.getElementById(id);
  if (input && document.activeElement !== input) input.value = value;
}

function valueOf(id) {
  return document.getElementById(id).value;
}

function numberOf(id) {
  const raw = document.getElementById(id).value;
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function buildSettingsBody() {
  const body = {};
  body.name = valueOf("settings-name").trim();
  const hasQuietStart = valueOf("quiet-start").trim() !== "";
  const hasQuietEnd = valueOf("quiet-end").trim() !== "";
  if (hasQuietStart !== hasQuietEnd) {
    throw new Error("quietHours start/end must both be filled");
  }
  const start = numberOf("quiet-start");
  const end = numberOf("quiet-end");
  if (start !== undefined && end !== undefined) body.quietHours = { start, end };
  const volume = numberOf("settings-volume");
  if (volume !== undefined) body.volume = volume;
  const lat = numberOf("settings-lat");
  if (lat !== undefined) body.lat = lat;
  const lon = numberOf("settings-lon");
  if (lon !== undefined) body.lon = lon;
  return body;
}

function setStatus(message, error = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", error);
}
