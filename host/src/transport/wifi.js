// WiFi transport: discovers the device via mDNS (_cpb._tcp.local) and connects
// out as a TCP client, then hands the connected socket to serial.js's
// makeTransport() — the byte-stream framing, ACK/retry queueing, HELLO
// tracking, and reconnect logic are all transport-agnostic already, so the
// only WiFi-specific work here is "how do I find and open a connection" plus
// sending the pre-shared pairing token as the first thing on every connect.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname } from "node:path";

import { Bonjour } from "bonjour-service";

import { encodeFrame, T } from "./proto.js";
import { makeTransport } from "./serial.js";

const SERVICE_TYPE = "cpb"; // advertised by firmware as _cpb._tcp.local
export const DEFAULT_DISCOVER_TIMEOUT_MS = 4000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
// The remembered address is tried before browsing, so its timeout is a "is it
// there yet" probe, not a real connect budget. A device on the same LAN answers
// in tens of milliseconds; anything longer is it not being up, and waiting
// longer does not change the answer. Measured: at 1200ms this was the single
// biggest component of the wake latency after a device came back from
// power-save.
export const DEFAULT_CACHED_CONNECT_TIMEOUT_MS = 400;
// How many times in a row the remembered address may fail before we pay for a
// full mDNS browse. A device that is merely still booting fails this probe
// several times, and the browse cannot help with that -- it just makes that
// retry cycle longer for no information. Discovery is for a device that
// actually moved, which is rare and can afford a few cheap retries first.
//
// Raised from 4 once it was clear what a browse costs in practice: while it
// runs, the cheap check is not running, so the host is blind to the device
// coming back for the whole of it. Fewer browses means fewer windows in which
// a device that just reappeared goes unnoticed.
export const DEFAULT_DISCOVER_AFTER_CACHED_FAILURES = 8;
// Discovery that follows a remembered address which stopped answering does not
// need the full budget: we are not lost, we are double-checking a belief. A
// device that is present answers a browse in well under this. The cold-start
// case (no remembered address, genuinely nothing to go on) keeps the longer
// DEFAULT_DISCOVER_TIMEOUT_MS.
export const DEFAULT_STALE_DISCOVER_TIMEOUT_MS = 1500;

// Browses for the device's mDNS service and resolves its current host:port.
// Returns null if nothing answers within timeoutMs (mirrors findEspPort's
// "not found -> null" contract in serial.js).
export async function findWifiHost({ BonjourImpl = Bonjour, timeoutMs = DEFAULT_DISCOVER_TIMEOUT_MS } = {}) {
  const bonjour = new BonjourImpl();
  try {
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        browser.stop?.();
        resolve(result);
      };
      const browser = bonjour.find({ type: SERVICE_TYPE }, (service) => {
        const host = service.referer?.address ?? service.addresses?.[0];
        if (!host || !service.port) return;
        finish({ host, port: service.port });
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
    });
  } finally {
    bonjour.destroy?.();
  }
}

