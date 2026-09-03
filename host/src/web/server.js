import http from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateSettings } from "./settings.js";

const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL("./public", import.meta.url));
const SPRITE_FILES = new Map([
  ["/sprites/eevee", fileURLToPath(new URL("../../seed/sprites/eevee.png", import.meta.url))],
  ["/sprites/vaporeon", fileURLToPath(new URL("../../seed/sprites/vaporeon.png", import.meta.url))],
  ["/sprites/jolteon", fileURLToPath(new URL("../../seed/sprites/jolteon.png", import.meta.url))],
  ["/sprites/flareon", fileURLToPath(new URL("../../seed/sprites/flareon.png", import.meta.url))],
  ["/sprites/espeon", fileURLToPath(new URL("../../seed/sprites/espeon.png", import.meta.url))],
  ["/sprites/umbreon", fileURLToPath(new URL("../../seed/sprites/umbreon.png", import.meta.url))],
  ["/sprites/leafeon", fileURLToPath(new URL("../../seed/sprites/leafeon.png", import.meta.url))],
  ["/sprites/glaceon", fileURLToPath(new URL("../../seed/sprites/glaceon.png", import.meta.url))],
  ["/sprites/sylveon", fileURLToPath(new URL("../../seed/sprites/sylveon.png", import.meta.url))],
  ["/sprites/bulbasaur", fileURLToPath(new URL("../../seed/sprites/bulbasaur.png", import.meta.url))],
  ["/sprites/ivysaur", fileURLToPath(new URL("../../seed/sprites/ivysaur.png", import.meta.url))],
  ["/sprites/venusaur", fileURLToPath(new URL("../../seed/sprites/venusaur.png", import.meta.url))],
  ["/sprites/charmander", fileURLToPath(new URL("../../seed/sprites/charmander.png", import.meta.url))],
  ["/sprites/charmeleon", fileURLToPath(new URL("../../seed/sprites/charmeleon.png", import.meta.url))],
  ["/sprites/charizard", fileURLToPath(new URL("../../seed/sprites/charizard.png", import.meta.url))],
  ["/sprites/squirtle", fileURLToPath(new URL("../../seed/sprites/squirtle.png", import.meta.url))],
  ["/sprites/wartortle", fileURLToPath(new URL("../../seed/sprites/wartortle.png", import.meta.url))],
  ["/sprites/blastoise", fileURLToPath(new URL("../../seed/sprites/blastoise.png", import.meta.url))],
]);

export function startWebServer({
  host = "127.0.0.1",
  port = 0,
  getView = () => ({}),
  saveSettings = () => {},
  chooseEvolution = () => {},
  framePath = "out/frame.png",
  publicDir = DEFAULT_PUBLIC_DIR,
} = {}) {
  let allowedHosts = null;
  const server = http.createServer(async (req, res) => {
    try {
      if (!validateRequestEntry(req, res, allowedHosts)) return;
      await routeRequest(req, res, {
        getView,
        saveSettings,
        chooseEvolution,
        framePath,
        publicDir,
      });
    } catch (error) {
      respondJson(res, 500, { error: error.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      allowedHosts = allowedHostHeaders(address.port);
      resolve({
        host: address.address,
        port: address.port,
        server,
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

function validateRequestEntry(req, res, allowedHosts) {
  const host = req.headers.host;
  if (!allowedHosts?.has(typeof host === "string" ? host.toLowerCase() : "")) {
    respondJson(res, 403, { error: "forbidden host" });
    return false;
  }

  if (req.method === "POST" && !isJsonContentType(req.headers["content-type"])) {
    respondJson(res, 415, { error: "content-type must be application/json" });
    return false;
  }

  return true;
}

function allowedHostHeaders(port) {
  return new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
}

function isJsonContentType(value) {
  if (typeof value !== "string") return false;
  return value.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

async function routeRequest(req, res, context) {
  const url = new URL(req.url, "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/api/state") {
    respondJson(res, 200, await context.getView());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    let body;
    try {
      body = await readJsonBody(req, res);
    } catch (error) {
      if (error.responded) return;
      respondJson(res, 400, { error: error.message });
      return;
    }

    const result = validateSettings(body);
    if (!result.ok) {
      respondJson(res, 400, { error: result.error });
      return;
    }

    if (Object.keys(result.value).length === 0) {
      respondJson(res, 400, { error: "no settings provided" });
      return;
    }

    await context.saveSettings(result.value);
    respondJson(res, 200, { ok: true, settings: result.value });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/evolution/choose") {
    let body;
    try {
      body = await readJsonBody(req, res);
    } catch (error) {
      if (error.responded) return;
      respondJson(res, 400, { error: error.message });
      return;
    }

    if (typeof body.to !== "string" || body.to.length === 0) {
      respondJson(res, 400, { error: "invalid evolution target" });
      return;
    }

    let result;
    try {
      result = await context.chooseEvolution(body.to);
    } catch (error) {
      respondJson(res, 400, { error: error.message });
      return;
    }
    respondJson(res, 202, { ok: true, queued: true, to: result?.to ?? body.to });
    return;
  }

  if (req.method === "GET" && url.pathname === "/frame.png") {
    await serveFile(res, context.framePath, "image/png");
    return;
  }

  if (req.method === "GET" && SPRITE_FILES.has(url.pathname)) {
    await serveFile(res, SPRITE_FILES.get(url.pathname), "image/png");
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    await serveFile(res, join(context.publicDir, "index.html"), "text/html; charset=utf-8");
    return;
  }

  if (req.method === "GET" && url.pathname === "/app.js") {
    await serveFile(res, join(context.publicDir, "app.js"), "text/javascript; charset=utf-8");
    return;
  }

  respondJson(res, 404, { error: "not found" });
}

function readJsonBody(req, res, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let settled = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (settled) return;
      body += chunk;
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > limit) {
        settled = true;
        respondJson(res, 413, { error: "request body too large" });
        res.once("finish", () => req.destroy());
        const error = new Error("request body too large");
        error.responded = true;
        reject(error);
      }
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(body.length > 0 ? JSON.parse(body) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function serveFile(res, path, contentType) {
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") {
      respondJson(res, 404, { error: "not found" });
      return;
    }
    throw error;
  }
}

function respondJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}
