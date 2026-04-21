---
name: "automated-end-of-day-git-protocol"
description: "Manages end-of-development Git workflow including status check, commit, push, and state save. Invoke when user inputs phrases like 'End today's development', 'wrap up', 'clock out', or 'save state'."
---

# Automated End-of-Day Git Protocol

## Workflow for UE 5.7 Plugin Project

### Step 1: Pre-commit Validation
1. Run C++ static analysis on UE plugin code
2. Verify no uncommitted binary assets larger than 100MB
3. Check that all modified code follows UE 5.7 coding standards
4. Ensure no WITH_EDITOR API usage outside editor scope

### Step 2: Git Operations
1. Display git status summary
2. Generate conventional commit message based on changes
3. Commit changes with proper prefix:
   - `feat(ue):` for UE plugin feature additions
   - `fix(ue):` for UE plugin bug fixes
   - `feat(web):` for web frontend feature additions
   - `fix(web):` for web frontend bug fixes
   - `docs:` for documentation updates
4. Push to current branch

### Step 3: State Preservation
1. Save all open files in IDE
2. Generate build cache snapshot for UE plugin
3. Record current working state in .trae/state/ directory
