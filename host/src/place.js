// Which of the two places the host is sitting in, answered by the WiFi it is
// joined to. The device travels; the machines do not, but a machine's hostname
// is a worse answer than its network -- a laptop that moves would keep claiming
// the wrong one, and the question the panel is really asking is "which network
// am I on", which is exactly what this reads.
//
// The SSID -> place map lives in config.json, which is per-machine and
// untracked. That keeps both SSIDs out of the public repo, and it is the same
// file every other per-machine fact already lives in.
import { execFile } from "node:child_process";

export const PLACES = ["work", "home"];

// Windows only, which is both machines. `netsh` prints one "SSID" line per
// interface plus a "BSSID" line that also contains the substring, so the match
// is anchored to the start of the trimmed line.
export function readWifiSsid({ run = defaultRun, platform = process.platform } = {}) {
  if (platform !== "win32") return Promise.resolve(null);
  return run(["wlan", "show", "interfaces"]).then((output) => parseSsid(output), () => null);
}

export function parseSsid(output) {
  for (const raw of String(output ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    // "BSSID" also starts with a B, not an S -- but "AP BSSID" does not start
    // with SSID either way, so a plain startsWith is enough and stays readable.
    if (!line.startsWith("SSID")) continue;
    const value = line.slice(line.indexOf(":") + 1).trim();
    if (value) return value;
  }
  return null;
}

// An SSID nobody has named resolves to null rather than to a guess. Getting it
// wrong is worse than saying nothing: the panel would cheerfully tell him to
// rest at home while he is sitting at his desk.
export function placeFromSsid(ssid, places) {
  if (typeof ssid !== "string" || !ssid) return null;
  const place = places?.[ssid];
  return PLACES.includes(place) ? place : null;
}

// No configured SSIDs means nothing could resolve, so do not pay for the
// subprocess to find that out. This is not just tidiness: the tick calls this
// inside the animator pause, and every test that drives a tick has no `places`
// at all -- spawning netsh there slowed the tick enough to start losing the
// main-orchestration races the handoff already tracks.
export async function resolvePlace({ places, run, platform } = {}) {
  if (!places || Object.keys(places).length === 0) return null;
  return placeFromSsid(await readWifiSsid({ run, platform }), places);
}

function defaultRun(args) {
  return new Promise((resolve, reject) => {
    execFile("netsh", args, { windowsHide: true, timeout: 4000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout ?? "");
    });
  });
}
