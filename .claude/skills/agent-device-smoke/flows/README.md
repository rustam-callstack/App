# Test case format

Plain-English numbered steps drive the runner. Each step optionally
declares a postcondition the runner verifies after the LLM (or the
cache replay) finishes the step.

## Grammar

```
1. <plain English step describing what to do>
   expect: <predicate>

2. <next step>
   expect: <predicate>

# Comments start with `#` and are ignored by the parser.
```

- Steps are numbered starting at 1, in order. Gaps are not allowed.
- Step text is free-form English. The LLM reads it and decides which
  `agent-device` calls to make. Be specific (`Enter "user@example.com"
into the email field`) rather than vague (`Sign in`).
- The `expect:` line is optional but **strongly recommended**. Without
  it the runner only knows the LLM claimed success — there is no
  independent check.
- Quoted literals in step text (e.g. `"user@example.com"`) survive
  to the bash-fallback path and act as input parameters when the LLM
  is unavailable.

## Predicates

The `expect:` clause supports a small DSL evaluated by the runner
(not the LLM). See `.github/scripts/agent-device-expect.ts` for the
authoritative parser.

| Predicate                              | Meaning                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `snapshot.contains_text("…")`          | Some node in the current snapshot has `text` containing the substring (case-insensitive).                             |
| `snapshot.field_with_text("…").exists` | Some `editable` node contains the substring — useful for "the email field has the email I just typed".                |
| `appstate.foreground == "…"`           | The package currently in the foreground matches exactly (e.g. `com.expensify.chat.dev`). Catches "did the app crash". |

To request more predicates, extend the parser; do not invent new
forms in test cases — they will produce `unrecognized expect clause`.

## Example

See [`examples/android-signin.testcase.txt`](examples/android-signin.testcase.txt).

```
1. Wait for the app to fully load and the SignIn screen to appear.
   expect: snapshot.contains_text("Phone or email")

2. Enter "rustam.zeinalov@callstack.com" into the email/phone field.
   expect: snapshot.field_with_text("rustam.zeinalov@callstack.com").exists

3. Press the Continue button.
   expect: appstate.foreground == "com.expensify.chat.dev"

4. Wait for the magic-code screen to appear.
   expect: snapshot.contains_text("Magic code")
```

## Authoring guidance

- **Keep steps short.** One observable transition per step. "Enter
  email and press Continue" should be two steps; the cache then
  records each transition independently and replays them faster.
- **Match the LLM's idiom.** "Press the X button" works better than
  "Click X" because the agent-device CLI tool is `press`. The LLM
  will figure either out, but matching reduces variance.
- **Quote literal inputs.** `Enter "X" into the field` — quotes are
  what the bash fallback extracts when the LLM is unavailable.
- **Don't enumerate UI structure.** "Press the second button in the
  third row" couples your test to layout. "Press the Continue button"
  couples to label, which the cache signature handles correctly
  (it's text-content; falls through to LLM on label change).
- **One file per flow.** Each `.testcase.txt` gets its own committed
  cache at `tests/smoke/cache/<filename>.json`. Name files by intent
  (`android-signin.testcase.txt`, not `test1.testcase.txt`).

## How the cache works

The runner records, per step:

- `pre_signature` — structural SHA of the snapshot before the step
  ran (kinds + roles + flags only — NO text content, so locale rotation
  and copy churn don't bust the cache).
- `post_signature` — same, after.
- `actions` — the role-based locators the LLM (or bash-fallback)
  tapped/typed against. Locators are stable across runs (`{kind:
"text-field", index: 0, editable: true}` resolves to whatever ref
  is currently the first editable text-field).
- `expect` — the postcondition string verbatim from the test case.

On a future run the runner takes a snapshot, computes the
pre-signature, looks up `(test_case_hash, step_number, pre_signature)`
in the cache. **Hit:** replay the recorded actions, verify post-state
matches the recorded post-signature AND the `expect` clause passes.
**Miss / drift:** fall through to LLM (or hard-fail in Replay mode).

This is why the cache file diff is a **review signal**: when the
SignIn UI shape changes (new field, different layout), the
signatures rotate, the cache diffs, and the reviewer sees a small
JSON delta with the old vs new structure. That's the design intent
— the canary's job is to catch shape drift on a known flow, not to
exercise the LLM's reasoning every PR.

## Predicates that don't pass on the cached path

If the LLM-driven run records actions that satisfy `expect` against
the live UI but the cached actions don't satisfy it on replay (e.g.
the cache missed a `fill` and only recorded `press`), the cache-hit
path fails post-state verification, the runner falls through to LLM,
and the cache rewrites itself. Replay mode (no API key) hard-fails
with the structured error from `agent-device-expect.ts`. Either way
the **expect clause is the source of truth**, never the LLM's
self-claimed `step_complete`.

## Out of scope today

- **iOS coverage** — boot dance is Android-only. iOS path needs a
  parallel `xcrun simctl` recipe in the driver.
- **`.ad` macro composition** — running an existing `.ad` deterministic
  flow as one step of a `.testcase.txt`. Promising for flows the
  team has already recorded; not built yet.
- **Multi-test-case orchestration** — running an entire directory of
  test cases and emitting a summary. One test case per invocation
  for now.
- **Parametrization** — `${EMAIL}` substitution at invocation time.
  The existing `.ad` flows have this via `@param` headers; smoke
  test cases hardcode their literals today.
