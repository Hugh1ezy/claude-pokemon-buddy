import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildActionCommand,
  buildTaskXml,
  isHostCommandLine,
  main,
} from "../scripts/autostart-windows.mjs";

const HOST_DIR = "C:\\Users\\zy948\\claude-pokemon-buddy\\host";
const NODE = "C:\\Program Files\\nodejs\\node.exe";

test("the action redirects to the same log the .vbs appended to", () => {
  const args = buildActionCommand({ nodePath: NODE, hostDir: HOST_DIR });
  // Continuity matters: a new log file would have split the history at exactly
  // the point someone goes looking for what happened before the change.
  assert.match(args, /out\\host-autostart\.log/);
  assert.match(args, />> /);
  assert.match(args, /2>&1/);
  // cmd /c strips the outer quote pair when the command starts with one, so the
  // whole command must be wrapped a second time or the quoted node path breaks.
  assert.ok(args.startsWith('/c ""'), `expected the double wrap, got ${args}`);
});

test("a trailing separator on hostDir does not produce a doubled slash", () => {
  const args = buildActionCommand({ nodePath: NODE, hostDir: `${HOST_DIR}\\` });
  assert.ok(!args.includes("\\\\src"), args);
});

test("the task supervises in both of the two independent ways", () => {
  const xml = buildTaskXml({ nodePath: NODE, hostDir: HOST_DIR, userId: "HUGHIE\\zy948" });

  assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>3<\/Count>/);
  // One minute is load-bearing and not a round number picked for tidiness: the
  // device raises its own clock face after 120s without a frame, so recovering
  // inside that window is the difference between an invisible restart and the
  // owner reporting that the panel switched itself to the default display.
  // Measured 2026-08-05: RestartOnFailure does NOT fire on a killed action, so
  // this trigger is the whole of the supervision, not a backstop.
  assert.match(xml, /<Repetition>\s*<Interval>PT1M<\/Interval>/,
    "the repeating trigger must beat the device's 120s local-clock timeout");
  // Without IgnoreNew the 5-minute trigger would start a SECOND host every five
  // minutes, which is worse than the problem it exists to solve.
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  // The default is 72 hours. A host killed mid-week by a timeout nobody set is
  // exactly the kind of cause that never gets connected to its effect.
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
});

test("XML special characters in a path cannot break the document", () => {
  const xml = buildTaskXml({
    nodePath: "C:\\a&b\\node.exe",
    hostDir: "C:\\x<y>\\host",
    userId: "DOM\\o'brien",
  });
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), "every bare & must be escaped");
  assert.match(xml, /a&amp;b/);
  assert.match(xml, /x&lt;y&gt;/);
  assert.match(xml, /o&apos;brien/);
});

test("a host started the .vbs way -- relative path, no project dir -- is still recognised", () => {
  // This is the case that matters on install: miss it and the task starts a
  // second host onto the same serial port.
  assert.equal(isHostCommandLine({
    commandLine: '"C:\\Program Files\\nodejs\\node.exe" src\\index.js',
    hostDir: HOST_DIR,
  }), true);

  assert.equal(isHostCommandLine({
    commandLine: `"C:\\Program Files\\nodejs\\node.exe" ${HOST_DIR}\\src\\index.js`,
    hostDir: HOST_DIR,
  }), true);

  assert.equal(isHostCommandLine({
    commandLine: `node ${HOST_DIR.toUpperCase()}\\SRC\\INDEX.JS`,
    hostDir: HOST_DIR,
  }), true, "Windows paths are case-insensitive");
});

test("unrelated node processes are not claimed", () => {
  assert.equal(isHostCommandLine({ commandLine: "node scripts/bake-cries.mjs", hostDir: HOST_DIR }), false);
  assert.equal(isHostCommandLine({ commandLine: "", hostDir: HOST_DIR }), false);
  assert.equal(isHostCommandLine({ commandLine: undefined, hostDir: HOST_DIR }), false);
});

test("it refuses to run anywhere but Windows, and rejects a bad verb", () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    assert.equal(main(["install"], { platform: "darwin" }), 1);
    assert.equal(main(["frobnicate"], { platform: "win32" }), 1);
    assert.equal(main([], { platform: "win32" }), 1);
  } finally {
    console.error = original;
  }
  assert.match(errors[0], /Windows only/);
  assert.match(errors[1], /Usage/);
});
