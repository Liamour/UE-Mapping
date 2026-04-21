---
name: "automated-bug-triage-reporting"
description: "Automates bug triage, root cause analysis, and optimized reporting for UE 5.7 plugin project. Invoke when user reports a bug, error, crash, or unexpected behavior."
---

# Automated Bug Triage & LLM-Optimized Reporting

## UE 5.7 Plugin Specific Triage Workflow

### Step 1: Categorize Bug Type
1. **UE C++ Plugin Bugs**:
   - Editor plugin crashes
   - Slate UI rendering issues
   - Asset scanning/processing errors
   - WebBrowser communication failures
   - Memory leaks
2. **Web Frontend Bugs**:
   - JSON parsing/rendering performance issues
   - React Flow topology graph errors
   - Zustand state management bugs
   - UI/UX rendering issues

### Step 2: Root Cause Analysis
1. For C++ bugs:
   - Cross-reference with UE 5.7 official API documentation: https://dev.epicgames.com/documentation/unreal-engine/API
   - Check for invalid WITH_EDITOR scope usage
   - Verify main thread blocking operations
   - Analyze Unreal Automation Framework test results
2. For Web bugs:
   - Check for synchronous large JSON parsing
   - Validate React 18 strict mode compliance
   - Verify TypeScript type safety
   - Check Vitest test coverage

### Step 3: Reporting Format
Generate structured report with:
- **Severity**: Critical/High/Medium/Low
- **Root Cause**: Technical explanation with code references
- **Affected Modules**: UE plugin / Web frontend
- **Fix Recommendation**: Step-by-step solution
- **Validation Steps**: How to verify the fix
