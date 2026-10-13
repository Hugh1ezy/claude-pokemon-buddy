// The "why" line: one short sentence under an evolution or a wild encounter
// that only happened because a hidden condition was met. Owner's ask,
// 2026-10-13 -- once the thing has happened in front of him, say what it took.
//
// Species-free on purpose, like encounter.js: this file knows how to put a
// condition into words and nothing about which pokemon carries which. It is
// handed the `needs` of whatever just fired and never the table.
//
// The rule for what counts as hidden: a level is not. Evolving at a level is
// public Gen-1 knowledge, so a branch that asks for nothing else gets no line,
// and neither does an encounter with no conditions at all.

const WEATHER = { sun: "晴天", rain: "雨天", fog: "雾天" };
const MOOD = { strained: "吃力", fainted: "力竭", focused: "专注", happy: "开心" };
const WEEKDAY = { mon: "周一", tue: "周二", wed: "周三", thu: "周四", fri: "周五", sat: "周六", sun: "周日" };

const any = (map) => (v) => (Array.isArray(v) ? v : [v]).map((key) => map[key] ?? key).join("/");
const weekdays = (v) => {
  const days = Array.isArray(v) ? v : [v];
  if (days.length === 2 && days.includes("sat") && days.includes("sun")) return "周末";
  return any(WEEKDAY)(days);
};

// Listed in the order they should be read: what the moment was like first,
// what the owner had built up second. A line that has to be cut loses its tail.
const ENCOUNTER_WORDS = [
  ["weather", any(WEATHER)],
  ["night", (v) => (v ? "夜晚" : "白天")],
  ["daytime", (v) => (v ? "白天" : "夜晚")],
  ["hourFrom", (v) => `${v}点后`],
  ["hourBefore", (v) => `${v}点前`],
  ["weekday", weekdays],
  ["tempAtLeast", (v) => `气温≥${v}°`],
  ["tempBelow", (v) => `气温<${v}°`],
  ["humidityAtLeast", (v) => `湿度≥${v}%`],
  ["windAtLeast", (v) => `风速≥${v}`],
  ["roomTempAtLeast", (v) => `室温≥${v}°`],
  ["roomTempBelow", (v) => `室温<${v}°`],
  ["batteryBelow", (v) => `电量<${v}%`],
  ["usageAtLeast", (v) => `Current≥${v}%`],
  ["usageBelow", (v) => `Current<${v}%`],
  ["weekUsageAtLeast", (v) => `Week≥${v}%`],
  ["mood", any(MOOD)],
  ["bondAtLeast", (v) => `亲密度≥${v}`],
  ["levelAtLeast", (v) => `Lv≥${v}`],
  ["streakAtLeast", (v) => `连续${v}天`],
  ["careAtLeast", (v) => `摸头≥${v}次`],
  ["dexAtLeast", (v) => `图鉴≥${v}`],
  // `notTheStarter` is deliberately absent: it is true of every wild pokemon
  // this save will ever meet, so it explains nothing about this one.
  // `caughtAll` needs names and is worded by the caller-supplied `nameOf`.
];

const EVOLUTION_WORDS = [
  ["weatherKind", any(WEATHER)],
  ["night", (v) => (v ? "夜晚" : "白天")],
  ["daytime", (v) => (v ? "白天" : "夜晚")],
  ["warmHumid", () => "温暖潮湿"],
  ["cold", () => "寒冷"],
  ["care", () => "被摸过头"],
  ["careCount", (v) => `摸头≥${v}次`],
  ["bond", (v) => `亲密度≥${v}`],
  ["streak", (v) => `连续${v}天`],
  ["level", (v) => `Lv≥${v}`],
];

export function encounterRevealParts(needs, { nameOf = (key) => key } = {}) {
  const parts = wordsFor(needs, ENCOUNTER_WORDS);
  const all = needs?.caughtAll;
  if (all != null) parts.push(`已收服${(Array.isArray(all) ? all : [all]).map(nameOf).join("、")}`);
  return parts;
}

// Empty for a branch that asks only for a level -- see the rule at the top.
export function evolutionRevealParts(needs) {
  const keys = Object.keys(needs ?? {});
  if (keys.every((key) => key === "level")) return [];
  return wordsFor(needs, EVOLUTION_WORDS);
}

// Joins as many parts as fit. `measure` is the renderer's own text measure, so
// this stays free of any canvas; a part that does not fit takes everything
// after it with it and leaves an ellipsis, rather than running off the glass.
export function fitReveal(parts, { measure, maxWidth, prefix = "★ ", joiner = " · " } = {}) {
  if (!Array.isArray(parts) || parts.length === 0) return null;
  let text = prefix + parts[0];
  for (let i = 1; i < parts.length; i += 1) {
    const next = text + joiner + parts[i];
    if (measure && measure(next) > maxWidth) return `${text}…`;
    text = next;
  }
  return text;
}

function wordsFor(needs, table) {
  if (!needs || typeof needs !== "object") return [];
  const out = [];
  for (const [key, word] of table) {
    if (needs[key] != null) out.push(word(needs[key]));
  }
  return out;
}
