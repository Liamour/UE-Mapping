---
name: "world-class-architecture-code-standard"
description: "Enforces UE 5.7 plugin architecture best practices and code standards for the project. Invoke when user requests code generation, system design, refactoring, or module initialization."
---

# World-Class Architecture & Code Standard

## UE 5.7 Plugin Development Standards
**Official API Reference**: https://dev.epicgames.com/documentation/unreal-engine/API

### Architecture Rules
1. **Module Separation**:
   - Editor-only code must be wrapped in `WITH_EDITOR` macro
   - Runtime modules must not depend on editor-only modules
   - Core logic must be separated from UI implementation
2. **Performance Requirements**:
   - No synchronous I/O operations on GameThread
   - Use AssetRegistry for all asset scanning operations
   - Use FRunnable for long-running background tasks
   - No memory leaks in AssetScanner and JSON serializer modules
3. **Web Communication**:
   - Large JSON payloads must be parsed asynchronously
   - WebBrowser communication must use message passing pattern
   - No blocking operations on browser main thread

### C++ Code Standards
1. Follow UE 5.7 coding conventions strictly
2. Use C++17/C++20 features as supported by UE 5.7
3. All public APIs must have proper documentation
4. No raw pointer ownership transfers without explicit documentation
5. Use UE smart pointers (TSharedPtr, TUniquePtr) for memory management

## Web Frontend Development Standards
### Technology Stack
- Vite 8.x + React 18.x + TypeScript 5.x (strict mode)
- React Flow 11.x for topology graph rendering
- Zustand for state management
- TailwindCSS 4 + PostCSS for styling

### Code Standards
1. TypeScript strict mode must be enabled for all files
2. Large JSON parsing must use Web Worker or requestIdleCallback
3. Zustand store state changes must have 100% test coverage
4. Data parsing functions must have 100% branch test coverage
5. Follow React 18 best practices for concurrent mode compatibility

## Validation Requirements
- All code must pass static analysis before merging
- C++ code must pass Unreal Automation Framework tests
- Frontend code must pass Vitest and React Testing Library tests
- No performance regressions in core functionality
