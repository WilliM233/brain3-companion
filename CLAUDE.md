Scope: Repo-specific. Inherits from org CLAUDE.md (`a2fbaab5`). Adds conventions specific to the `brain3-companion` Android-companion application. On any conflict, follow the inheritance order in the org doc: org → repo → ticket-level direction.



\## Repo Purpose



`brain3-companion` is the Android-only companion app for BRAIN. Stream C of Phase 2 builds it out from a near-empty repo to a full notification-driven companion that talks to BRAIN's API. Sideload-only distribution; no Play Store presence.



\## Framework \& Pinned Versions



\- \*\*Ionic React\*\* v8.x

\- \*\*Capacitor\*\* 6.x — do NOT upgrade to 7+ without explicit decision

\- \*\*React\*\* 18.2 — do NOT upgrade to 19 without explicit decision

\- \*\*Vite\*\* (current)

\- \*\*TypeScript\*\* with `tsconfig.moduleResolution: Bundler`

\- \*\*TanStack Query\*\* for async state

\- \*\*Tailwind CSS\*\* for styling



CLI defaults may have drifted past these versions — honor the pin, not the default. `npm create @ionic/react-app@latest` will install whatever's current; the package.json pins are the contract. (\[2C-10] PR #27 D-3 is precedent: CLI installed Capacitor 8 + React 19, was downgraded to 6.x + 18.2 to honor the pin.)



\## Platform Scope



Android-only for v2.0.0. iOS parity deferred to a future release. Do not add iOS platform, iOS-specific code paths, or iOS-conditional logic. Per Pass 1 E1.



\## Build Environment



\*\*Default shell: Windows cmd.exe.\*\* L's primary dev environment is Windows. All build commands target Windows shell by default. Cross-platform variants are deferred to a polish ticket — do not add them speculatively.



