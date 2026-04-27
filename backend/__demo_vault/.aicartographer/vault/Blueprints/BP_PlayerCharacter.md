---
id: BP_PlayerCharacter
asset_path: /Game/Characters/BP_PlayerCharacter.BP_PlayerCharacter
type: Blueprint
parent_class: Character
scan:
  ast_hash: 74922cdf6f38
  scanned_at: '2026-04-26T17:31:58Z'
  model: ep-20260416103803-ckqm5
  engine_version: '5.7'
intent: Base player character blueprint that implements core movement input and damage handling functionality for player-controlled
  pawns
risk_level: critical
tags:
- '#system/gameplay-core'
- '#system/input'
- '#system/combat'
- '#layer/gameplay'
- '#role/actor'
edges:
  function_call:
  - target: BP_HealthComponent
    refs:
    - TakeDamage
  spawn:
  - target: BP_WeaponBase
    refs:
    - EquipWeapon
---

# BP_PlayerCharacter

> [!intent]
> Base player character blueprint that implements core movement input and damage handling functionality for player-controlled pawns

### [ INTENT ]
Serve as the functional core of the player character, enabling movement input processing and incoming damage handling.

### [ EXECUTION FLOW ]
- No execution or data connections exist between any declared nodes in the blueprint graph
- BeginPlay initialization entry, MoveForward input node, and ApplyDamage node are all declared but not wired into any functional flow

### [ I/O & MUTATIONS ]
- Intended inputs: Movement axis input for movement logic, damage event parameters for damage processing
- No connected outputs or valid state mutations are possible: no functionality can execute as all nodes are disconnected
- No persistent or runtime state changes are achievable from the provided graph structure

### [ ARCHITECTURAL RISK ]
All core gameplay nodes are completely unconnected, resulting in non-functional player movement and damage handling that breaks core player gameplay. This is a showstopping logical flaw.

## [ BACKLINKS ]

<!-- backlinks-start: AUTO-GENERATED, do not edit -->
- [[BP_EnemyAI]] — `function_call`
- [[BP_WeaponBase]] — `cast`
<!-- backlinks-end -->

## [ NOTES ]
<!-- 此分隔线以下为开发者私域,扫描器永不修改 -->

*(在此处记录你对该节点的理解、坑点、TODO。重扫不会覆盖此区域。)*
