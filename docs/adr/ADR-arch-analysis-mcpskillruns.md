# ADR-arch-analysis-mcpskillruns: Architecture Analysis of mcp, skill, and runs Directories

## Summary

Architecture analysis of the mcp, skill, and runs directories to identify architectural friction and shallow modules using codebase-design principles.

## Problem Statement

The mcp, skill, and runs directories contain architectural friction and shallow modules that limit maintainability, testability, and extensibility. Several modules have interfaces that match their implementation complexity rather than providing leverage through hidden behavior.

## Context

The analyzed codebase follows a harness-based architecture with clear separation between the agent harness and its capabilities:

- **Harness**: packaging of coding-agent CLI
- **Agent**: pairing of harness with model config
- **Provider**: model endpoint definition
- **Sidecar**: auxiliary container for runs
- **MCP server**: capability via Model Context Protocol

### Current State Analysis

#### 1. MCP Module (`src/mcp/index.ts`) - SHALLOW

**Issues:**

- Mixed responsibilities: parsing + validation + derivation + rendering
- Transport coupling: container and remote logic intertwined
- Complex interface: multiple export types, validation functions embedded
- Validation logic mixed with business logic

**Current Component Tree:**

```
interface McpServerBase { name: string; requiredEnv: string[] }
├── ContainerMcpServer (transport: 'container')
├── RemoteMcpServer (transport: 'remote')
├── parseMcpServer() - parsing + validation
├── planMcpSelection() - port allocation + endpoints
├── isStringArray() - validation
└── isStringRecord() - validation
```

#### 2. Skill Module (`src/skill/index.ts`) - DEEP

**Strengths:**

- Thin edge pattern: imports paths FROM store, never reverse
- Clear seam: skill-specific concerns concentrated
- Hidden complexity: file system operations abstracted behind small interface

**Interface:**

```typescript
interface SkillModule {
  resolveSkill(name: string, root?: string): string;
  listSkillNames(root?: string): string[];
}
```

#### 3. Runs Module (`src/runs/runSpawn.ts`) - MIXED/NEEDS EXTRACTION

**Issues:**

- Single module handles 7+ concerns
- Poor locality: related concerns scattered
- Complex dependencies: circular import potential
- Interface too wide for single responsibility

**Current Component Tree:**

```
export async function runSpawn(deps, params) {
├── Network Management (creation/removal)
├── Sidecar Orchestration (start/stop/ready)
├── Git Operations (worktree, commit, push)
├── Container Execution (runtime.run)
├── PR/MR Management (create/open)
├── Resource Cleanup (temp files/directories)
├── Branch Naming (collision-safe counters)
└── Error Handling & Results
```

## Decision

Extract the Runs module into focused, deep modules following the Single Responsibility Principle. Each module should have a clear interface with significant hidden behavior.

### Strategy

1. **Separate concerns** into individual modules
2. **Maintain interfaces** as thin edges over implementation
3. **Create clean seams** between modules
4. **Preserve existing functionality** while improving architecture

### Implementation

The following modules were extracted from `runSpawn.ts`:

1. **runNetworks.ts** - Network management
2. **runSidecarOrchestrator.ts** - Sidecar orchestration
3. **runGit.ts** - Git operations
4. **runPrManager.ts** - PR/MR management and resource cleanup
5. **runBranchNamer.ts** - Branch naming
6. **runLogCapture.ts** - Egress log capture
7. **runContainerExecution.ts** - Container execution
8. **runWorktree.ts** - Worktree management
9. **runResult.ts** - Result management
10. **runOrchestrator.ts** - Main orchestration

Each module follows the codebase-design principles:

- **Module**: clear interface and implementation
- **Interface**: small, focused contract
- **Depth**: large behavior behind small interface
- **Seam**: clean boundary for alteration
- **Adapter**: concrete implementation of interface
- **Leverage**: caller benefits from depth
- **Locality**: maintainer benefits from depth

## Rationale

### Why This Decision?

1. **Single Responsibility Principle Violation**: The original `runSpawn.ts` module handled too many concerns
2. **Poor Testability**: Mixed responsibilities make unit testing difficult
3. **Maintainability Issues**: Changes to one concern risk affecting others
4. **Limited Extensibility**: Adding new capabilities requires modifying core orchestration
5. **Hidden Complexity**: Some modules had significant implementation complexity behind simple interfaces

### Benefits of the New Architecture

1. **Improved Testability**: Each module can be tested independently
2. **Better Maintainability**: Changes are localized to specific concerns
3. **Enhanced Extensibility**: New capabilities can be added as separate modules
4. **Clear Interfaces**: Small, focused interfaces reduce cognitive load
5. **Cleaner Dependencies**: Well-defined seams between modules

## Implementation Details

### Interface Design Principles

- Each module provides a minimal interface that hides complex implementation details
- Interfaces are focused on one specific responsibility
- Module boundaries are clear and well-documented

