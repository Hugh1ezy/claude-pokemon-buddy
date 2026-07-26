import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FANOUT = fileURLToPath(new URL("../scripts/cpb-statusline-fanout.mjs", import.meta.url));
const INPUT = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42 }, seven_day: { used_percentage: 7 } } });

function run(args, input, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [FANOUT, ...args], { env: { ...process.env, ...env } },
      (error, stdout) => resolve({ code: error?.code ?? 0, stdout }));
    child.stdin.end(input);
  });
}

test("fan-out：bridge 写出 usage 文件，原 command 收到完整 stdin 且 stdout 原样透传", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cpb-fanout-"));
  const usagePath = join(dir, "cpb-usage.json");
  // 原 command 把收到的 stdin 原样回显 → 同时证明 stdin 完整转发与 stdout 透传
  const original = `${process.execPath} -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(s))"`;
  const { code, stdout } = await run([original], INPUT, { CPB_USAGE_PATH: usagePath });
  assert.equal(code, 0);
  assert.equal(stdout, INPUT);
  const usage = JSON.parse(readFileSync(usagePath, "utf8"));
  assert.equal(usage.fiveHourPct, 42);
  rmSync(dir, { recursive: true, force: true });
});

test("--b64 单参数：带空格路径/引号的原 command 不被拆坏", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cpb-fanout-"));
  const usagePath = join(dir, "cpb-usage.json");
  const original = `${process.execPath} -e "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('QUOTED OK'))"`;
  const b64 = Buffer.from(original, "utf8").toString("base64");
  const { code, stdout } = await run(["--b64", b64], INPUT, { CPB_USAGE_PATH: usagePath });
  assert.equal(code, 0);
  assert.equal(stdout, "QUOTED OK");
  rmSync(dir, { recursive: true, force: true });
});

test("原 command 失败 → 退回 bridge 一行输出，usage 文件仍写出，退出码 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cpb-fanout-"));
  const usagePath = join(dir, "cpb-usage.json");
  const { code, stdout } = await run(["definitely-not-a-command-xyz"], INPUT, { CPB_USAGE_PATH: usagePath });
  assert.equal(code, 0);
  assert.match(stdout, /5h 42%/);
  assert.equal(JSON.parse(readFileSync(usagePath, "utf8")).weeklyPct, 7);
  rmSync(dir, { recursive: true, force: true });
});

test("无原 command 参数 → 直接输出 bridge 一行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cpb-fanout-"));
  const usagePath = join(dir, "cpb-usage.json");
  const { code, stdout } = await run([], INPUT, { CPB_USAGE_PATH: usagePath });
  assert.equal(code, 0);
  assert.match(stdout, /wk 7%/);
  rmSync(dir, { recursive: true, force: true });
});
