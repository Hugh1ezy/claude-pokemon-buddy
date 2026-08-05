// The host log had no timestamps at all, for its whole life.
//
// 2026-08-05 is what made that expensive: the process disappeared, and dating
// the death meant reading the mtime of `out/frame.png`, because 33,160 lines of
// `wrote out/frame.png` could not say when any of them happened. Every question
// worth asking about this log is a question about time -- when did the device
// stop taking frames, how long was the panel stale, did this start before or
// after the host restarted -- and none of them could be answered.
//
// Local time, not UTC or ISO: every other clock in this project is the device's
// local NZ time (the bond windows, `epoch_day`, the quiet hours), and a log in a
// different timezone from the thing it describes is a trap for whoever reads it
// at 23:50.
export function timestamp(now = new Date()) {
  const p2 = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} `
    + `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
}

// Installed from the CLI entry point ONLY, never at import time: the test suite
// captures console output in a dozen places and asserts on exact strings, and a
// module that stamps the console the moment it is imported would rewrite all of
// them. Returns an undo, so a test can install it deliberately and clean up.
//
// The stamp goes in as its own leading argument rather than concatenated onto
// the first one, so `console.error(err)` still prints a real Error with its
// stack rather than "[object Object]" glued to a date.
export function installLogTimestamps({ target = console, now = () => new Date() } = {}) {
  const restore = [];
  for (const level of ["log", "info", "warn", "error"]) {
    const original = target[level];
    if (typeof original !== "function") continue;
    restore.push([level, original]);
    target[level] = (...args) => original.call(target, timestamp(now()), ...args);
  }
  return () => {
    for (const [level, original] of restore) target[level] = original;
  };
}
