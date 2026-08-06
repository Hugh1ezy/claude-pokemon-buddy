// Windows autostart + supervision for the host, i.e. the thing macOS gets from
// launchd's KeepAlive and this platform had nothing for.
//
// Until 2026-08-05 the Windows setup was a .vbs in the Startup folder: it ran
// once at logon and nothing ever looked at the process again. When the host died
// -- and on 2026-08-05 it died at 10:31:55 with no crash in the event log, no
// reboot, no Defender action and no graceful-exit save publish -- the only
// symptom was the device falling back to its own clock face two minutes later.
// From the front that reads as "the device switched to the default display by
// itself, and BOOT will not bring it back", which is exactly what it was
// reported as. Nothing was wrong with the device or the panel; there was simply
// no host. That answer has now been the right one four times in a week.
//
// The task supervises in two independent ways, because one of them failing
// silently is how we got here -- and, as it turns out, one of them does fail:
//
//   1. A trigger that repeats every minute forever, with
//      MultipleInstancesPolicy=IgnoreNew so it costs nothing while the host is
//      already up. **This is what actually does the work.** One minute, not
//      five, because the device puts its own clock face up after 120s of
//      silence: recovering inside that window means the owner never sees the
//      failure at all, which is the entire point.
//   2. RestartOnFailure, kept as a second line and NOT to be relied on.
//      **Measured 2026-08-05: it does not fire when the action is killed.** The
//      host was killed at 13:43:00, the task went to state Ready with last
//      result 0xFFFFFFFF, and nothing restarted it until the repeating trigger
//      came round at 13:45:01. Whatever "failure" means to Task Scheduler here,
//      it is not "the action exited non-zero". Do not delete (1) as a duplicate
//      of (2); (2) has been observed to do nothing.
//
// The task IS the host, rather than a watchdog that spawns one: Task Scheduler
// then knows whether it is running, `status` can ask, and there is no question
// about whether a detached grandchild outlives the job object it was spawned in.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TASK_NAME = "ClaudePokemonBuddyHost";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const HOST_DIR = resolve(dirname(SCRIPT_PATH), "..");

// The action is wscript.exe running run-host-hidden.vbs, NOT cmd.exe directly.
// cmd.exe under an interactive logon puts a console window on the desktop and
// leaves it there; see the .vbs for what that cost. The .vbs launches the same
// cmd redirect with a hidden window and blocks until it exits, so the task stays
// Running for the host's whole life and IgnoreNew keeps meaning something.
//
// Task Scheduler cannot redirect an action's output at all, which is why there
// is a cmd in the chain anywhere: it carries the same append-redirect the old
// Startup .vbs used, so the log file stays continuous across this change rather
// than a second one appearing next to it.
export function buildAction({ nodePath, hostDir }) {
  const dir = stripTrailingSlashes(normalize(hostDir));
  return {
    command: join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe"),
    arguments: `"${join(dir, "scripts", "run-host-hidden.vbs")}" "${normalize(nodePath)}"`,
    workingDirectory: dir,
  };
}

