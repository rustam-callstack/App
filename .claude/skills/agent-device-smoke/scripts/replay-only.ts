// Replay-only smoke runner — agent-device-smoke skill helper.
//
// Drives the same boot dance + per-step verification as the Phase 1
// driver at .github/scripts/agent-device-llm-driver.ts, but WITHOUT
// any LLM call. Cache-hit-only: if the cache misses or drifts, this
// script hard-fails with a structured error instead of falling
// through to LLM/bash.
//
// Use when you have a known-good committed cache file and want
// determinism + zero API spend. Typical invocation:
//
//   npx ts-node .claude/skills/agent-device-smoke/scripts/replay-only.ts \
//       tests/smoke/android-signin.testcase.txt
//
// The Phase 1 driver remains the source of truth for the LLM path.
// This file is purely additive — it imports the existing modules
// read-only and never modifies driver state.

import { execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";

import * as adCli from "../../../../.github/scripts/agent-device-cli";
import type { Snapshot } from "../../../../.github/scripts/agent-device-cli";
import {
  snapshotSignature,
  locatorToRef,
} from "../../../../.github/scripts/agent-device-snapshot-signature";
import { evaluateExpect } from "../../../../.github/scripts/agent-device-expect";
import * as cache from "../../../../.github/scripts/agent-device-replay-cache";
import type { CachedAction } from "../../../../.github/scripts/agent-device-replay-cache";

const APP_PACKAGE = process.env.APP_PACKAGE ?? "com.expensify.chat.dev";
const SESSION = process.env.AGENT_DEVICE_SESSION ?? "ci";
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR ?? "artifacts";
const TEST_CASE_PATH =
  process.argv[2] ?? "tests/smoke/android-signin.testcase.txt";
const APK_GLOB = "android/app/build/outputs/apk/development/debug";
const METRO_READY_TIMEOUT_MS = 120_000;
const SIGNIN_LOAD_TIMEOUT_MS = 600_000;
const BOOT_PROBE_INTERVAL_MS = 30_000;

type Step = { number: number; text: string; expect: string | null };

const backgroundPids: number[] = [];
let cleanedUp = false;

async function main(): Promise<void> {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  registerCleanup();

  log(`replay-only test_case=${TEST_CASE_PATH}`);
  if (!fs.existsSync(TEST_CASE_PATH)) {
    fail(`test case not found at ${TEST_CASE_PATH}`);
  }

  const testCaseRaw = fs.readFileSync(TEST_CASE_PATH, "utf8");
  const testCaseHash = cache.hashText(testCaseRaw);
  const steps = parseTestCase(testCaseRaw);
  if (!steps.length) {
    fail("test case has no steps");
  }

  const cachePath = deriveCachePath(TEST_CASE_PATH);
  if (!fs.existsSync(cachePath)) {
    fail(
      `replay mode requires a committed cache at ${cachePath}. ` +
        `Run with ANTHROPIC_API_KEY set first to record one, or commit ` +
        `the artifacts/cache-recorded.json from a successful run.`,
    );
  }
  const committed = cache.loadCache(cachePath, "replay-mode", testCaseHash);
  if (committed.testCaseHash !== testCaseHash) {
    fail(
      `cache test_case_hash drift: cache has ${committed.testCaseHash}, ` +
        `current test case hashes to ${testCaseHash}. The test case file ` +
        `was edited after the cache was recorded; re-record in LLM mode.`,
    );
  }
  log(
    `cache: ${cachePath} (${committed.steps.length} steps, hash=${testCaseHash})`,
  );

  await bootApp();

  let cacheHits = 0;
  for (const step of steps) {
    const result = await replayStep(step, committed);
    if (!result.ok) {
      fail(`step ${step.number} failed: ${result.reason}`);
    }
    cacheHits++;
    log(`step ${step.number}: cache-hit + expect passed`);
  }

  log(
    `::notice::replay OK — cache_hits=${cacheHits}/${steps.length} (no LLM, no API call)`,
  );
}

function parseTestCase(raw: string): Step[] {
  const steps: Step[] = [];
  let cur: Step | null = null;
  for (const lineRaw of raw.split("\n")) {
    const line = lineRaw.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }
    const m = line.match(/^(\d+)\.\s+(.*)$/);
    if (m) {
      if (cur) {
        steps.push(cur);
      }
      cur = { number: Number(m[1]), text: m[2], expect: null };
      continue;
    }
    const ex = line.match(/^\s*expect:\s*(.+)$/);
    if (ex && cur) {
      cur.expect = ex[1];
    }
  }
  if (cur) {
    steps.push(cur);
  }
  return steps;
}

