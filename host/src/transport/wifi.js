// WiFi transport: discovers the device via mDNS (_cpb._tcp.local) and connects
// out as a TCP client, then hands the connected socket to serial.js's
// makeTransport() — the byte-stream framing, ACK/retry queueing, HELLO
// tracking, and reconnect logic are all transport-agnostic already, so the
// only WiFi-specific work here is "how do I find and open a connection" plus
// sending the pre-shared pairing token as the first thing on every connect.
import net from "node:net";

import { Bonjour } from "bonjour-service";

import { encodeFrame, T } from "./proto.js";
import { makeTransport } from "./serial.js";

const SERVICE_TYPE = "cpb"; // advertised by firmware as _cpb._tcp.local
export const DEFAULT_DISCOVER_TIMEOUT_MS = 4000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

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
  host,
  port,
  token,
  ...transportOptions
} = {}) {
  if (!token) throw new Error("createWifiTransport requires a pairing token");

  const openPort = async () => {
    const target = host && port ? { host, port } : await findWifiHost({ BonjourImpl, timeoutMs: discoverTimeoutMs });
    if (!target) return null;

    const socket = await connectSocket(netConnect, target, connectTimeoutMs);
    if (!socket) return null;

    if (!sendAuth(socket, token)) {
      closeQuietly(socket);
      return null;
    }
    return adaptSocket(socket);
  };

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
