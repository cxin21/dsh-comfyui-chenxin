# Task 8 report — final review fixes + closeout

## Fix wave (commit 91c1196)
- MF-1: submitProposal stores normalizeTag() of both endpoints (underscore round-trip test + integration test: submit blue_hair → accept → searchCatalog('blue hair') surfaces overlay alias)
- MF-2: overlayStatus() probes overlayLibraryPath() (unified with relations.ts write path); dead defaultOverlayPath deleted; existing unavailable tests pass via setOverlayPath override
- Evidence: full suite 456/456 (56 files), build exit 0; scoped re-review ADDRESSED both findings independently re-verified against live source

## Residual fix (commit be3aff8 — earlier, prior plan wave)
- (documented separately in this file if present; this section covers 91c1196 wave only)
