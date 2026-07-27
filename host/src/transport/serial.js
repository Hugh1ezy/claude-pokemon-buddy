import { EventEmitter } from "node:events";

import { SerialPort as NodeSerialPort } from "serialport";

import { encodeFrame, PROTO_VER, SND_COUNT, T } from "./proto.js";
import { appendBytes, ackSeq, parseButton, parseHello, parseSensor, pumpFrames, volumeByte } from "./framing.js";

const ESPRESSIF_VID = "303A";
const PORT_GUARDED = Symbol("serialPortErrorsGuarded");
const DEFAULT_BAUD_RATE = 115200;
const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RECONNECT_DELAY_MS = 1500;

export async function findEspPort({ SerialPort = NodeSerialPort } = {}) {
  const ports = await SerialPort.list();
  return ports.find((port) => normalizeVid(port.vendorId) === ESPRESSIF_VID)?.path ?? null;
}

export async function createSerialTransport({
  SerialPort = NodeSerialPort,
  baudRate = DEFAULT_BAUD_RATE,
  path,
  port,
  ...transportOptions
} = {}) {
  if (port) return makeTransport({ port, ...transportOptions });

  const openPort = async () => {
    const found = path ?? await findEspPort({ SerialPort });
    if (!found) return null;

    const sp = new SerialPort({ path: found, baudRate, autoOpen: false });
    guardPortErrors(sp, transportOptions.logger);
    const opened = await new Promise((resolve) => {
      sp.open((error) => resolve(!error));
    });
    if (!opened) {
      try {
        sp.close?.();
      } catch {
        // Ignore close errors while probing for a usable serial port.
      }
      return null;
    }
    return sp;
  };

  const first = await openPort();
  if (!first) return null;
  return makeTransport({
    port: first,
    openPort,
    ...transportOptions,
  });
}

