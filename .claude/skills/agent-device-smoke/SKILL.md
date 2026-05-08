---
name: agent-device-smoke
description: Run an LLM-driven mobile smoke test from plain-English steps on a local Android emulator. Use when the developer wants to verify a flow ("sign-in", "create expense") end-to-end without writing selector code — supply numbered English steps with optional `expect:` postconditions and Claude drives agent-device to make them pass.
allowed-tools: Bash(npm run smoke:android:llm *) Bash(npx ts-node *) Bash(agent-device --version) Bash(adb devices) Bash(adb shell *) Bash(curl -sf *) Bash(grep *) Bash(jq *) Bash(test *) Bash(ls *)
---

# agent-device-smoke

LLM-driven Android emulator smoke runner. Reads plain-English test steps from a `.testcase.txt` file, optionally consults a committed replay cache, and drives the dev APK end-to-end via the `agent-device` CLI. Same engine as the Phase 1 CI canary (`smokeAndroidLLM.yml`); this skill is the local-developer surface.

## Pre-flight (auto)

These checks evaluate at skill load. If any line shows `FAIL`, stop and surface the fix before invoking the runner.

agent-device version: !`R=0.14.7; V=$(agent-device --version 2>/dev/null); [ -n "$V" ] && [ "$(printf '%s\n%s\n' "$R" "$V" | sort -V | head -1)" = "$R" ] && echo "OK ($V)" || echo "FAIL (need v$R+, got: ${V:-not installed}). Fix: npm install -g agent-device@${R}"`

Phase 1 driver present: !`F=.github/scripts/agent-device-llm-driver.ts; test -f "$F" && echo "OK ($F)" || echo "FAIL (missing $F). Fix: rebase this branch onto feat/agent-device-smoke-llm-driver, or wait for that PR to merge."`

Online emulator/device count: !`N=$(adb devices 2>/dev/null | awk 'NR>1 && $2=="device"' | wc -l | tr -d ' '); [ "$N" = "1" ] && echo "OK (1 device)" || echo "${N:-0} devices online — this skill prompts before proceeding when count != 1."`

Metro port 8081 status: !`O=$(curl -sf http://localhost:8081/status 2>/dev/null); if [ -z "$O" ]; then echo "OK (port free — driver will start Metro)"; elif echo "$O" | grep -q 'packager-status:running'; then echo "OK (Metro already running — driver will reuse)"; else echo "WARN (port 8081 in use by something other than Metro: $O — kill it before running)"; fi`

Mode select (ANTHROPIC_API_KEY): !`if [ -n "${ANTHROPIC_API_KEY:-}" ]; then echo "LLM mode (key present, length=${#ANTHROPIC_API_KEY})"; else echo "Replay mode (no key — cache-hits only, will hard-fail on miss)"; fi`

Cache file (sample): !`C=tests/smoke/cache/android-signin.testcase.json; test -f "$C" && echo "OK ($C, $(jq '.steps | length' "$C" 2>/dev/null) steps cached)" || echo "WARN (no cache at $C — first LLM-mode run will create it)"`

## When to use

The user supplies (or already has) a `.testcase.txt` file describing a flow as numbered English steps. Examples:

> "Run the smoke against `tests/smoke/android-signin.testcase.txt`."
> "Drive the sign-in flow on my emulator."
> "Verify magic-code reaches via `flows/examples/android-signin.testcase.txt`."

If the user describes a flow but no test case file exists yet, offer to create one in `flows/examples/` from a transcript of their requested steps. See [`flows/README.md`](flows/README.md) for the format spec.

## Mode selection

The skill auto-selects between two modes at invocation. Both consume the same test case file and (if present) the same cache file:

| Mode       | Trigger                      | Behavior                                                                                                                                                                                |
| ---------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LLM**    | `ANTHROPIC_API_KEY` is set   | Calls the Phase 1 driver. Cache-first → LLM fallback → bash fallback ladder. Adapts on UI drift. ~$0.15–0.30 / cache-miss run; ~$0 / cache-hit.                                         |
| **Replay** | `ANTHROPIC_API_KEY` is unset | Calls `scripts/replay-only.ts`. Cache-only. Hard-fails with a structured error on cache miss. Useful when the cache is known good and the developer wants determinism with no API call. |

Tell the user which mode is active before invoking, and report the cache hit rate at the end.

## Workflow

Run this sequence the first time the user asks for a smoke run in a session.

### 1. Resolve the test case path

If the user names a flow (e.g. `android-signin`), resolve in this order:

