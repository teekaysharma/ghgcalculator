# ISIC Rev.4 division -> EAD primary_activity_types mapping

Written 2026-08-07. Not wired into any code yet. This is a reference document for
whoever builds the EAD-template-fill export feature (still open per
UI-PLAN-2026-08-03.md) -- at that point, a facility's `isicDivisionId` will need
to resolve to one of the 8 legal values in `primary_activity_types` so the
export can write a value the official template's own dropdown validation
will actually accept.

## Why this exists

`facility_identifiers.primaryActivityTypeId` (8 values, sourced verbatim from
the EAD Deliverable C template's own "4k - Reference Lists" sheet) is no
longer the user-facing "Primary activity" picker -- as of 2026-08-07 that's
been replaced with a two-level ISIC Rev.4 section/division picker
(`isicDivisionId`), because the 8-item EAD list is far too narrow for a
general client base outside EU-ETS-benchmarked heavy industry. Both columns
still exist on `facility_identifiers`; `primaryActivityTypeId` is currently
unpopulated by the UI and only meaningful again once something (export logic,
or a user override) sets it.

## The mapping is NOT 1:1 and should not be treated as settled

At ISIC division-level granularity (2-digit codes, the level this app's
picker uses), several EAD categories collapse into a single ISIC division.
Division-level is too coarse to separate them; the group level (3-digit)
would, but that's a different granularity than what was chosen for the
picker (see UI-PLAN-2026-08-03.md and this session's granularity decision).
Where that collapse happens, it's flagged AMBIGUOUS below and should not be
auto-resolved silently -- either prompt the user/verifier to pick manually
at export time, or require a human-confirmed override before an EAD export
can proceed for that facility.

| EAD `primary_activity_types` value | Best-match ISIC Rev.4 division(s) | Confidence |
|---|---|---|
| Combustion of fuels | 35 -- Electricity, gas, steam and air conditioning supply | Weak. EAD's "combustion of fuels" category is meant to cover any large combustion installation, not just power-sector generation. Division 35 only captures the power/utility case. A facility in, say, division 10 (food manufacturing) with a large industrial boiler would also arguably need this EAD category but won't map here. Treat this row as "catches the power-sector case only," not a general rule. |
| Production of coke | 19 -- Manufacture of coke and refined petroleum products | Weak. Division 19 covers coke production AND petroleum refining together; EAD's category is coke-only. A facility in division 19 could be a refinery with no coke production at all. |
| Metal ore roasting or sintering | 07 -- Mining of metal ores | Weak / questionable. EAD's category is a beneficiation/pretreatment process (roasting, sintering ore into pellets for blast-furnace feed), which is a different activity from mining/extraction (ISIC 07). Sintering is arguably closer to division 24 (basic metals manufacture) in practice. Flagging this as the weakest match in the table -- worth a second opinion from someone who knows the EAD Technical Guidance clause text, which has not been read in this project (see shared/schema.ts's own verification-status comment on the facility-level MRV layer). |
| Production of iron or steel | 24 -- Manufacture of basic metals | **AMBIGUOUS.** Division 24 covers both ferrous (iron/steel) and non-ferrous (including aluminium) basic metal manufacture. Division-level data alone cannot tell you which one a facility is. Needs the 3-digit group (241/243 = iron and steel casting, vs 242 = precious and other non-ferrous metals) or a manual pick. |
| Production of aluminium | 24 -- Manufacture of basic metals | **AMBIGUOUS**, same division as iron/steel above, same caveat. |
| Production of cement clinker | 23 -- Manufacture of other non-metallic mineral products | **AMBIGUOUS.** Division 23 covers both cement (group 239, class 2394) and glass (group 231) manufacture together. Needs the 3-digit group or a manual pick. |
| Production of glass | 23 -- Manufacture of other non-metallic mineral products | **AMBIGUOUS**, same division as cement clinker above, same caveat. |
| Other | everything else | This is the correct default for the ~80 divisions with no plausible EAD benchmark-category match -- most of ISIC (services, agriculture, trade, most manufacturing categories) legitimately has no EU-ETS product benchmark and "Other" is the right answer, not a gap. |

## Recommendation for whoever builds the export feature

Do not auto-write a resolved `primaryActivityTypeId` from `isicDivisionId`
without a human confirmation step, at minimum for divisions 07, 19, 23, 24,
and 35 (the only divisions with any candidate mapping at all). For every
other division, "Other" is a safe, confident default. This keeps the
project's own emission-factor/classification sourcing-hierarchy discipline
(never silently substitute a lower-confidence value -- flag it) applied
here too, even though this isn't an emission-factor field.