export function makeTransport({
  port,
  openPort,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  logger = console,
} = {}) {
  if (!port) throw new Error("port is required");

  const events = new EventEmitter();
  const queue = [];
  const rxState = { rx: new Uint8Array(0) };
  let pending = null;
  let currentPort = port;
  let connected = !!port;
  let reconnectTimer = null;
  let stopped = false;
  let detachPort = () => {};
  let nextSeq = 0;
  let latestSensor = null;
  let latestHello = null;
  let warnedProtoMismatch = false;
  let warnedSoundMismatch = false;

  attachPort(port);

  function pushFrame(payload) {
    if (!connected) return Promise.resolve({ ok: false, disconnected: true });

    return new Promise((resolve) => {
      queue.push({
        type: T.FRAME,
        payload: Uint8Array.from(payload),
        resolve,
      });
      pump();
    });
  }

  function pump() {
    if (!connected || pending || queue.length === 0) return;
    pending = {
      ...queue.shift(),
      seq: nextSeq,
      sends: 0,
      timer: null,
    };
    nextSeq = (nextSeq + 1) & 0xff;
    sendPending();
  }

  function sendPending() {
    const current = pending;
    current.sends += 1;
    const bytes = encodeFrame({
      type: current.type,
      seq: current.seq,
      payload: current.payload,
    });
    clearTimeout(current.timer);
    current.timer = setTimeout(() => {
      if (pending !== current) return;
      retryPendingOrFinish(current);
    }, retryTimeoutFor(current.payload.length));
    try {
      currentPort.write(bytes, (error) => {
        if (error && pending === current) handleDisconnect();
      });
    } catch {
      if (pending === current) handleDisconnect();
    }
  }

  function readAvailableFrames() {
    pumpFrames(rxState, handleFrame);
  }

  function handleFrame(frame) {
    if (frame.type === T.ACK) {
      if (pending && ackSeq(frame) === pending.seq) {
        finishPending({ ok: true, seq: pending.seq });
      }
      return;
    }

    if (frame.type === T.NACK) {
      if (pending && ackSeq(frame) === pending.seq) retryPendingOrFinish(pending);
      return;
    }

    if (frame.type === T.HELLO) {
      handleHello(frame.payload);
      return;
    }

    if (frame.type === T.BUTTON) {
      const button = parseButton(frame.payload);
      if (button) events.emit("button", button);
      return;
    }

    if (frame.type === T.SENSOR) {
      latestSensor = parseSensor(frame.payload);
      if (latestSensor) events.emit("sensor", latestSensor);
      return;
    }

    if (frame.type === T.RESYNC) {
      // Device drew something on its own (e.g. local-clock mode) outside the
      // host's diff tracking. Reuse the same "reconnect" signal a fresh port
      // attach emits so transport/index.js resets previousBytes and forces a
      // full-frame repaint instead of a stale diff that would leave the
      // device's leftover pixels uncorrected wherever the new frame happens
      // to match the host's last-known bitmap.
      //
      // Logged because this is the only host-side evidence of the moment the
      // panel stops showing the clock face. "How long until it switches back"
      // is measured from the transport attaching to this line -- without it
      // there is nothing to time against except someone watching the screen.
      logger?.log?.("device left local-clock mode (RESYNC)");
      events.emit("reconnect");
    }
  }

  function finishPending(result) {
    const current = pending;
    clearTimeout(current.timer);
    pending = null;
    current.resolve(result);
    pump();
  }

  function retryPendingOrFinish(current) {
    if (pending !== current) return;
    if (current.sends <= maxRetries) {
      sendPending();
      return;
    }
    finishPending({ ok: false, stale: true, seq: current.seq });
  }

  function handleHello(payload) {
    const hello = parseHello(payload);
    if (!hello) return;
    latestHello = hello;
    if (hello.protoVer !== PROTO_VER && !warnedProtoMismatch) {
      warnedProtoMismatch = true;
      logger?.warn?.(`ESP firmware protocol version ${hello.protoVer} does not match host protocol version ${PROTO_VER}`);
    }
    if (hello.sndCount < SND_COUNT && !warnedSoundMismatch) {
      warnedSoundMismatch = true;
      logger?.warn?.(`ESP firmware sound table has ${hello.sndCount} sounds; host requires ${SND_COUNT}`);
    }
  }

  function handleDisconnect() {
    if (!connected) return;

    connected = false;
    rxState.rx = new Uint8Array(0);
    latestSensor = null;
    detachPort();
    resolveDisconnected();
    events.emit("disconnect");
    if (openPort && !stopped) scheduleReconnect();
  }

  function resolveDisconnected() {
    const result = { ok: false, disconnected: true };
    if (pending) {
      const current = pending;
      clearTimeout(current.timer);
      pending = null;
      current.resolve(result);
    }
    while (queue.length > 0) {
      queue.shift().resolve(result);
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(tryReconnect, reconnectDelayMs);
  }

  async function tryReconnect() {
    reconnectTimer = null;
    if (stopped) return;

    let nextPort = null;
    try {
      nextPort = await openPort();
    } catch {
      nextPort = null;
    }

    if (stopped) {
      try {
        nextPort?.close?.();
      } catch {
        // A synchronous throw from close() must not escape as an unhandled rejection on shutdown.
      }
      return;
    }

    if (!nextPort) {
      scheduleReconnect();
      return;
    }

    currentPort = nextPort;
    attachPort(nextPort);
    connected = true;
    events.emit("reconnect");
    pump();
  }

  function attachPort(nextPort) {
    detachPort();
    guardPortErrors(nextPort, logger);

    const onData = (chunk) => {
      rxState.rx = appendBytes(rxState.rx, chunk);
      readAvailableFrames();
    };
    const onClose = () => {
      handleDisconnect();
    };
    const onError = () => {
      handleDisconnect();
    };

    nextPort.on?.("data", onData);
    nextPort.on?.("close", onClose);
    nextPort.on?.("error", onError);
    detachPort = () => {
      removeListener(nextPort, "data", onData);
      removeListener(nextPort, "close", onClose);
      removeListener(nextPort, "error", onError);
      detachPort = () => {};
    };
  }

  function writeFireAndForget(type, payload) {
    if (!connected) return;
    const writePort = currentPort;
    try {
      writePort.write(
        encodeFrame({ type, seq: 0, payload }),
        (error) => { if (error && writePort === currentPort && connected) handleDisconnect(); },
      );
    } catch {
      if (writePort === currentPort && connected) handleDisconnect();
    }
  }

  return {
    pushFrame,
    playSound(soundId) {
      // Fire-and-forget: device doesn't ACK PLAY. Surface an async write error to the
      // reconnect path, but only if it's still THIS port (a stale callback from an old
      // port must not tear down a reconnected session).
      writeFireAndForget(T.PLAY, Uint8Array.from([soundId & 0xff]));
    },
    setActiveCry(soundId) {
      writeFireAndForget(T.CONFIG, Uint8Array.from([soundId & 0xff]));
    },
    sendVolume(volume) {
      writeFireAndForget(T.VOLUME, Uint8Array.from([volumeByte(volume)]));
    },
    sendTime(hour, minute, epochDay) {
      const day = epochDay & 0xffff;
      writeFireAndForget(T.TIME, Uint8Array.from([hour & 0xff, minute & 0xff, day & 0xff, (day >> 8) & 0xff]));
    },
    onReconnect(callback) {
      events.on("reconnect", callback);
      return () => events.off("reconnect", callback);
    },
    onDisconnect(callback) {
      events.on("disconnect", callback);
      return () => events.off("disconnect", callback);
    },
    onButton(callback) {
      events.on("button", callback);
      return () => events.off("button", callback);
    },
    onSensor(callback) {
      events.on("sensor", callback);
      return () => events.off("sensor", callback);
    },
    feedSensor() {
      return latestSensor ? { ...latestSensor } : null;
    },
    getHello() {
      return latestHello ? { ...latestHello } : null;
    },
    close() {
      stopped = true;
      connected = false;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      resolveDisconnected();
      detachPort();
      try {
        currentPort.close?.();
      } catch {
        // A synchronous throw from close() must not kill the process on shutdown.
      }
    },
  };

  function retryTimeoutFor(payloadLength) {
    return Math.max(DEFAULT_TIMEOUT_MS, timeoutMs, 150 + Math.ceil(payloadLength / 16));
  }
}

function guardPortErrors(port, logger) {
  // The bindings-cpp Poller can emit 'error' ("Canceled") asynchronously during/after
  // close, when the removable onError listener is already gone. A resident listener keeps
  // the EventEmitter from throwing at the node:events top level (which would kill the
  // process). It only logs — teardown stays the job of attachPort's removable onError.
  if (!port || typeof port.on !== "function" || port[PORT_GUARDED]) return;
  port[PORT_GUARDED] = true;
  port.on("error", (error) => {
    logger?.debug?.(`serial port error ignored during teardown: ${error?.message ?? error}`);
  });
}

function normalizeVid(vendorId) {
  return String(vendorId ?? "").replace(/^0x/i, "").toUpperCase();
}

function removeListener(emitter, eventName, listener) {
  if (emitter.off) {
    emitter.off(eventName, listener);
    return;
  }
  emitter.removeListener?.(eventName, listener);
}