### Module Responsibilities

| Module                 | Primary Responsibility                     | Interface Complexity | Implementation Depth |
| ---------------------- | ------------------------------------------ | -------------------- | -------------------- |
| runNetworks            | Network creation/removal                   | Simple               | Complex              |
| runSidecarOrchestrator | Sidecar lifecycle management               | Medium               | Complex              |
| runGit                 | Git operations coordination                | Simple               | Complex              |
| runPrManager           | PR/MR management and resource cleanup      | Medium               | Complex              |
| runBranchNamer         | Run branch naming and collision resolution | Simple               | Complex              |
| runLogCapture          | Egress log capture and storage             | Simple               | Complex              |
| runContainerExecution  | Container execution orchestration          | Simple               | Complex              |
| runWorktree            | Worktree lifecycle management              | Simple               | Complex              |
| runResult              | Run result aggregation and error handling  | Simple               | Complex              |
| runOrchestrator        | High-level run coordination                | Medium               | Medium               |

### Migration Strategy

1. **Extract**: Move functionality from `runSpawn.ts` to individual modules
2. **Adapt**: Create module implementations that satisfy the new interfaces
3. **Integrate**: Update `runSpawn.ts` to use extracted modules
4. **Test**: Ensure all existing functionality is preserved
5. **Iterate**: Refine interfaces and implementations based on usage

## Files Created

- `src/runs/runNetworks.ts` - Network management module
- `src/runs/runSidecarOrchestrator.ts` - Sidecar orchestration module
- `src/runs/runGit.ts` - Git operations module
- `src/runs/runPrManager.ts` - PR/MR management and resource cleanup
- `src/runs/runBranchNamer.ts` - Branch naming module
- `src/runs/runLogCapture.ts` - Log capture module
- `src/runs/runContainerExecution.ts` - Container execution module
- `src/runs/runWorktree.ts` - Worktree management module
- `src/runs/runResult.ts` - Result management module
- `src/runs/runOrchestrator.ts` - Main orchestration module

## Testing Considerations

### Unit Testing

- Each extracted module can be unit tested independently
- Mock implementations available for testing
- Clear interfaces make dependency injection easier

### Integration Testing

- Test module interactions through well-defined interfaces
- Ensure orchestration logic works correctly
- Verify end-to-end functionality is preserved

### Test Structure

```
// Example unit test structure
import { InMemoryNetworkManager } from './runNetworks.js';

describe('NetworkManager', () => {
  let manager: NetworkManager;

  beforeEach(() => {
    manager = new InMemoryNetworkManager();
  });

  describe('createNetwork', () => {
    it('should create a network', async () => {
      await manager.createNetwork('test-network');
      expect(await manager.networkExists('test-network')).toBe(true);
    });
  });
});
```

## Dependencies

### Positive Dependencies

- **Reduced Coupling**: Modules have focused, single responsibilities
- **Clear Boundaries**: Well-defined interfaces between modules
- **Testability**: Each module can be tested in isolation

### Potential Drawbacks

- **Initial Development Cost**: More files to manage and coordinate
- **Runtime Overhead**: Slightly more complex module initialization
- **Interface Refinement**: Need to iterate on interfaces based on usage

## Rollback Plan

If this architectural change proves problematic:

1. **Revert to Original**: Restore `runSpawn.ts` to its original state
2. **Consolidate**: Gradually merge extracted modules back into `runSpawn.ts`
3. **Interface Migration**: Merge interfaces back into single module
4. **Functionality Preservation**: Ensure all features continue to work

## Related Work

This ADR aligns with the following codebase-design principles:

1. **Module Design**: Focus on creating modules with clear interfaces
2. **Depth and Leverage**: Design modules with significant hidden behavior
3. **Seam Design**: Create clear boundaries between components
4. **Adapter Pattern**: Provide concrete implementations of interfaces

## References

- [Codebase Design Skill Documentation](docs/skills/codebase-design.md)
- [Project Context](CONTEXT.md)
- [Existing Module Patterns](src/mcp/index.ts, src/skill/index.ts)

## Decision Log

| Date       | Change           | Description                                           |
| ---------- | ---------------- | ----------------------------------------------------- |
| 2025-06-17 | Initial Analysis | Identified shallow modules and architectural friction |
| 2025-06-17 | Design           | Created extraction strategy and module interfaces     |
| 2025-06-17 | Implementation   | Created all extracted modules                         |
| 2025-06-17 | Integration      | Refactored runSpawn.ts to use extracted modules       |
| 2025-06-17 | Testing          | Verified functionality and updated tests              |

## Conclusion

This architectural extraction successfully addresses the identified issues while maintaining backward compatibility. The new module structure improves testability, maintainability, and extensibility while preserving all existing functionality.

The extraction provides a foundation for future enhancements by creating clean boundaries and focused modules that can be developed and maintained independently.
