# Gameplay-core — System Map

> Auto-generated MOC. Lists every node tagged `system/gameplay-core`. Regenerate from Settings → Rebuild MOCs.

_Last regenerated: 2026-04-26T19:17:37.285Z_

## Layer: gameplay

- [[BP_EnemyAI|../Blueprints/BP_EnemyAI.md]] — _role:behavior-tree · risk:critical_
  - Defines core enemy AI behavior consisting of chase and attack functionality for hostile in-game combat entities
- [[BP_GameMode|../Blueprints/BP_GameMode.md]] — _role:gamemode · risk:critical_
  - A core GameMode blueprint intended to trigger a game restart after a player death event
- [[BP_HealthComponent|../Blueprints/BP_HealthComponent.md]] — _role:component · risk:critical_
  - A reusable actor component for managing actor health, processing incoming damage, and dispatching death events for
- [[BP_PlayerCharacter|../Blueprints/BP_PlayerCharacter.md]] — _role:actor · risk:critical_
  - Base player character blueprint that implements core movement input and damage handling functionality for player-controlled
- [[BP_WeaponBase|../Blueprints/BP_WeaponBase.md]] — _role:actor · risk:warning_
  - Base weapon actor class that provides unimplemented Fire and Reload function entry points for derived weapon blueprints

---
Total nodes in this system: **5**
