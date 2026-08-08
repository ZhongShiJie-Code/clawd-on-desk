# Custom Release Workflow

## Repository roles

- `origin` points to `https://github.com/ZhongShiJie-Code/clawd-on-desk.git`.
- `upstream` points to `https://github.com/rullerzhou-afk/clawd-on-desk.git`.
- `custom/v0.14.0` is the working branch for the current desktop build.
- `/Applications/Clawd on Desk.app` is a runtime installation, not a source
  directory.

## Change flow

1. Fetch `upstream` and start from the intended official tag or commit.
2. Apply only the features listed in the release manifest.
3. Run syntax checks, `verify:release` and `verify:custom`.
4. Run targeted tests for every changed module.
5. Build in a staging directory and verify the matching ASAR and unpacked
   resources as a pair.
6. Back up the installed pair before replacing it.
7. Test the real HUD with an active session.
8. Commit the source and manifest, then push the branch to `origin`.

## Rules

- Never edit the installed `.app` as the only copy of a change.
- Never commit `app.asar`, `app.asar.unpacked`, `node_modules`, backups or
  temporary staging directories.
- Never commit API keys, cookies, tokens or local configuration.
- Do not call a release verified when a test process is still running or has
  been terminated after a timeout.
- Keep upstream and custom commits separate so one feature can be reverted.