1. `tests/smoke/<name>.testcase.txt` (canonical, used by CI)
2. `.claude/skills/agent-device-smoke/flows/examples/<name>.testcase.txt`
3. As-given (if it's already a path that exists)

Fail fast with a list of available test cases if no match — don't assume.

### 2. Confirm device

If pre-flight reported exactly one device, use it. Otherwise:

```bash
adb devices
```

If 0 devices: stop and ask the user to boot an emulator (`emulator -avd <name> -no-window &` if they don't already have one running).

If 2+ devices: prompt the user to pick a serial. Capture it as `ANDROID_SERIAL` for the runner. The Phase 1 driver currently uses `adb get-serialno` which fails when multiple devices are online — workaround until the driver accepts an explicit serial flag is to set `ANDROID_SERIAL` in the env before invocation; `adb` honors it.

### 3. Confirm dev APK is installed

```bash
agent-device apps --user-installed --json --platform android
```

The runner installs from `android/app/build/outputs/apk/development/debug/*.apk` so the APK must already be built. If the bundle ID `com.expensify.chat.dev` is missing, **STOP** and instruct the developer to run `npm run android` from `Mobile-Expensify/`.

### 4. Invoke the runner

**LLM mode:**

```bash
npm run smoke:android:llm -- <test-case-path>
```

**Replay mode:**

```bash
npx ts-node .claude/skills/agent-device-smoke/scripts/replay-only.ts <test-case-path>
```

The runner streams `::group::` / `::notice::` / `::warning::` / `::error::` markers to stdout. Surface those to the user as conversation updates. Don't try to parse them silently — the user wants to see the timeline.

### 5. Read the results

After the runner exits, the `artifacts/` directory contains:

- `step-N-pre.txt` / `step-N-post.txt` — UI snapshot before/after each step
- `cache-recorded.json` — what the runner observed this run
- `cache-diff.txt` — drift vs the committed cache file
- `llm-trace.jsonl` — per-call usage (LLM mode only)
- `boot-probe-NN-tNs.txt` — every-30s probe during boot wait
- `boot-timeout-{snapshot,appstate,png}` — only if boot timed out
- `metro.log` / `logcat.txt` — full streams for post-mortem

Present a short summary to the user: per-step pass/fail, magic-code reached evidence, and either "no cache drift" or "cache changed — review and commit `cache-recorded.json` to `tests/smoke/cache/<name>.json`".

### 6. Cleanup

The driver registers its own `process.on('exit', …)` cleanup — it dumps logcat and runs `agent-device close --session ci`. Do **not** wrap the runner in a way that prevents that trap from firing. If Claude Code is interrupted mid-run, the next invocation may see "session already bound"; the existing `agent-device` skill's bring-up reset prompt handles that.

## Failure modes the skill must address

- **No emulator booted.** Pre-flight catches; stop with clear instructions.
- **Multiple emulators.** Prompt the user; set `ANDROID_SERIAL`.
- **Stale Metro on :8081.** Pre-flight warns; user kills it before run.
- **No cache + no API key.** Replay mode hard-fails fast — surface the actual `step_failed` reason verbatim, do not retry.
- **Cache drift detected.** LLM mode emits a `cache-diff.txt`. Show the diff and ask the user whether to commit `cache-recorded.json` over the committed cache.
- **APK out of date.** The driver uses whatever's in `android/app/build/outputs/apk/development/debug/`. If a JS-only change shipped without rebuilding the APK, the bundle JS is fresh but the APK's bundled assets aren't — recommend `npm run android` from `Mobile-Expensify/`.

## What this skill is NOT

- **Not a debugger.** For interactive `snapshot/find/press/replay` against the live device, use the existing [`agent-device`](../agent-device/SKILL.md) skill.
- **Not iOS yet.** The boot dance is Android-only (`adb install`, `adb reverse`, `am start`). iOS support is a v2 follow-up — see [`flows/README.md`](flows/README.md).
- **Not a `.ad` macro runner.** This skill consumes plain-English `.testcase.txt`. The `.ad` flow format used by the existing skill is a different paradigm (deterministic selectors with `@pre`/`@post`); composing the two is a v2 idea.

## Related references

- Phase 1 implementation: `.github/scripts/agent-device-llm-driver.ts` and siblings
- CI workflow: `.github/workflows/smokeAndroidLLM.yml`
- Sample test case: [`flows/examples/android-signin.testcase.txt`](flows/examples/android-signin.testcase.txt)
- Format spec: [`flows/README.md`](flows/README.md)