export async function createWifiTransport({
  BonjourImpl = Bonjour,
  netConnect = net.connect,
  discoverTimeoutMs = DEFAULT_DISCOVER_TIMEOUT_MS,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  cachedConnectTimeoutMs = DEFAULT_CACHED_CONNECT_TIMEOUT_MS,
  discoverAfterCachedFailures = DEFAULT_DISCOVER_AFTER_CACHED_FAILURES,
  staleDiscoverTimeoutMs = DEFAULT_STALE_DISCOVER_TIMEOUT_MS,
  // No cache unless the caller wires one (transport/index.js does). Defaulting
  // to a real file here would make every test read whatever the developer's
  // own machine last connected to.
  addressCache = null,
  host,
  port,
  token,
  logger = null,
  ...transportOptions
} = {}) {
  if (!token) throw new Error("createWifiTransport requires a pairing token");

  // Browsing is the slowest and least reliable step, and on Windows it is also
  // the flakiest: the DNS Client service owns UDP 5353, so bonjour-service is
  // competing with it for the multicast replies and loses often enough that a
  // browse can time out entirely while the device is demonstrably reachable.
  // Measured on the work PC: four browses in a row, 4s each, zero answers,
  // with an established TCP session to the device the whole time. Since each
  // miss costs a full discover timeout plus a reconnect delay, the erratic
  // 10-18s reconnects were mostly this. So: remember the address that last
  // worked and try it first, and keep mDNS as the fallback that finds the
  // device when it has genuinely moved.
  const openPort = async () => {
    if (host && port) return await open({ host, port });

    // Validated here rather than in the cache implementation: this is the
    // point of use, and it has to hold for any cache the caller injects.
    const remembered = validAddress(addressCache?.read());
    if (remembered) {
      const viaCache = await open(remembered, cachedConnectTimeoutMs);
      if (viaCache) {
        addressCache.noteHit?.();
        return viaCache;
      }
      // The miss count lives on the cache, not here: createTransport builds a
      // fresh createWifiTransport on every probe, so a counter held in this
      // closure would reset each time and the escalation below would never
      // fire -- a device that changed IP would then never be rediscovered.
      // A cache that does not track misses escalates immediately, which is the
      // old behaviour and the safe default.
      const misses = addressCache.noteMiss?.() ?? Infinity;
      if (misses < discoverAfterCachedFailures) {
        // Cheap miss. Let the caller's normal retry come back around rather
        // than spending 4s browsing for an address we already believe in --
        // the usual reason this failed is that the device is still coming up.
        return null;
      }
      logger?.warn?.("wifi: remembered address failed repeatedly; falling back to mDNS");
      const rediscovered = await findWifiHost({ BonjourImpl, timeoutMs: staleDiscoverTimeoutMs });
      if (!rediscovered) return null;   // back to the cheap loop
      const socket = await open(rediscovered);
      if (socket) addressCache?.write(rediscovered);
      return socket;
    }

    const found = await findWifiHost({ BonjourImpl, timeoutMs: discoverTimeoutMs });
    if (!found) return null;
    const socket = await open(found);
    if (socket) addressCache?.write(found);
    return socket;
  };

  async function open(target, timeoutMs = connectTimeoutMs) {
    const socket = await connectSocket(netConnect, target, timeoutMs);
    if (!socket) return null;
    if (!sendAuth(socket, token)) {
      closeQuietly(socket);
      return null;
    }
    return adaptSocket(socket);
  }

  const first = await openPort();
  if (!first) return null;
  return makeTransport({ port: first, openPort, ...transportOptions });
}

function connectSocket(netConnect, { host, port }, timeoutMs) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = netConnect({ host, port });
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      closeQuietly(socket);
      finish(null);
    }, timeoutMs);

    socket.once("connect", () => finish(socket));
    socket.once("error", () => finish(null));
  });
}

function sendAuth(socket, token) {
  try {
    socket.write(encodeFrame({ type: T.AUTH, seq: 0, payload: Uint8Array.from(Buffer.from(token, "utf8")) }));
    return true;
  } catch {
    return false;
  }
}

function closeQuietly(socket) {
  try {
    socket?.destroy?.();
  } catch {
    // Ignore errors closing a socket we're abandoning anyway.
  }
}

// makeTransport (serial.js) expects a "port"-shaped object: write(bytes, cb),
// on("data"/"close"/"error"), close(). net.Socket already matches everything
// except close() (it has destroy() instead), so alias it.
function adaptSocket(socket) {
  if (typeof socket.close !== "function") socket.close = () => socket.destroy();
  return socket;
}

// Deliberately lossy: a missing, unreadable or malformed cache just means "no
// shortcut this time", never an error. The mDNS path behind it is the source
// of truth, so there is nothing here worth failing a connection over.
export function validAddress(value) {
  const portOk = Number.isInteger(value?.port) && value.port > 0 && value.port < 65536;
  return typeof value?.host === "string" && value.host.length > 0 && portOk
    ? { host: value.host, port: value.port }
    : null;
}

export function fileAddressCache(path) {
  // In memory on purpose: "how many probes in a row has this address ignored"
  // is about the current outage, not something to carry across host restarts.
  // It lives here rather than in createWifiTransport because the cache is the
  // object with the right lifetime -- one per host, not one per probe.
  let consecutiveMisses = 0;
  return {
    read() {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return null;
      }
    },
    write({ host, port }) {
      consecutiveMisses = 0;
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ host, port }));
      } catch {
        // A cache we cannot persist only costs the next reconnect a browse.
      }
    },
    noteHit() { consecutiveMisses = 0; },
    noteMiss() { return (consecutiveMisses += 1); },
  };
}
