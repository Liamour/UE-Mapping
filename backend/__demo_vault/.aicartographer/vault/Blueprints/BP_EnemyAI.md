---
id: BP_EnemyAI
asset_path: /Game/AI/BP_EnemyAI.BP_EnemyAI
type: Blueprint
parent_class: Pawn
scan:
  ast_hash: 6fd1c793e1d8
  scanned_at: '2026-04-26T17:31:57Z'
  model: ep-20260416103803-ckqm5
  engine_version: '5.7'
intent: Defines core enemy AI behavior consisting of chase and attack functionality for hostile in-game combat entities
risk_level: critical
tags:
- '#system/ai'
- '#system/combat'
- '#system/gameplay-core'
- '#layer/gameplay'
- '#role/behavior-tree'
edges:
  function_call:
  - target: BP_PlayerCharacter
    refs:
    - GetLocation
---

# BP_EnemyAI

> [!intent]
> Defines core enemy AI behavior consisting of chase and attack functionality for hostile in-game combat entities

### [ INTENT ]
Implements hostile enemy AI combat behavior that enables enemy entities to chase and attack the player during gameplay encounters.

### [ EXECUTION FLOW ]
- Two independent behavior nodes `ChasePlayer` and `Attack` are declared in the graph
- No connecting edges exist between nodes, so no execution order or transition logic is defined

### [ I/O & MUTATIONS ]
- No connected input flows, parameter inputs, or output flows are defined due to the empty edge set
- No AI state or game world mutations can be triggered as the nodes cannot execute in a functional sequence

### [ ARCHITECTURAL RISK ]
Core enemy AI functionality is completely non-functional due to missing execution flow connections. Enemy actors will remain unresponsive during combat encounters, breaking core gameplay loops that rely on hostile AI engagement.

## [ BACKLINKS ]

<!-- backlinks-start: AUTO-GENERATED, do not edit -->
*(no incoming references)*
<!-- backlinks-end -->

## [ NOTES ]
<!-- 此分隔线以下为开发者私域,扫描器永不修改 -->

*(在此处记录你对该节点的理解、坑点、TODO。重扫不会覆盖此区域。)*