\- Use `.\\gradlew.bat` not `./gradlew` (POSIX `./gradlew` does not parse on Windows). (\[2C-11] PR #28 D-1 is precedent.)

\- Path separators: backslash in shell commands.



\*\*Required environment variables\*\* (must be set in shell before running Gradle commands):

\- `JAVA\_HOME` — pointing at JDK install

\- `ANDROID\_HOME` — pointing at Android SDK install



If these aren't set, `npm run android:build:debug` and any Gradle command will fail with cryptic errors. See `android/keystore/README.md` for full setup. (\[2C-11] PR #28 D-3 is precedent.)



\*\*Android SDK pin:\*\* `buildToolsVersion = "35.0.0"` in `variables.gradle`. The SDK install lives in Program Files which is read-only — do not assume the build can write to the SDK directory. (\[2C-11] PR #28 D-2 is precedent.)



\## Distribution Model — Two Channels



\- \*\*Dev channel (experimental):\*\* GitHub Actions workflow on push to `develop` builds debug APK and publishes to GitHub Releases as a pre-release tagged `develop-{short-sha}`. Auto-prune to last 10. Sideload via the GitHub mobile app on device. Established by \[2C-15] PR #30.

\- \*\*Release channel (formal):\*\* Manual via release ceremony on `main`. L-generated release keystore signs locally; tag pattern `v{semver}`. Documented in `docs/RELEASE.md`. The release keystore stays local-only — never committed, never in CI.



\*\*Package name:\*\* `com.fluxmeridian.brain3companion`. Per Pass 3 O-4. Do not change this.



\## Test Conventions



\*\*Tests are co-located with the module they test.\*\* Pattern: `src/lib/foo.ts` → `src/lib/foo.test.ts`. Do NOT introduce new files in `tests/unit/` — that directory is being phased out. Existing tests in `tests/unit/` will migrate as their modules are touched. (\[2C-12] PR #29 D-1 + PR #33 follow-up are precedent.)



Run tests with `npm run test.unit`. Tests must be independent — no ordering dependencies. Use mocks/fixtures for external dependencies (Capacitor plugins, BRAIN API).



\## Lint \& Format



`npm run lint` must pass clean before opening any PR. Foundation PRs that introduce new top-level directories (e.g., `android/`) must update `eslint.config.js` ignores in the same PR — do not leave repo-wide lint failures for follow-up tickets to clean up. (\[2C-12] PR #29 D-4 is precedent for the cleanup, codified going forward.)



\## Asset Conventions



\*\*App icons + splash screens:\*\* SVG sources are committed to the repo. Raster assets (PNG, WebP) are generated from SVGs via `sharp` (devDep) using the npm script. Future icon/splash work edits the SVG, runs the regen script, commits both the SVG source and the regenerated rasters. Do not hand-edit raster assets. (\[2C-14] PR #34 D-3 is precedent.)



`@capacitor/assets` v3 is the primary tooling for adaptive icons. Legacy `ic\_launcher.png` is filled by a custom backfill script for older Android API levels — `@capacitor/assets` v3 doesn't produce it. (\[2C-14] PR #34 D-1 + D-2 are precedent.)



\## GitHub Actions



Prefer single-line semicolon/comma-delimited strings for package lists in YAML over multi-line forms. Multi-line YAML lists carry parse ambiguity risk — `android-actions/setup-android` is a known case (\[2C-Bug-01] PR #32 is precedent). When in doubt, single-line wins.



\## File Structure (post-Group 1)

brain3-companion/

├── android/                      # Capacitor Android platform

│   ├── keystore/                 # Debug keystore + setup README

│   ├── app/build.gradle          # buildToolsVersion, deps

│   └── variables.gradle          # SDK version pins

├── src/

│   ├── lib/                      # Modules + co-located tests

│   ├── pages/                    # Route components

│   └── App.tsx

├── docs/

│   └── RELEASE.md                # Two-channel distribution docs

├── eslint.config.js

├── package.json                  # Pinned versions — do NOT bump silently

├── tsconfig.json                 # moduleResolution: Bundler

└── vite.config.ts



\## npm Scripts



\- `npm run dev` — Vite dev server

\- `npm run build` — production build

\- `npm run lint` — ESLint over all source

\- `npm run test.unit` — Vitest unit tests

\- `npm run android:sync` — sync web build to Android platform

\- `npm run android:build:debug` — build debug APK

\- `npm run android:open` — open in Android Studio



\## Stream C Specifics



Group 1 = client foundation (✅ complete as of 2026-04-27). Group 2 = server + notification loop (the v2.0.0 DoD gate). Groups 3 + 4 build out habit/routine/rule surfaces and offline hardening. The Stream C Running Dispatch Checklist (`3da63076`) is the live state document — read it for current ticket status.



Stream C tickets: the \*\*filed GitHub issue body is the canonical contract.\*\* Each issue has Scope, Acceptance criteria, Out of scope, Technical notes, Dependencies, References. Some include a `#### Manual verification` section — preserve verbatim on merge; L runs the MV procedures, agent does not. If the issue body has no MV section, no MV obligations apply for that ticket. Auto-verifiable tickets are valid without MV.



\## Deviation Handling



If during implementation the spec proves incorrect (e.g., a CLI command in Technical notes doesn't work as described, a tool default drifted past a pinned version, a path doesn't exist), resolve the deviation while honoring the spec's intent and flag it in the PR body. Do NOT silently fix and move on — the deviation log is how BRAIN learns the spec landed wrong. The PR template's Deviations section is the contract.



\---

Created: April 27, 2026. v1.

Source: extracted from Desmond Brief Stream C Group 1 v3 (`4bc64b07`) settled decisions + post-merge precedents from PRs #27, #28, #29, #30, #32, #33, #34. Drift root cause: brain3-companion repo had no CLAUDE.md through Group 1 implementation; conventions accumulated in the brief instead of the repo. Closing the gap so future Stream C groups read CLAUDE.md for conventions and the brief for group-level framing.



Companion: org CLAUDE.md v5 (`a2fbaab5`) added the Inheritance and Source of Truth section the same day, codifying BRAIN-canonical / repo-working-copy direction.

