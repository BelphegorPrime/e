# 35 - Documentation: explain e/pi relationship and agent usage

**Status:** Done (closed 2026-09-07).

**GitHub:** [#49](https://github.com/BelphegorPrime/e/issues/49)

---

## Problem

The current documentation explains how to build and run `e`, but it does not sufficiently explain the intended relationship between `e` and `pi`, nor how an AI agent is expected to use `e` as part of a multi-agent workflow.

The repository currently describes `e` as a coding-agent harness runner and lists `pi` alongside other supported harnesses, but the documentation should make the intended architecture and workflow much clearer.

In particular, an AI agent discovering this repository should be able to understand:

- `pi` is the main/underlying agent harness.
- `e` is the orchestration layer around the harness.
- `e spawn` is the mechanism for delegating work to agents.
- Spawned agents should also have access to `e`.
- Agents can therefore recursively spawn additional agents.

## Scope

### 1. Update `README.md`

Expand the README with a concise conceptual introduction explaining the relationship between `e` and `pi`.

The documentation should make the following model explicit:

```text
User
  │
  ▼
pi
  │
  ▼
e
  │
  ├── Agent A
  │     ├── Agent A.1
  │     └── Agent A.2
  │
  ├── Agent B
  │
  └── Agent C
```

The README should also explain the origin of the name `e` and its relationship to the `pi` harness.

Keep the existing build/setup documentation, but add enough context that a new user or AI agent understands _why_ `e` exists before diving into the implementation details.

### 2. Add dedicated documentation for AI agents

Add a document under `docs/agents/`, for example:

```text
docs/agents/e.md
```

The document should be written specifically for an AI agent that is running inside a project and needs to understand how to use `e`.

It should cover:

- What `e` is
- What `pi` is
- The relationship between `e` and `pi`
- How to determine whether `e` is available
- How to invoke `e`
- `e spawn`
- Delegating work to another agent
- How spawned agents receive their task/context
- How results are returned to the parent agent
- Recursive agent spawning

Example:

```bash
e spawn researcher "Investigate the authentication implementation"
```

### 3. Make recursive spawning explicit

A spawned agent must also have access to `e`.

For example:

```text
Main Agent
└── e spawn researcher
    ├── e spawn web-researcher
    ├── e spawn code-researcher
    └── e spawn documentation-researcher
```

The documentation should explicitly state that `e spawn` is not intended to be limited to a single parent → child level.

An agent spawned by `e` should be able to use:

```bash
e spawn ...
```

itself, subject to whatever resource/security limits the implementation provides.

### 4. Document the agent contract

Document what a spawned agent can expect to have available.

At minimum, clarify:

- Working directory / worktree
- Relevant environment
- Agent instructions
- Model/provider configuration
- Available tools
- `e` CLI
- Permissions
- Parent task/context
- Result/reporting mechanism

This should give agents enough information to make correct decisions about when and how to delegate work.

### 5. Document common delegation patterns

Add examples for common multi-agent workflows.

For example:

```text
Lead Agent
├── Architect
├── Backend Developer
├── Frontend Developer
├── Test Engineer
└── Reviewer
```

and recursive delegation:

```text
Lead Agent
└── Research Agent
    ├── API Researcher
    ├── Codebase Researcher
    └── Documentation Researcher
```

The documentation should encourage parallel delegation where tasks are independent.

### 6. Update agent entry-point documentation

Ensure the new documentation is discoverable from the existing agent instructions/documentation, including `AGENTS.md` and the existing agent-related documentation.

An AI agent should not have to know the location of `docs/agents/e.md` in advance.

## Tasks

- [ ] Update `README.md` with the conceptual `e`/`pi` architecture
- [ ] Document the meaning/origin of the `e` name
- [ ] Add `docs/agents/e.md` (or equivalent)
- [ ] Document `e` discovery and invocation for AI agents
- [ ] Document `e spawn`
- [ ] Document recursive spawning
- [ ] Ensure spawned agents have access to `e`
- [ ] Document the context/environment available to spawned agents
- [ ] Document parent/child result flow
- [ ] Add multi-agent workflow examples
- [ ] Link the new documentation from `AGENTS.md` / existing agent documentation
- [ ] Add/update tests if changes are required to ensure `e` is available inside spawned agent environments

## Acceptance criteria

A newly spawned AI agent reading the repository documentation should be able to answer:

1. What is `pi`?
2. What is `e`?
3. How are `e` and `pi` related?
4. How do I invoke `e`?
5. How do I spawn another agent?
6. Can a spawned agent spawn another agent?
7. How does context flow between parent and child agents?
8. How do I report the result of delegated work?

A simple recursive workflow should be possible:

```text
Agent A
  │
  └── e spawn Agent B
          │
          └── e spawn Agent C
```

without requiring Agent B to manually install or configure `e`.

## Notes

The existing README already documents `e spawn <agent-or-harness> "<prompt>"` and the `e init`/agent-store model, so this issue should primarily improve the conceptual and agent-facing documentation rather than replace the existing CLI reference.

## Blocked by

- (none)
