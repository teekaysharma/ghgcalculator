# Intent: Build-Time Guardrail Hooks

**Originator:** teekaysharma@googlemail.com (product owner)
**Captured:** 2026-09-11
**Status:** Accepted — proceeded to Stage 2 (Design)

## Origin, in the originator's own words

Raised by quoting the Hooks row from the earlier Stage 3 correlation directly:

> "3. Build — Hooks	Build-time guardrails: block edits to protected paths, run formatters, catch
> credential leaks	Gap. Confirmed directly — no .claude/settings.json, no hooks configured
> anywhere in this project.
> now we need to build this part."

## Context at time of capture

Independent of the just-designed `.claude/skills/` work
(`docs/superpowers/specs/2026-09-11-claude-skills-design.md`) — per the playbook's own dependency
graph, "Hooks as build-time guardrails" has no prerequisite and can be designed/built on its own
track.

A significant redirect shaped how this design actually proceeded, worth recording as part of the
intent since it changed the method, not just the output: when first asked to pick specific
protected paths from a candidate list, the originator explicitly rejected that approach —

> "do a brainstorming to find out what should not be done at all. That is most important. Before
> you make a call on anything else, the methodology MUST be clear and unambiguous. Do not
> construct anything yet, do the brainstorming and report."

— which produced the four-category methodology in the resulting spec (record-of-a-past-event,
secret/no-clean-undo, named-boundary-crossing, would-it-impede-legitimate-work) as the actual
deliverable of that stage, applied afterward to reach specific paths, config, and mechanics —
rather than a candidate list picked ad hoc.

Separately, mid-design, a real consequence of an earlier decision (the full one-time repo-wide
Prettier reformat, chosen explicitly despite the line-number-staleness tradeoff flagged for it)
was escalated into a standing priority directive, tracked in
[`docs/superpowers/INDEX.md`](../INDEX.md)'s "Next priorities, in order" section rather than left
inside this spec alone.

## Disposition

Accepted. Proceeded to Stage 2 (Design) via `superpowers:brainstorming`. Resulting artifact:
[`docs/superpowers/specs/2026-09-11-build-hooks-design.md`](../specs/2026-09-11-build-hooks-design.md).
