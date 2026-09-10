# Intent: Project-Specific `.claude/skills/`

**Originator:** teekaysharma@googlemail.com (product owner)
**Captured:** 2026-09-11
**Status:** Accepted — proceeded to Stage 2 (Design)

## Origin, in the originator's own words

Raised directly after confirming the logical sequence per the AI-native SDLC playbook (Skills is
the other named prerequisite for PR review, alongside the now-committed `CLAUDE.md`):

> "I refer to this. For this particular project, we need to have really specific stuff.
> Brainstorm it and then tell me."

"This" refers to the previously-identified gap: `docs/superpowers/INDEX.md`'s Stage 3 correlation
row — "`.claude/skills/` (project-specific policy skills — security standards, API conventions,
organizationId-scoping rule, idempotent-migration pattern, two-step destructive-DB-op rule) —
Not started."

## Context at time of capture

The generic `superpowers` plugin skills already in use (`brainstorming`, `writing-plans`,
`subagent-driven-development`) are process methodology, not this project's own codified
engineering/domain policies. Several real, consistently-followed conventions in this codebase
exist only as code comments, `CLAUDE.md` prose, or session memory — never as a structured,
discoverable skill file a fresh session or agent could find and apply without having lived through
the incidents that produced each rule.

## Disposition

Accepted. Proceeded to Stage 2 (Design) via `superpowers:brainstorming` — settled on three
focused skills (`database-conventions`, `ghg-domain-conventions`, `api-conventions`) rather than
one monolith or a fourth dedicated security skill, and on trimming `CLAUDE.md`'s existing
"Stack and architecture rules" bullets to one-liners with pointers once the skills exist, rather
than maintaining the same rules in two places. Resulting artifact:
[`docs/superpowers/specs/2026-09-11-claude-skills-design.md`](../specs/2026-09-11-claude-skills-design.md).
