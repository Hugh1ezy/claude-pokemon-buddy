import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAction,
  buildTaskXml,
  isHostCommandLine,
  main,
} from "../scripts/autostart-windows.mjs";

const HOST_DIR = "C:\\Users\\zy948\\claude-pokemon-buddy\\host";
const NODE = "C:\\Program Files\\nodejs\\node.exe";

// The whole point of the wrapper. A console action under an interactive logon
// leaves a window on the owner's desktop, and on 2026-08-07 closing that window
// killed the host. If anyone points this action back at cmd.exe, the window
// comes back with it.
test("the action is the hidden wrapper, not a console program", () => {
  const action = buildAction({ nodePath: NODE, hostDir: HOST_DIR });
  assert.match(action.command, /wscript\.exe$/i);
  assert.ok(!/cmd\.exe/i.test(action.command), "cmd.exe as the action is the visible-window bug");
  assert.match(action.arguments, /run-host-hidden\.vbs/);
  // The node path has a space in it on every normal Windows install.
  assert.match(action.arguments, /"C:\\Program Files\\nodejs\\node\.exe"/);
  assert.equal(action.workingDirectory, HOST_DIR);
});

test("a trailing separator on hostDir does not produce a doubled slash", () => {
  const action = buildAction({ nodePath: NODE, hostDir: `${HOST_DIR}\\` });
  assert.ok(!action.arguments.includes("\\\\scripts"), action.arguments);
  assert.equal(action.workingDirectory, HOST_DIR);
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

// The owner ran with a console window on his desktop from 2026-08-05 to 08-07,
// closed it -- reasonably, it looked like litter -- and that killed the host.
// InteractiveToken is what put it there; `<Hidden>` is about the Task Scheduler
// library and does nothing for windows. This is the assertion that stops anyone
// "fixing" the principal back.
test("the task runs with no interactive session, so there is no console window", () => {
  const xml = buildTaskXml({ nodePath: NODE, hostDir: HOST_DIR, userId: "HUGHIE\\zy948" });
  assert.match(xml, /<Command>[^<]*wscript\.exe<\/Command>/i);
  assert.ok(!/<Command>[^<]*cmd\.exe<\/Command>/i.test(xml), "cmd.exe as the action is the visible-window bug");
});

// XML comments cannot contain a double hyphen, and this document is assembled by
// hand from prose that is full of them. schtasks rejects the whole task with
// "incorrect comment syntax" and no host starts at all -- which is how this was
// found, by breaking it.
test("the generated document is a legal XML comment-wise", () => {
  const xml = buildTaskXml({ nodePath: NODE, hostDir: HOST_DIR, userId: "HUGHIE\\zy948" });
  for (const [, body] of xml.matchAll(/<!--([\s\S]*?)-->/g)) {
    assert.ok(!body.includes("--"), `XML comment contains a double hyphen: ${body.trim().slice(0, 60)}`);
  }
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
