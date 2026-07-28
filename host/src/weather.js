const WMO = {
  0: "晴",
  1: "晴",
  2: "多云",
  3: "多云",
  45: "雾",
  48: "雾",
  51: "小雨",
  61: "小雨",
  63: "雨",
  71: "雪",
  80: "阵雨",
  95: "雷雨",
};

// The coarse kind the encounter conditions are written against, resolved here
// from the WMO code rather than downstream from `cond` -- the panel's label is
// for a human to read and is free to change wording, while this is a key some
// species are gated on and must not drift with it.
//
// Codes with no entry deliberately produce `kind: null`: 多云 and 雪 are not
// kinds any condition asks for, and a weather-gated species should then simply
// not be eligible rather than be forced into the nearest bucket.
const WMO_KIND = {
  0: "sun",
  1: "sun",
  45: "fog",
  48: "fog",
  51: "rain",
  61: "rain",
  63: "rain",
  80: "rain",
  95: "rain",
};

const FETCH_TIMEOUT_MS = 10_000;

export function makeWeather({
  fetch = globalThis.fetch,
  ttlMs = 30 * 60 * 1000,
  timeoutSignal = defaultTimeoutSignal,
} = {}) {
  let last = null;
  let lastAt = 0;
  let lastKey = null;

  return {
    async get(lat, lon) {
      const now = Date.now();
      const key = `${lat},${lon}`;
      if (last && key === lastKey && now - lastAt < ttlMs) return { ...last, degraded: false };

      try {
        const response = await fetch(weatherUrl(lat, lon), {
          signal: timeoutSignal(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error("weather request failed");

        const json = await response.json();
        last = normalizeWeather(json);
        lastAt = now;
        lastKey = key;
        return { ...last, degraded: false };
      } catch {
        return last && key === lastKey
          ? { ...last, degraded: true }
          : nullWeather();
      }
    },
  };
}

function defaultTimeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), ms);
  timer.unref?.();
  return controller.signal;
}

// Deliberately partial -- no `feels`, `humidity`, `wind`, and no `kind` either.
// There is no weather here to classify, and the encounter context reads a
// missing kind as "no weather-gated species right now", which is the truth.
function nullWeather() {
  return { cond: "—", temp: null, degraded: true };
}

function weatherUrl(lat, lon) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
  );
  url.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
  );
  url.searchParams.set("timezone", "auto");
  return url;
}

function normalizeWeather(json) {
  const current = json.current;
  const daily = json.daily;

  return {
    cond: WMO[current.weather_code] ?? "—",
    kind: WMO_KIND[current.weather_code] ?? null,
    temp: rounded(current.temperature_2m),
    feels: rounded(current.apparent_temperature),
    humidity: rounded(current.relative_humidity_2m),
    hi: rounded(firstDailyValue(daily, "temperature_2m_max")),
    lo: rounded(firstDailyValue(daily, "temperature_2m_min")),
    precip: rounded(firstDailyValue(daily, "precipitation_probability_max")),
    wind: rounded(current.wind_speed_10m),
  };
}

function firstDailyValue(daily, key) {
  const values = daily?.[key];
  if (!Array.isArray(values) || values.length === 0) throw new Error("weather number missing");
  return values[0];
}

function rounded(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("weather number missing");
  return Math.round(value);
}
