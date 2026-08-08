# Custom v0.14.0

This branch is based on the upstream `v0.14.0` source and records the desktop
build currently validated on the local Mac. It is intentionally separate from
the upstream release tag.

## Included

- DeepSeek balance, export, usage and dashboard data integration already present
  in the validated desktop build.
- Official Codex quota data path and the corresponding dashboard presentation.
- Claude Desktop session focus integration already present in the validated
  desktop build.
- Claude Desktop permission reminder mode: the HUD mirrors requests and can
  open Claude Desktop, while native Claude Desktop remains the only authority
  for allow/deny decisions.
- Avatar containment fixes for the HUD and dashboard.
- Quota-ring glyph rendering without image cropping.
- The upstream v0.14.0 agent assets for Claude Code and Codex, plus the
  DeepSeek icon used by the custom quota surface. It lives outside the runtime
  agent PNG directory so the upstream asset contract remains intact.

## Not Included

- The installed macOS `.app`, `app.asar`, or `app.asar.unpacked` directories.
- Local backups, staging directories, logs, credentials, cookies or tokens.
- The Android/mobile APK. That artifact remains in the separate
  `clawd-mobile-download` repository.

## Verification

- Upstream baseline: `ce6acbc7ee4ef85029d4a1a870edb667cfd878c3`.
- Package version: `0.14.0`.
- `npm run verify:release` passed.
- `npm run verify:custom` must pass before a release is pushed.
- The full upstream test suite must not be called green if a test process hangs;
  use the targeted test commands and record any upstream timeout separately.
