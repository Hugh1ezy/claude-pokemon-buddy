import { test } from "node:test";
import assert from "node:assert/strict";

import { installLogTimestamps, timestamp } from "../src/log-timestamps.js";

test("the stamp is local time, zero-padded, and sortable", () => {
  assert.equal(timestamp(new Date(2026, 7, 5, 10, 31, 55)), "2026-08-05 10:31:55");
  assert.equal(timestamp(new Date(2026, 0, 9, 9, 5, 4)), "2026-01-09 09:05:04");
});

test("every level is stamped, and the stamp leads rather than concatenates", () => {
  const seen = [];
  const target = {
    log: (...args) => seen.push(["log", args]),
    info: (...args) => seen.push(["info", args]),
    warn: (...args) => seen.push(["warn", args]),
    error: (...args) => seen.push(["error", args]),
  };
  const undo = installLogTimestamps({ target, now: () => new Date(2026, 7, 5, 10, 31, 55) });

  target.log("wrote out/frame.png");
  const error = new Error("boom");
  target.error(error);

  assert.deepEqual(seen[0], ["log", ["2026-08-05 10:31:55", "wrote out/frame.png"]]);
  // The Error must arrive as an Error, or console prints "[object Object]"
  // instead of a stack -- which is the one line worth having in this log.
  assert.equal(seen[1][1][0], "2026-08-05 10:31:55");
  assert.equal(seen[1][1][1], error);

  undo();
  target.log("bare");
  assert.deepEqual(seen[2], ["log", ["bare"]], "the undo has to actually restore");
});

test("a target missing a level is skipped rather than crashing", () => {
  const seen = [];
  const target = { log: (...args) => seen.push(args) };   // no warn/error/info
  const undo = installLogTimestamps({ target, now: () => new Date(2026, 7, 5, 0, 0, 0) });
  target.log("x");
  undo();
  assert.deepEqual(seen, [["2026-08-05 00:00:00", "x"]]);
});
