---
id: BP_HealthComponent
asset_path: /Game/Components/BP_HealthComponent.BP_HealthComponent
type: Component
parent_class: ActorComponent
scan:
  ast_hash: b5146141692a
  scanned_at: '2026-04-26T17:32:06Z'
  model: ep-20260416103803-ckqm5
  engine_version: '5.7'
intent: A reusable actor component for managing actor health, processing incoming damage, and dispatching death events for
  combat-enabled actors.
risk_level: critical
tags:
- '#system/gameplay-core'
- '#system/combat'
- '#layer/gameplay'
- '#role/component'
edges:
  interface_call:
  - target: BP_GameMode
    refs:
    - NotifyDeath
---

# BP_HealthComponent

> [!intent]
> A reusable actor component for managing actor health, processing incoming damage, and dispatching death events for combat-enabled actors.

### [ INTENT ]
Provide reusable health and damage handling functionality that triggers a death event when an actor's health is depleted to zero.

### [ EXECUTION FLOW ]
- Two disconnected top-level nodes exist: `TakeDamage` (entry point for incoming damage processing) and `OnDeath` (output death event).
- No execution or data connections are defined between any nodes in the provided AST.

### [ I/O & MUTATIONS ]
- Input: Incoming damage routed through the `TakeDamage` entry point
- Output: Death signal broadcast via the `OnDeath` event
- No health state modifications, death checks, or other state mutations are defined in the provided graph structure.

### [ ARCHITECTURAL RISK ]
Core logic linking damage intake to death triggering is missing due to no connected graph flow. If this reflects the full Blueprint, the `OnDeath` event will never fire when health is depleted, breaking all combat functionality for actors that use this component.

## [ BACKLINKS ]

<!-- backlinks-start: AUTO-GENERATED, do not edit -->
- [[BP_PlayerCharacter]] — `function_call`
<!-- backlinks-end -->

## [ NOTES ]
<!-- 此分隔线以下为开发者私域,扫描器永不修改 -->

*(在此处记录你对该节点的理解、坑点、TODO。重扫不会覆盖此区域。)*
