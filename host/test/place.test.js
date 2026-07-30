import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSsid, placeFromSsid, readWifiSsid, resolvePlace } from "../src/place.js";

// Real `netsh wlan show interfaces` output, trimmed. The trap is the BSSID
// line: it contains the substring "SSID" and sits directly under the one that
// matters, so a naive includes() returns a MAC address as the network name.
const NETSH = `
There is 1 interface on the system:

    Name                   : WLAN
    Description            : Intel(R) Wi-Fi 6 AX201 160MHz
    State                  : connected
    SSID                   : DN8245-E9B6
    AP BSSID               : 34:58:40:aa:e9:c8
    Band                   : 5 GHz
`;

test("the SSID is read from the SSID line, not the BSSID line under it", () => {
  assert.equal(parseSsid(NETSH), "DN8245-E9B6");
});

test("output with no network at all parses to null rather than a stray value", () => {
  assert.equal(parseSsid("There is 1 interface on the system:\n\n    State : disconnected\n"), null);
  assert.equal(parseSsid(""), null);
  assert.equal(parseSsid(undefined), null);
  // An SSID key with an empty value is "connected to nothing", not an SSID of "".
  assert.equal(parseSsid("    SSID                   : \n"), null);
});

test("an SSID nobody has named resolves to null, never to a guess", () => {
  const places = { "DN8245-E9B6": "work", "HomeNet-5G": "home" };

  assert.equal(placeFromSsid("DN8245-E9B6", places), "work");
  assert.equal(placeFromSsid("HomeNet-5G", places), "home");
  // The panel would otherwise tell him to rest at home while he is at his desk.
  assert.equal(placeFromSsid("SomeCafe", places), null);
  assert.equal(placeFromSsid(null, places), null);
  assert.equal(placeFromSsid("DN8245-E9B6", undefined), null);
  assert.equal(placeFromSsid("DN8245-E9B6", {}), null);
});

test("a config naming a place that is not one of the two is ignored", () => {
  assert.equal(placeFromSsid("X", { X: "office" }), null);
  assert.equal(placeFromSsid("X", { X: "" }), null);
  assert.equal(placeFromSsid("X", { X: 7 }), null);
});

test("a netsh that fails or hangs resolves to null instead of throwing into the tick", async () => {
  const rejects = () => Promise.reject(new Error("netsh is not recognised"));
  assert.equal(await readWifiSsid({ run: rejects }), null);
  assert.equal(await resolvePlace({ run: rejects, places: { a: "work" } }), null);
});

test("a non-Windows host never shells out at all", async () => {
  let called = false;
  const run = () => { called = true; return Promise.resolve(NETSH); };

  assert.equal(await readWifiSsid({ run, platform: "darwin" }), null);
  assert.equal(called, false, "netsh must not be spawned off Windows");
});

// The tick calls this inside the animator pause, and every test that drives a
// tick has no `places` configured. Spawning netsh for a lookup that cannot
// succeed cost enough to start losing the main-orchestration races.
test("resolvePlace does not shell out when no SSIDs are configured", async () => {
  let called = false;
  const run = () => { called = true; return Promise.resolve(NETSH); };

  for (const places of [undefined, null, {}]) {
    assert.equal(await resolvePlace({ run, platform: "win32", places }), null);
  }
  assert.equal(called, false, "netsh must not be spawned when nothing could match");
});

test("resolvePlace goes from netsh output to a place in one call", async () => {
  const place = await resolvePlace({
    run: () => Promise.resolve(NETSH),
    platform: "win32",
    places: { "DN8245-E9B6": "work" },
  });

  assert.equal(place, "work");
});
