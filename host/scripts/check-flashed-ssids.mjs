#!/usr/bin/env node
// Verifies a built firmware image actually carries every configured network,
// without printing any of them.
//
//   node scripts/check-flashed-ssids.mjs \
//     ../firmware/main/wifi_creds.h ../firmware/build/pokemon_buddy_fw.bin
//
// Exit 0 = safe to flash. Non-zero = do not flash.
//
// This is the 2026-07-27 trap, and counting entries in wifi_creds.h does not
// catch it: CMake evaluates the `EXISTS` check on that file at CONFIGURE time,
// so a build that never saw it compiles the placeholder credentials in and
// reports success. The device then joins wherever you are standing and silently
// fails to join anywhere else, and the symptom — stuck on the clock face, button
// apparently dead — reads as broken hardware.
//
// Output is index-and-verdict only. The SSIDs are the one thing `wifi_creds.h`
// is gitignored to keep out of a public repo, so they must not reach a terminal,
// a log, or a commit message either.
import { readFileSync } from "node:fs";

const [credsPath, binPath] = process.argv.slice(2);
if (!credsPath || !binPath) {
  console.error("usage: check-flashed-ssids.mjs <wifi_creds.h> <firmware.bin>");
  process.exit(2);
}

const creds = readFileSync(credsPath, "utf8");
// latin1 keeps one byte to one char, so indexes into the haystack stay honest
// for any SSID that is not pure ASCII.
const hay = readFileSync(binPath).toString("latin1");

const entries = [...creds.matchAll(/\{\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\}/g)];
if (entries.length === 0) {
  console.error("FAIL: no credential entries parsed out of the header");
  process.exit(1);
}

let missing = 0;
entries.forEach(([, ssid], i) => {
  const present = hay.includes(ssid);
  if (!present) missing++;
  console.log(`  network #${i + 1}: ssid ${present ? "PRESENT" : "MISSING"} (${ssid.length} chars)`);
});

const placeholder = /YOUR_(SSID|WORK_SSID|HOME_SSID|PASSWORD)/.test(hay);
console.log(`  entries configured : ${entries.length}`);
console.log(`  placeholder strings: ${placeholder ? "PRESENT -- this build never saw wifi_creds.h" : "absent"}`);

const ok = missing === 0 && !placeholder;
console.log(ok ? "OK: every configured network is in the image" : "FAIL: do not flash this image");
process.exit(ok ? 0 : 1);