// **The action must not be a console program.** The first version of this task
// ran cmd.exe under an interactive logon, which parks a visible console window on
// the owner's desktop and leaves it there. It sat there from 2026-08-05 to 08-07,
// the owner reasonably took it for litter and closed it, and closing it killed
// the host: exit 0xC000013A is STATUS_CONTROL_C_EXIT, i.e. exactly "the console
// went away". The device fell to its clock face two minutes later and was
// reported as stuck. A window that is visible is a window that gets closed.
//
// `<Hidden>` does NOT prevent it and never did: it hides the task in the Task
// Scheduler library, not the window. Believing otherwise is what put the window
// there. The old Startup .vbs never had this problem because WScript.Shell.Run
// takes a window style, and run-host-hidden.vbs is that mechanism kept.
//
// The cleaner fix is an S4U principal ("run whether the user is logged on or
// not"), which has no session and therefore no window at all. **It needs
// elevation to register** -- `schtasks /Create` returns "Access is denied" from
// an ordinary prompt, measured 2026-08-07 -- and this install has to work
// without admin. Prefer it if you ever have the rights.
//
// Also note XML comments may not contain a double hyphen, which is why the
// reasoning lives out here in JS rather than inside the document.
export function buildTaskXml({ nodePath, hostDir, userId }) {
  const dir = stripTrailingSlashes(normalize(hostDir));
  const action = buildAction({ nodePath, hostDir: dir });
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Claude Pokemon Buddy host. Starts at logon and is restarted if it stops.</Description>
    <URI>\\${escapeXml(TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(userId)}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(userId)}</UserId>
      <!-- S4U would need elevation to register; the hidden wrapper is what keeps
           the window off the desktop instead. See the note above buildTaskXml. -->
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <!-- PT0S = no limit. The default is 72 hours, which would kill the host
         mid-week for no reason anyone would ever connect to the cause. -->
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(action.command)}</Command>
      <Arguments>${escapeXml(action.arguments)}</Arguments>
      <WorkingDirectory>${escapeXml(action.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// A node process belongs to this host if its command line names this project's
// index.js. The .vbs launched it with a RELATIVE path from `host`, so an
// absolute-path-only match would miss exactly the instances that are already
// running when this is installed -- which is the case that matters, since two
// hosts on one serial port is worse than none.
export function isHostCommandLine({ commandLine, hostDir }) {
  if (typeof commandLine !== "string" || commandLine.length === 0) return false;
  const dir = stripTrailingSlashes(normalize(String(hostDir))).toLowerCase();
  const line = commandLine.toLowerCase().replaceAll("/", "\\");
  if (line.includes(join(dir, "src", "index.js").toLowerCase())) return true;
  return line.includes("node") && line.includes("src\\index.js");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stripTrailingSlashes(value) {
  return value.length > 1 ? value.replace(/[\\/]+$/, "") : value;
}

function powershell(script) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function findHostPids(hostDir = HOST_DIR) {
  const result = powershell(
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
    + "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
  );
  if (result.status !== 0) return { ok: false, pids: [] };
  const pids = result.stdout
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter(([pid, cmd]) => Number.isInteger(Number(pid)) && isHostCommandLine({ commandLine: cmd, hostDir }))
    .map(([pid]) => Number(pid))
    .filter((pid) => pid !== process.pid);
  return { ok: true, pids };
}

function install() {
  const running = findHostPids();
  if (running.ok && running.pids.length > 0) {
    console.error(`A host is already running (pid ${running.pids.join(", ")}).`);
    console.error("Stop it first -- the task will start its own, and two hosts fight over the serial port.");
    return 1;
  }

  mkdirSync(join(HOST_DIR, "out"), { recursive: true });
  const xml = buildTaskXml({
    nodePath: process.execPath,
    hostDir: HOST_DIR,
    userId: `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`.replace(/^\\/, ""),
  });

  const xmlPath = join(HOST_DIR, "out", "autostart-task.xml");
  // schtasks /XML insists on UTF-16, which is also what the XML header claims.
  const script = `[System.IO.File]::WriteAllText(${psQuote(xmlPath)}, ${psQuote(xml)}, [System.Text.Encoding]::Unicode); `
    + `schtasks /Create /TN ${psQuote(TASK_NAME)} /XML ${psQuote(xmlPath)} /F`;
  const result = powershell(script);
  if (result.status !== 0) {
    console.error(result.stderr.trim() || result.stdout.trim() || "schtasks /Create failed");
    return 1;
  }
  console.log(result.stdout.trim());
  console.log(`Installed scheduled task ${TASK_NAME}`);
  console.log(`XML: ${xmlPath}`);
  console.log("Remove start-buddy.vbs from the Startup folder, or logon will race two hosts onto one port.");
  return 0;
}

function uninstall() {
  const result = powershell(`schtasks /Delete /TN ${psQuote(TASK_NAME)} /F`);
  if (result.status !== 0) {
    console.error(result.stderr.trim() || result.stdout.trim() || "schtasks /Delete failed");
    return 1;
  }
  console.log(`Uninstalled ${TASK_NAME}`);
  return 0;
}

function status() {
  const task = powershell(
    `$t = Get-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -ErrorAction SilentlyContinue; `
    + "if (-not $t) { 'task: not installed' } else { "
    + "$i = $t | Get-ScheduledTaskInfo; "
    + "\"task: installed`nstate: $($t.State)`nlast run: $($i.LastRunTime)`nlast result: $($i.LastTaskResult)`nnext run: $($i.NextRunTime)\" }",
  );
  console.log(task.stdout.trim() || task.stderr.trim());
  const running = findHostPids();
  console.log(`host process: ${running.pids.length > 0 ? `running (pid ${running.pids.join(", ")})` : "not running"}`);
  return 0;
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function main(argv, { platform = process.platform } = {}) {
  if (platform !== "win32") {
    console.error("autostart-windows: Windows only");
    return 1;
  }
  const command = argv[0];
  if (argv.length !== 1 || !["install", "uninstall", "status"].includes(command)) {
    console.error("Usage: node scripts/autostart-windows.mjs <install|uninstall|status>");
    return 1;
  }
  if (command === "install") return install();
  if (command === "uninstall") return uninstall();
  return status();
}

if (process.argv[1] && existsSync(process.argv[1]) && resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = main(process.argv.slice(2));
}
