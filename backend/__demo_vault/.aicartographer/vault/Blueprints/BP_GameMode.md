---
id: BP_GameMode
asset_path: /Game/Core/BP_GameMode.BP_GameMode
type: Blueprint
parent_class: GameModeBase
scan:
  ast_hash: b10651b029f0
  scanned_at: '2026-04-26T17:31:55Z'
  model: ep-20260416103803-ckqm5
  engine_version: '5.7'
intent: A core GameMode blueprint intended to trigger a game restart after a player death event
risk_level: critical
tags:
- '#system/gameplay-core'
- '#layer/gameplay'
- '#role/gamemode'
---

# BP_GameMode

> [!intent]
> A core GameMode blueprint intended to trigger a game restart after a player death event

### [ INTENT ]
This root GameMode blueprint is designed to automatically restart the game session when a player dies.

### [ EXECUTION FLOW ]
- `OnPlayerDeath` event entry node is defined but has no connected downstream execution logic
- `RestartGame` execution node is declared but never wired to any trigger in the blueprint graph

### [ I/O & MUTATIONS ]
- Input: Unhandled `OnPlayerDeath` event trigger with no connected output
- Output: No game restart is ever invoked under any gameplay scenario
- State mutations: No intentional game state changes are executed due to fully disconnected graph flow

### [ ARCHITECTURAL RISK ]
Broken core gameplay loop: The intended game restart after player death never triggers, leaving the game stuck in a non-functional end state with no player recovery path.

## [ BACKLINKS ]

<!-- backlinks-start: AUTO-GENERATED, do not edit -->
- [[BP_HealthComponent]] — `interface_call`
<!-- backlinks-end -->

## [ NOTES ]
<!-- 此分隔线以下为开发者私域,扫描器永不修改 -->

rwar
