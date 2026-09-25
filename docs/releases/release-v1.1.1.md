## v1.1.1

This maintenance build carries the locally maintained desktop integrations and
account-quota fixes into the user's own repository. It does not change how
Claude Desktop or Antigravity authorizes tools.

### Desktop integrations and quota

- Restore passive Claude Desktop Cowork activity reminders without surfacing
  raw tool arguments or adding Allow/Deny controls.
- Restore Codex quota reading when Claude Desktop uses the local CLIProxyAPI
  gateway, keeping Codex quota separate from Spark quota.
- Read Antigravity's documented `/usage` snapshot through `agy` and display its
  account-wide Gemini and third-party quota buckets. Antigravity Desktop and
  CLI share account entitlements, so the snapshot reflects both and cannot
  attribute usage to one client.
- Preserve local session monitoring and quota state when the monitors stop or
  restart.

### Contributor

Thanks to @ZhongShiJie-Code for maintaining and validating this fork's desktop
build.

### Distribution status

The repository is configured to publish update checks from
`ZhongShiJie-Code/clawd-on-desk`. The current local macOS build is ad-hoc signed
for testing and manual installation only. Do not publish it as an automatic
macOS update: a Developer ID certificate and Apple notarization credentials
must be configured first.

### Validation status

Source tests and a local x64 package build are required before installation.
Gatekeeper acceptance, notarization, GitHub-hosted signed assets, and the
v1.0.0-to-v1.1.1 automatic updater path remain unvalidated until signed
release credentials are configured.
