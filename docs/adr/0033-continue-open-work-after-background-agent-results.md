---
status: accepted
---

# Continue open work after background Agent results

## Context

Pi Stuff's reviewed completion path records a UI-visible result without putting it in the main Agent's context or
requesting another turn. That can leave delegated work finished but its user's task unfinished. For delegated Agents,
background placement does not remove the main Agent's responsibility to receive outcomes and finish the open task.
The maintainer confirmed this product decision and the complete repair plan on 2026-09-06. The current repair candidate
implements the delivery path under `ps-8ew.3`; combined production acceptance remains pending.

## Decision

Automatically deliver bounded success, failure, and partial outcomes with retrievable canonical output references to
the originating main Agent. While the original task remains open, continue integration when idle and queue delivery
when busy. An idle main Agent or a nonterminal progress update does not discharge pending delegated work. Coordinate
delivery with Goal so the same outcome does not start competing continuations.

User-canceled or explicitly ended work must not restart because of a late result; retain the outcome for inspection.
Preserve Session/run identity and duplicate suppression. The implementation should reuse Host and upstream delivery
mechanisms where they meet this contract; this decision does not select an integration architecture or certify that
the current runtime already behaves this way.

## Consequences

The trade-off favors completing delegated user work over the existing notify-only policy. pi-subagents 0.65.1 requests
a main turn by default; Codex and Claude Code document result return and main-Agent integration. Their public evidence
does not establish identical idle scheduling or cancellation behavior, so those boundaries remain explicit local
requirements. See the versioned sources, local evidence, and acceptance targets in the
[repair plan](../research/pi-stuff-reliability-repair-plan-20260906.md).

This decision concerns delegated Agents. Agents retains lifecycle and protocol authority, while Context Management/Magic
owns child pressure projection and local estimate handling. ADR 0027 addresses Background Shell handoff; its distinction for explicitly
independent Shells is not evidence for a notify-only Agent policy. Review the relevant current Module contracts and
ADRs together when implementing this change, rather than silently extending either policy across capabilities.
