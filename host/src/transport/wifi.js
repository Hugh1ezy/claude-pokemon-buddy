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
// still there" probe, not a real connect budget -- keep it short enough that a
// stale entry costs less than the browse it is trying to skip.
export const DEFAULT_CACHED_CONNECT_TIMEOUT_MS = 1200;

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
      if (viaCache) return viaCache;
      logger?.warn?.("wifi: remembered address did not answer; falling back to mDNS");
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
  return {
    read() {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return null;
      }
    },
    write({ host, port }) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ host, port }));
      } catch {
        // A cache we cannot persist only costs the next reconnect a browse.
      }
    },
  };
}
