# Intent: Activity-Data Document Extraction

**Originator:** teekaysharma@googlemail.com (product owner)
**Captured:** 2026-09-10 (written retroactively — this intent preceded the spec chronologically in conversation, but was never committed as its own artifact until now; see "Note on sequencing" below)
**Status:** Accepted — proceeded to Stage 2 (Design)

## Origin, in the originator's own words

First raised as a direct question, prompted by the still-undesigned emissions-*factors* upload
facility discussion:

> "is there a module in place that can automatically extract information from uploaded pdf or
> scanned files? or it has to be planned scoped and built?"

Confirmed via direct codebase inspection (no PDF-parsing library, no OCR library, no document-AI/
vision SDK, no file-upload middleware anywhere in the app) that no such module exists — this is a
from-scratch capability, not an extension of something partially built. That finding was reported
back, closing with an offer to think it through properly.

Accepted with:

> "yes do that"

## Context at time of capture

Distinct from, but adjacent to, the emissions-*factors* upload facility (EPA/EXIOBASE/IPCC
reference tables, superadmin-only, still undesigned-for-build as of this writing). This intent is
about extracting an organization's own **activity data** (kWh, fuel volume, billing period) from
its own source documents (utility bills, invoices) — used by ordinary tenant users on their own
source streams, not a superadmin-only tool.

## Disposition

Accepted. Proceeded to Stage 2 (Design) via `superpowers:brainstorming` — scope, review-gate,
entry-point, provider, and retention decisions made across that session. Resulting artifact:
[`docs/superpowers/specs/2026-09-10-document-extraction-design.md`](../specs/2026-09-10-document-extraction-design.md).

## Note on sequencing

This project is adopting Anthropic's AI-native SDLC playbook pattern
(`intent.md` → `spec.md` → `plan.md` → ...) starting 2026-09-10. This is the first `intent.md`
written under that convention. It was captured after its `spec.md` already existed, because the
practice started mid-flight on this exact piece of work — this file reconstructs the intent from
the conversation record rather than claiming it was captured in real time. Every intent captured
from this point forward will precede its spec, in order.
