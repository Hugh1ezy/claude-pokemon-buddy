const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function layoutText(model = {}) {
  const weather = model.weather ?? {};
  const weatherLabel = weather.degraded ? "degraded" : (weather.cond ?? "--");
  const now = dateOrNow(model.now);

  return {
    clock: formatClock(model.clock, now),
    date: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
    weekday: WEEKDAYS_ZH[now.getDay()],
    p5h: percentText(model.p5h),
    pweek: percentText(model.pweek),
    rateNote: model.rateStale ? "stale" : "",
    resets5h: formatReset(model.resets5h, now),
    resetsWeek: formatReset(model.resetsWeek, now),
    today: `今日 $${moneyShort(model.todayCost)}·${tokensShort(model.todayTokens)}`,
    weatherMain: `${weatherLabel} ${value(weather.temp)}°`,
    weatherFeels: `体感${value(weather.feels)}°`,
    weatherDetail: `高${value(weather.hi)}°低${value(weather.lo)}° 降雨概率${value(weather.precip)}% 风速${value(weather.wind)}`,
  };
}

export function money(v) {
  if (v == null) return "--";
  const n = Number(v);
  if (!Number.isFinite(n)) return "--";
  if (Math.abs(n) >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(1)}T`;
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}

// Compact money for the 24px today line: integer dollars once >= $10 — the
// exact figure lives in the web dashboard; the panel is for at-a-glance reading.
function moneyShort(v) {
  if (v == null) return "--";
  const n = Number(v);
  if (!Number.isFinite(n)) return "--";
  if (Math.abs(n) >= 10_000) return money(n);
  if (Math.abs(n) >= 10) return String(Math.round(n));
  return n.toFixed(1);
}

export function formatReset(value, now = new Date()) {
  if (typeof value !== "string" || value.length === 0) return "reset unknown";
  const reset = new Date(value);
  const base = dateOrNow(now);
  if (!Number.isFinite(reset.getTime())) return "reset unknown";

  if (isSameLocalDate(reset, base)) {
    const minutes = Math.max(0, Math.ceil((reset.getTime() - base.getTime()) / 60_000));
    if (minutes <= 0) return "now";
    if (minutes < 60) return `in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins === 0 ? `in ${hours}h` : `in ${hours}h${mins}m`;
  }

  if (isSameLocalDate(reset, addLocalDays(base, 1))) {
    return `tomorrow ${hhmm(reset)}`;
  }

  return `${MONTHS[reset.getMonth()]} ${pad2(reset.getDate())}, ${hhmm(reset)}`;
}

function tokens(v) {
  if (v == null) return "--";
  const n = Number(v);
  if (!Number.isFinite(n)) return "--";
  if (Math.abs(n) >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(1)}T`;
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

// Compact tokens for the today line: keep exactly one decimal in every
// K/M/B/T bucket so readings stay consistent (no "45.3M" vs "401M" flip).
// Width verified to fit the 14px panel.
function tokensShort(v) {
  if (v == null) return "--";
  const n = Number(v);
  if (!Number.isFinite(n)) return "--";
  const scaled = (x) => x.toFixed(1);
  if (Math.abs(n) >= 1_000_000_000_000) return `${scaled(n / 1_000_000_000_000)}T`;
  if (Math.abs(n) >= 1_000_000_000) return `${scaled(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${scaled(n / 1_000_000)}M`;
  if (n >= 1_000) return `${scaled(n / 1_000)}K`;
  return String(Math.round(n));
}

function value(v) {
  if (v == null) return "--";
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n)) : "--";
}

function percentText(v) {
  if (v == null) return "--";
  const n = Number(v);
  if (!Number.isFinite(n)) return "--";
  return String(Math.max(0, Math.min(100, Math.round(n))));
}

function formatClock(clock, now = new Date()) {
  if (typeof clock === "string" && clock.length > 0) return clock;
  return hhmm(now);
}

function dateOrNow(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function isSameLocalDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function addLocalDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function hhmm(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}
