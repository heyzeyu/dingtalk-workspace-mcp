# Upstream provenance

- Official project: https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli
- Fixed release: https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/tag/v1.0.67
- Release commit: `63a7c4906c7dee10750011ea309b9eb78abb7eb0`
- Release publication: 2026-11-04.
- Checksums: https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/v1.0.67/checksums.txt
- License: Apache-2.0; LICENSE and NOTICE retained in `THIRD_PARTY_LICENSES/` and copied alongside the downloaded executable.

The MCP implementation and two focused Skills are independently authored under MIT. No broad upstream Skills or CLI binary are bundled. The installer fetches a fixed official release archive and verifies SHA-256 against constants in setup.mjs.

Version 0.3.0 ships reduced runtime Schema and Help-derived metadata under the upstream Apache-2.0 terms: 1,559 Schema commands across 33 products and 37 public utility leaves. The root Schema catalog hash is `sha256:9db2cc1f168a4ff64108c549ae9093528cb6f8de15574a4651de2c12defb77ad`. Actual macOS ARM64 leaf Help was collected for every Schema command; the dev mcp tool create/update long-help parsing bug uses the native -h fallback. Available parameter metadata agrees with 5,874 actual native flag entries. No live business handler is invoked during collection or compilation verification.

The original 99-operation Sheet catalogue is retained. Two stale chart/pivot example shapes were corrected against fixed-version official references and marked in that catalogue. The broader catalogue preserves native parameter types, output-mode collisions, Usage, effect, availability and integration decisions. These metadata are a versioned call contract, not proof of real-account permission or every API's successful execution.

Authentication/configuration/credential and persistent Agent lifecycle operations remain documented local workflows. Officially unavailable capabilities remain unavailable. Published MCP invocation preserves native fresh Schema validation, Raw API requires separate custom-app authentication, and the event adapter uses native ownership and graceful shutdown. No arbitrary shell, credential or endpoint override is exposed through the ordinary business router.

Reproduction and exact coverage: package-level CLI-COVERAGE.md and VALIDATION.md. Sources:

- https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/v1.0.67/README_zh.md
- https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/v1.0.67/skills/multi/dingtalk-misc/references/sheet.md
- https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/v1.0.67/skills/multi/dingtalk-shared/references/url-patterns.md

Codex packaging follows https://developers.openai.com/plugins/build/plugins and the locally available codex plugin CLI. Historical validation documents describe their own versions; the current contract is 0.3.0.

## Brand asset

The plugin logo and composer icon use the unmodified 444 × 444 PNG favicon linked by [DingTalk's official website](https://www.dingtalk.com/), retrieved on 2026-11-10:

- Asset: https://gw.alicdn.com/imgextra/i3/O1CN014ZbI6ZTEhdC0ttN2_!!6000000003783-2-tps-444-444.png
- Local file: `assets/dingtalk.png`
- SHA-256: `b3fb0715857df5d23213b5265166fabcb7f7b4b290890d7b5682a027cf39c85d`

The logo is a DingTalk brand asset used to identify this integration. It is not covered by this project's MIT license. The release builder permits only these exact public image bytes; all other binary content remains rejected.
