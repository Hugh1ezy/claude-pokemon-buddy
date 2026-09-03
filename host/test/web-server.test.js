import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { startWebServer } from "../src/web/server.js";

test("GET /api/state returns view json on 127.0.0.1", async () => {
  const srv = await startWebServer({
    host: "127.0.0.1",
    port: 0,
    getView: () => ({ buddy: { name: "阿布" } }),
  });

  try {
    assert.equal(srv.host, "127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/state`);
    const j = await res.json();
    assert.equal(res.status, 200);
    assert.equal(j.buddy.name, "阿布");
  } finally {
    await srv.close();
  }
});

test("POST /api/settings accepts whitelisted settings", async () => {
  let saved = null;
  const srv = await startWebServer({
    host: "127.0.0.1",
    port: 0,
    getView: () => ({}),
    saveSettings: (value) => {
      saved = value;
    },
  });

  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "布布", volume: 20 }),
    });
    const j = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(saved, { name: "布布", volume: 20 });
    assert.deepEqual(j.settings, { name: "布布", volume: 20 });
  } finally {
    await srv.close();
  }
});

test("request entry rejects forged Host before routing", async () => {
  let readView = 0;
  const srv = await startWebServer({
    host: "127.0.0.1",
    port: 0,
    getView: () => {
      readView += 1;
      return {};
    },
  });

  try {
    const res = await requestRaw({
      port: srv.port,
      path: "/api/state",
      headers: { host: "evil.example" },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(readView, 0);
  } finally {
    await srv.close();
  }
});

test("request entry rejects text/plain POST before routing", async () => {
  let saved = 0;
  const srv = await startWebServer({
    host: "127.0.0.1",
    port: 0,
    saveSettings: () => {
      saved += 1;
    },
  });

  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/settings`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "布布" }),
    });

    assert.equal(res.status, 415);
    assert.equal(saved, 0);
  } finally {
    await srv.close();
  }
});

test("evolution endpoints inherit forged Host rejection at request entry", async () => {
  let choices = 0;
  const srv = await startWebServer({
    host: "127.0.0.1",
    port: 0,
    chooseEvolution: () => {
      choices += 1;
    },
  });

  try {
    const choose = await requestRaw({
      port: srv.port,
      path: "/api/evolution/choose",
      method: "POST",
      headers: { host: "evil.example", "content-type": "application/json" },
      body: JSON.stringify({ to: "espeon" }),
    });

    assert.equal(choose.statusCode, 403);
    assert.equal(choices, 0);
  } finally {
    await srv.close();
  }
});

test("evolution endpoints inherit content-type rejection at request entry", async () => {
  let choices = 0;
  const srv = await startWebServer({
    host: "127.0.0.1",
    port: 0,
    chooseEvolution: () => {
      choices += 1;
    },
  });

  try {
    const choose = await fetch(`http://127.0.0.1:${srv.port}/api/evolution/choose`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ to: "espeon" }),
    });

    assert.equal(choose.status, 415);
    assert.equal(choices, 0);
  } finally {
    await srv.close();
  }
});

test("17KB JSON body receives 413 before the stream is destroyed", async () => {
  const srv = await startWebServer({
    host: "127.0.0.1",
    port: 0,
  });

  try {
    const { statusCode, body } = await requestRaw({
      port: srv.port,
      path: "/api/settings",
      method: "POST",
      headers: {
        host: `127.0.0.1:${srv.port}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "x".repeat(17 * 1024) }),
    });

    assert.equal(statusCode, 413);
    assert.match(body, /too large/i);
  } finally {
    await srv.close();
  }
});

test("POST /api/settings rejects unknown field", async () => {
  let saved = null;
  const srv = await startWebServer({
    host: "127.0.0.1",
    port: 0,
    getView: () => ({}),
    saveSettings: (value) => {
      saved = value;
    },
  });

  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ difficulty: "easy" }),
    });

    assert.equal(res.status, 400);
    assert.equal(saved, null);
  } finally {
    await srv.close();
  }
});

test("POST /api/settings with an empty body is rejected and does not save", async () => {
  let saved = 0;
  const srv = await startWebServer({
    host: "127.0.0.1",
    port: 0,
    getView: () => ({}),
    saveSettings: () => {
      saved += 1;
    },
  });

  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });

    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /no settings/i);
    assert.equal(saved, 0);
  } finally {
    await srv.close();
  }
});

test("POST /api/settings rejects malformed JSON body", async () => {
  let saved = 0;
  const srv = await startWebServer({
    host: "127.0.0.1",
    port: 0,
    saveSettings: () => {
      saved += 1;
    },
  });

  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad-json",
    });
    const json = await res.json();

    assert.equal(res.status, 400);
    assert.match(json.error, /invalid JSON body/i);
    assert.equal(saved, 0);
  } finally {
    await srv.close();
  }
});

test("GET /frame.png mirrors configured frame file", async () => {
  const framePath = join("out", `test-web-frame-${randomUUID()}.png`);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  mkdirSync(dirname(framePath), { recursive: true });
  writeFileSync(framePath, png);
  const srv = await startWebServer({
    host: "127.0.0.1",
    port: 0,
    getView: () => ({}),
    framePath,
  });

  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/frame.png`);
    const body = Buffer.from(await res.arrayBuffer());

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.deepEqual(body, png);
  } finally {
    await srv.close();
    rmSync(framePath, { force: true });
  }
});

test("GET /frame.png returns 404 when the configured frame file is missing", async () => {
  const framePath = join("out", `missing-web-frame-${randomUUID()}.png`);
  rmSync(framePath, { force: true });
  const srv = await startWebServer({
    host: "127.0.0.1",
    port: 0,
    framePath,
  });

  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/frame.png`);
    const json = await res.json();

    assert.equal(res.status, 404);
    assert.match(json.error, /not found/i);
  } finally {
    await srv.close();
  }
});

test("GET /sprites/:id serves only whitelisted local sprite assets", async () => {
  const srv = await startWebServer({
    host: "127.0.0.1",
    port: 0,
  });

  try {
    const known = await fetch(`http://127.0.0.1:${srv.port}/sprites/eevee`);
    const knownBody = Buffer.from(await known.arrayBuffer());
    assert.equal(known.status, 200);
    assert.equal(known.headers.get("content-type"), "image/png");
    assert.equal(knownBody.subarray(1, 4).toString("ascii"), "PNG");

    const unknown = await fetch(`http://127.0.0.1:${srv.port}/sprites/missingno`);
    assert.equal(unknown.status, 404);
  } finally {
    await srv.close();
  }
});

test("unknown routes return JSON 404", async () => {
  const srv = await startWebServer({
    host: "127.0.0.1",
    port: 0,
  });

  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/nope`);
    const json = await res.json();

    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.match(json.error, /not found/i);
  } finally {
    await srv.close();
  }
});

function requestRaw({ port, path, method = "GET", headers = {}, body = "" }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...headers,
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let received = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          received += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode, body: received });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
