<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Plane-test harness — `brain3-companion`

Manual ship-condition verification procedure for v2.0.0 offline resilience.

---

## Purpose

Spec v0.9 names a single binding criterion for the v2.0.0 release:

> *the app is demo-ready in airplane mode.*

This document is the procedure that proves it. The harness exercises the full offline loop end-to-end — pair → seed cache → go offline → exercise queues → reconnect → drain — and verifies the device-side state and the server-side state at each gate. It is the canonical Manual verification reference cited by [`[2C-27]`](https://github.com/WilliM233/brain3-companion/issues/21) through [`[2C-31]`](https://github.com/WilliM233/brain3-companion/issues/25).

The harness is **not** automated for v2.0.0 — graceful degradation is a UX criterion judged by an operator on a real device, not a test runner. Phase 3+ may codify a regression budget via Detox or Maestro; that is out of scope here.

---

## Prerequisites

Before starting, confirm all of the following:

- **Paired test device.** A physical Android phone running a `brain3-companion` build (debug APK from the dev channel, or a release APK). Reference device is the test Galaxy S phone paired to the reference Galaxy Watch.
- **Populated server.** The BRAIN instance the device is paired against has, at minimum:
  - ≥ 3 active habits
  - ≥ 1 active routine
  - ≥ 1 active rule
  - ≥ 1 recent notification (within the last 24 h)
  - ≥ 1 recent check-in
- **Network controls.** Airplane mode toggle on the phone is the canonical offline switch.
- **Optional dev tooling.**
  - Charles or an equivalent man-in-the-middle proxy, if you want to inject specific HTTP status codes (e.g., force a 5xx to test the **degraded** state without flipping airplane mode).
  - `adb` with a USB-connected device, for direct Capacitor Preferences inspection (see [Tooling notes](#tooling-notes)).
  - `curl` against the paired BRAIN instance, to confirm server-side state after queue drain.

The reference operator runtime for an experienced run is **~10 minutes**.

---

## Procedure

A single integrated 11-step sequence. Run top to bottom in one session — the steps build state for one another.

> Each step's **Expected outcome** appears alongside in the [Expected outcomes](#expected-outcomes) section below; refer to that section while executing.

1. **Pair the device on a working network.** Open the app, enter the BRAIN URL and token on the Connect screen, tap Save. Confirm the initial seed completes (per `[2C-31]` MV step 1) — the "Setting up…" overlay dismisses and the first navigation into Notifications, Habits, Routines, Rules, and Recent Check-ins each renders content without a loading spinner.
2. **Exercise each surface with network on, to confirm baseline.** Navigate Notifications → Habits → Routines → Rules → Recent Check-ins. Tap into one habit detail. Tap into one routine. Everything renders the populated server data.
3. **Enable airplane mode. Cold-start the app.** Flip airplane mode on. Force-stop the app (Settings → Apps → brain3-companion → Force stop, or swipe it out of recents) and relaunch.
4. **Open each surface offline.** Navigate Notifications → Habits → Routines → Rules → Recent Check-ins. Confirm cached content renders, the connection indicator transitions to **gray (offline)** (per `[2C-27]`), and the staleness banner reads `Showing cached data — last synced Xm ago` (per `[2C-28]`).
5. **Queue a watch canned response (or simulated equivalent).** Tap a canned response on the watch — or, if no watch is attached, trigger the equivalent dev-panel action that enqueues a notification response. Confirm the entry enters the `brain.writeQueue` Preferences key.
6. **Mark a habit complete.** From the offline Habits list (or a habit detail page), tap the complete action on one habit. Confirm the entry enters `brain.writeQueue.habitCompletions`.
7. **Complete a routine.** Open one routine and run its `all_done` flow. Confirm the entry enters `brain.writeQueue.routineCompletions`.
8. **Open Settings → Pending sync.** Confirm three entries are visible in the Pending sync disclosure, grouped by queue (notification response, habit completion, routine completion), per `[2C-30]`.
9. **Disable airplane mode.** Flip airplane mode off.
10. **Watch the indicator briefly pulse green and the queues drain.** The connection indicator pulses **green** briefly during flush (per `[2C-27]`). Within ~30 seconds, all three queues drain and the Pending sync disclosure row hides itself.
11. **Verify the server.** Using `curl` against the paired BRAIN instance (or the BRAIN UI), confirm that each of the three writes — notification response, habit completion, routine completion — landed exactly once with correct payloads. No duplicates, no missing writes.

---

## Expected outcomes

Pass/fail criterion for each step in the [Procedure](#procedure).

| # | Pass criterion | Fail signals |
|---|---|---|
| 1 | "Setting up…" overlay dismisses within ~2 s of Save. First navigation to each of the five surfaces renders data without a loading spinner. | Overlay persists, or any surface shows a spinner on first navigation. |
| 2 | All five surfaces, one habit detail, and one routine render populated server data with no error toasts. | Empty state shown for any surface, or a "couldn't load" / "offline" message appears while online. |
| 3 | App relaunches cleanly with airplane mode active. No crash, no white-screen. | Crash, ANR, or stuck splash. |
| 4 | Every surface renders cached content. Indicator is **gray**. Banner reads exactly `Showing cached data — last synced Xm ago` (where `X` is the minute count since the last successful sync). | Surface renders empty, indicator is not gray, or banner is missing / shows a different string. |
| 5 | Inspecting Preferences shows a new entry in the `brain.writeQueue` key (the notification-response queue). | Key is empty, missing, or contains no new entry after the action. |
| 6 | A new entry appears in `brain.writeQueue.habitCompletions`. The habit visually reflects its completed state on the surface. | Key has no new entry, or the habit does not visually update. |
| 7 | A new entry appears in `brain.writeQueue.routineCompletions`. The routine visually reflects its completed state. | Key has no new entry, or the routine does not visually update. |
| 8 | Pending sync disclosure shows three entries, grouped by queue. | Fewer than three entries shown, or no grouping. |
| 9 | Airplane mode toggles off; phone reconnects to its network. | Phone fails to associate with network (operator-fault, not app-fault — re-run from step 3). |
| 10 | Indicator briefly **pulses green** during flush. Within ~30 s: all three queues empty, Pending sync row hides. | Indicator stays gray, queues do not drain within ~60 s, or Pending sync row persists. |
| 11 | All three writes present on the server, exactly once, with correct payloads. | Any write missing, duplicated, or with wrong payload. |

A run passes the harness only when every step passes. A single fail invalidates the run; consult [Failure modes & escalation](#failure-modes--escalation), fix, and re-run from step 1.

---

## Failure modes & escalation

Common symptoms mapped to the most likely owning ticket. This table aids debugging without re-deriving the system.

| Symptom (during which step) | Most likely owner | What to look at first |
|---|---|---|
| Cached content does not render after cold-start (step 4) | `[2C-31]` cache lifecycle | `brain.cache.seedCompleteFor` key + `brain.cache.*` blob keys via `adb`. Was seed completed in step 1? |
| Staleness banner missing or shows wrong copy (step 4) | `[2C-28]` staleness banner + pull-to-refresh | `src/components/StalenessBanner.tsx` and the surface's wiring of `useSurfaceLastSync`. |
| Indicator stays gray after reconnect (step 10) | `[2C-27]` connection tri-state | `src/lib/connection/` — `useConnectionState`, `ConnectionStateProvider`. Verify `@capacitor/network` is firing change events. |
| Indicator never pulses green during flush (step 10) | `[2C-27]` + `[2C-29]` meet at `writeQueueFlushState` event | `src/lib/connection/writeQueueFlushState.ts` — confirm the emitter fires on flush start and the connection store subscribes. |
| Write-queue keys empty after offline action (steps 5–7) | `[2C-23]` / `[2C-07]` write-queue factory | `src/lib/writeQueue.ts` — confirm the surface's mutation hits the factory's enqueue path when offline. |
| Queues do not drain within ~30 s after reconnect (step 10) | `[2C-29]` backoff + permanent-failure handling | `src/lib/writeQueue.backoff.test.ts` / `writeQueue.permanentFailure.test.ts`. Inspect `brain.writeQueue.failures.*` for a permanent-fail halt. |
| Pending sync row does not show three entries (step 8) or fails to hide post-drain (step 10) | `[2C-30]` Settings — Pending sync inspection | `src/components/PendingSyncSection.tsx` + `src/lib/pendingSync.ts`. Confirm the aggregator subscribes to `writeQueueFlushState`. |
| Server has duplicate writes (step 11) | `[2C-29]` + queue factory | Idempotency on the server side and retry semantics in the queue — duplicate landing means a successful response was missed and the entry was retried. |
| App crashes when entering airplane mode (step 3) or relaunching (step 3) | Out of harness scope — file a bug | Capture `adb logcat` from the crash, file as `[2C-Bug-NN]`. |

---

## Tooling notes

### Inspecting Capacitor Preferences

Capacitor Preferences are stored as Android SharedPreferences under the app's data dir. On a **debug build** (developer-signed APK from the dev channel) you can read them via `adb shell run-as`:

```cmd
adb shell run-as com.fluxmeridian.brain3companion cat shared_prefs\CapacitorStorage.xml
```

The output is XML; each `brain.*` key appears as a `<string name="brain.foo">…</string>` entry.

> **Release builds are not `run-as`-readable.** A release-signed APK (the formal release channel) disables `run-as`. For release-channel debugging, the operator-facing path is the in-app **Settings → Pending sync** disclosure (`[2C-30]`), which surfaces the queue state without `adb`. Direct Preferences inspection on a release build requires a rooted device or rebuilding as debug.

To filter to the keys relevant to this harness:

```cmd
adb shell run-as com.fluxmeridian.brain3companion cat shared_prefs\CapacitorStorage.xml | findstr "brain.writeQueue brain.cache brain.pairing"
```

### Forcing an HTTP error code without flipping airplane mode

For the **degraded** state (network up, but server returning 5xx), it is faster to inject a status code than to take a server outage. Two options:

- **Charles Proxy** — add a Map Remote → Rewrite rule that maps the brain3-companion dev API origin to a local responder returning the status code you want. Phone connects through Charles via the LAN-proxy setting.
- **Dev-server middleware** — for testing against a local BRAIN instance, add a temporary FastAPI dependency that returns a chosen status code for the route under test. Revert before merge.

The degraded state is **not** part of the airplane-mode procedure above — it is a supplementary check for the indicator's **amber** state. The plane-test harness above exercises the **gray** (offline) state only.

### Inspecting dev-API state via `curl`

For step 11, after the queues drain, hit the paired BRAIN instance directly to confirm each write landed:

```cmd
curl -H "Authorization: Bearer <token>" https://<brain-host>/api/app/notifications?limit=5
curl -H "Authorization: Bearer <token>" https://<brain-host>/api/app/habits/<habit-id>/completions?limit=5
curl -H "Authorization: Bearer <token>" https://<brain-host>/api/app/routines/<routine-id>/completions?limit=5
```

The most recent entry on each list should match the write the harness queued, with exactly one occurrence. Two occurrences for one write is a duplication failure — see the failure-modes table.

---

## When to run the harness

- **Pre-release-tag gate.** Run end-to-end before every release-channel tag cut, as part of the Regina release ceremony pre-flight. A failed harness blocks the tag.
- **Post-merge regression check.** Run after any merge to `develop` that touches `src/lib/writeQueue.ts`, `src/lib/connection/`, `src/lib/cacheSeed.ts`, or `src/lib/cacheWipe.ts`. These are the four implementation surfaces that the harness covers; changes elsewhere are unlikely to break the loop, but changes inside these surfaces should be re-verified.
- **Doc-as-its-own-dogfood.** Any edit to this document itself implies a re-run — the harness should pass against itself before the edit lands on `develop`.