async function bootApp(): Promise<void> {
  log("boot: closing stale session");
  adCli.closeSession();

  log("boot: locating APK");
  const files = fs.existsSync(APK_GLOB)
    ? fs.readdirSync(APK_GLOB).filter((f) => f.endsWith(".apk"))
    : [];
  if (!files.length) {
    fail(
      `no APK found under ${APK_GLOB} — build the dev APK first (npm run android from Mobile-Expensify/)`,
    );
  }
  const apk = path.join(APK_GLOB, files[0]);
  log(`boot: installing ${apk}`);
  execFileSync("adb", ["install", "-r", "-d", "-t", apk], { stdio: "inherit" });

  log("boot: adb reverse 8081");
  execFileSync("adb", ["reverse", "tcp:8081", "tcp:8081"], {
    stdio: "inherit",
  });

  try {
    execFileSync(
      "adb",
      ["shell", "settings", "put", "global", "hide_error_dialogs", "1"],
      { timeout: 5_000, stdio: "ignore" },
    );
  } catch {
    // best effort
  }

  log("boot: starting Metro");
  const metroLog = fs.openSync(path.join(ARTIFACTS_DIR, "metro.log"), "a");
  const metro = spawn("npm", ["start"], {
    stdio: ["ignore", metroLog, metroLog],
    detached: true,
  });
  metro.unref();
  if (metro.pid) {
    backgroundPids.push(metro.pid);
  }

  await waitForMetro();

  log("boot: agent-device open --relaunch");
  const serial = execFileSync("adb", ["get-serialno"], {
    encoding: "utf8",
  }).trim();
  execFileSync(
    "agent-device",
    [
      "open",
      APP_PACKAGE,
      "--platform",
      "android",
      "--serial",
      serial,
      "--session",
      SESSION,
      "--relaunch",
    ],
    {
      stdio: "inherit",
    },
  );

  // Bounded wait for the SignIn UI; replay mode shares the same
  // ANR-recovery + probe-snapshot logic as Phase 1's driver so a
  // local emulator under load behaves identically to CI.
  log("boot: waiting for SignIn UI");
  const start = Date.now();
  let probeIdx = 0;
  let lastProbeAt = 0;
  while (Date.now() - start < SIGNIN_LOAD_TIMEOUT_MS) {
    let snap;
    try {
      snap = adCli.snapshot();
    } catch (e) {
      log(
        `boot: snapshot threw (${(e as Error).message.slice(0, 80)}); retrying`,
      );
      await sleep(2_000);
      continue;
    }
    if (
      snap.nodes.some((n) => n.text?.toLowerCase().includes("phone or email"))
    ) {
      log(
        `boot: SignIn ready after ${Math.round((Date.now() - start) / 1000)}s`,
      );
      return;
    }
    if (isAnrDialog(snap)) {
      log("boot: ANR dialog detected — dismissing and relaunching app");
      try {
        const waitBtn = snap.nodes.find(
          (n) => n.kind === "button" && n.text?.toLowerCase() === "wait",
        );
        if (waitBtn) {
          adCli.press(waitBtn.ref);
        }
      } catch (e) {
        log(`boot: dismiss press failed: ${(e as Error).message.slice(0, 80)}`);
      }
      try {
        execFileSync(
          "adb",
          [
            "shell",
            "am",
            "start",
            "-n",
            `${APP_PACKAGE}/com.expensify.chat.MainActivity`,
          ],
          { timeout: 10_000, stdio: "ignore" },
        );
      } catch {
        // best effort
      }
      await sleep(2_000);
      continue;
    }
    if (Date.now() - lastProbeAt >= BOOT_PROBE_INTERVAL_MS) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      fs.writeFileSync(
        path.join(
          ARTIFACTS_DIR,
          `boot-probe-${String(probeIdx).padStart(2, "0")}-t${elapsed}s.txt`,
        ),
        snap.raw,
      );
      probeIdx++;
      lastProbeAt = Date.now();
    }
    await sleep(6_000);
  }
  fail(`SignIn UI not ready within ${SIGNIN_LOAD_TIMEOUT_MS / 1000}s`);
}

async function waitForMetro(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < METRO_READY_TIMEOUT_MS) {
    try {
      const out = execFileSync(
        "curl",
        ["-sf", "http://localhost:8081/status"],
        { encoding: "utf8" },
      );
      if (out.includes("packager-status:running")) {
        log(
          `boot: Metro ready after ${Math.round((Date.now() - start) / 1000)}s`,
        );
        return;
      }
    } catch {
      // not up yet
    }
    await sleep(2_000);
  }
  fail(
    `Metro did not reach packager-status:running within ${METRO_READY_TIMEOUT_MS / 1000}s`,
  );
}

