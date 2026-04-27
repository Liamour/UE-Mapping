---
id: BP_WeaponBase
asset_path: /Game/Weapons/BP_WeaponBase.BP_WeaponBase
type: Blueprint
parent_class: Actor
scan:
  ast_hash: d632d9c6d941
  scanned_at: '2026-04-26T17:31:58Z'
  model: ep-20260416103803-ckqm5
  engine_version: '5.7'
intent: Base weapon actor class that provides unimplemented Fire and Reload function entry points for derived weapon blueprints
risk_level: warning
tags:
- '#system/gameplay-core'
- '#system/combat'
- '#layer/gameplay'
- '#role/actor'
edges:
  cast:
  - target: BP_PlayerCharacter
    refs:
    - GetOwner
---

# BP_WeaponBase

> [!intent]
> Base weapon actor class that provides unimplemented Fire and Reload function entry points for derived weapon blueprints

### [ INTENT ]
Provides a reusable base class for all project weapons, declaring core combat entry points for firing and reloading to be extended and implemented by child blueprints.

### [ EXECUTION FLOW ]
- Two top-level function entry nodes, `Fire` and `Reload`, are declared
- No connected execution edges or logic chains exist for either entry point, so no logic runs when either function is called

### [ I/O & MUTATIONS ]
- Key inputs: No input parameters or external inputs defined for either function
- Key outputs: No output values defined for either function
- State changes: No actor or global game state mutations are implemented

### [ ARCHITECTURAL RISK ]
Unimplemented core entry points result in fully non-functional weapons if the base class is instantiated directly, or if child blueprints fail to add logic to the declared entry points, creating a predictable point of broken combat gameplay when misused.

## [ BACKLINKS ]

<!-- backlinks-start: AUTO-GENERATED, do not edit -->
- [[BP_PlayerCharacter]] — `spawn`
<!-- backlinks-end -->

## [ NOTES ]
<!-- 此分隔线以下为开发者私域,扫描器永不修改 -->

*(在此处记录你对该节点的理解、坑点、TODO。重扫不会覆盖此区域。)*