function isAnrDialog(snap: {
  nodes: Array<{ kind: string; text?: string }>;
}): boolean {
  const buttons = snap.nodes.filter((n) => n.kind === "button");
  if (buttons.length !== 2) {
    return false;
  }
  const labels = buttons.map((b) => b.text?.toLowerCase() ?? "").sort();
  return labels[0] === "close app" && labels[1] === "wait";
}

async function replayStep(
  step: Step,
  committed: ReturnType<typeof cache.loadCache>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const preSnap = adCli.snapshot();
  const preSig = snapshotSignature(preSnap);
  const cached = cache.lookup(committed, step.number, preSig);
  if (!cached) {
    return {
      ok: false,
      reason:
        `cache miss for step ${step.number} at pre-signature ${preSig}. ` +
        `Run with ANTHROPIC_API_KEY set to record an entry, or update the ` +
        `committed cache from a successful LLM-mode run.`,
    };
  }

  fs.writeFileSync(
    path.join(ARTIFACTS_DIR, `step-${step.number}-pre.txt`),
    preSnap.raw,
  );

  for (const action of cached.actions) {
    const r = await dispatchCachedAction(action);
    if (!r.ok) {
      return { ok: false, reason: `replay action failed: ${r.reason}` };
    }
    await sleep(150);
  }

  const postSnap = adCli.snapshot();
  const postSig = snapshotSignature(postSnap);
  fs.writeFileSync(
    path.join(ARTIFACTS_DIR, `step-${step.number}-post.txt`),
    postSnap.raw,
  );

  if (postSig !== cached.postSignature) {
    return {
      ok: false,
      reason: `post-state signature drift (recorded ${cached.postSignature}, observed ${postSig}); UI shape changed since cache was committed`,
    };
  }
  if (step.expect) {
    const ev = evaluateExpect(step.expect, postSnap, adCli.appstate());
    if (!ev.ok) {
      return { ok: false, reason: `expect failed: ${ev.reason}` };
    }
  }
  return { ok: true };
}

async function dispatchCachedAction(
  action: CachedAction,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (action.tool === "wait") {
    await sleep(action.ms);
    return { ok: true };
  }
  if (action.tool === "wait_for") {
    return await runWaitFor(action.predicate, action.timeoutMs);
  }
  if (action.tool === "back") {
    adCli.adbKey(4);
    return { ok: true };
  }
  if (action.tool === "dismiss_keyboard") {
    adCli.adbKey(111);
    return { ok: true };
  }
  const snap = adCli.snapshot();
  const ref = locatorToRef(snap, action.locator);
  if (!ref) {
    return {
      ok: false,
      reason: `cached locator did not resolve: ${JSON.stringify(action.locator)}`,
    };
  }
  if (action.tool === "fill") {
    adCli.fill(ref, action.text);
    return { ok: true };
  }
  if (action.tool === "press") {
    adCli.press(ref);
    return { ok: true };
  }
  return {
    ok: false,
    reason: `unknown cached tool: ${(action as { tool: string }).tool}`,
  };
}

async function runWaitFor(
  predicate: string,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = adCli.snapshot();
    const app = adCli.appstate();
    const ev = evaluateExpect(predicate, snap, app);
    if (ev.ok) {
      return { ok: true };
    }
    await sleep(250);
  }
  return {
    ok: false,
    reason: `wait_for timed out after ${timeoutMs}ms (predicate: ${predicate})`,
  };
}

function deriveCachePath(testCasePath: string): string {
  const base = path.basename(testCasePath, path.extname(testCasePath));
  return path.join("tests", "smoke", "cache", `${base}.json`);
}

function registerCleanup(): void {
  const handler = (): void => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    try {
      execFileSync(
        "adb",
        [
          "logcat",
          "-d",
          "-v",
          "time",
          "*:W",
          "ReactNativeJS:V",
          "ReactNative:V",
        ],
        {
          stdio: [
            "ignore",
            fs.openSync(path.join(ARTIFACTS_DIR, "logcat.txt"), "w"),
            "ignore",
          ],
        },
      );
    } catch {
      // best effort
    }
    adCli.closeSession();
    for (const pid of backgroundPids) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  };
  process.on("exit", handler);
  process.on("SIGINT", () => {
    handler();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    handler();
    process.exit(143);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

function fail(reason: string): never {
  log(`::error::${reason}`);
  process.exit(1);
}

main().catch((e: unknown) => {
  fail(`replay-only crashed: ${(e as Error).stack ?? String(e)}`);
});
