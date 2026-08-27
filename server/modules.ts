// server/modules.ts
//
// Static, declarative registry of known add-on modules. NOT filesystem- or
// runtime-discovered -- every module ships as reviewed code within this
// same codebase (see
// docs/superpowers/specs/2026-08-15-report-module-architecture-design.md
// for why: auto-loading unreviewed code in a multi-tenant process is a
// real security risk this design deliberately avoids). What varies per
// organization is only whether it's *entitled* to a given key, tracked in
// organization_modules.
//
// To add a real second module later: add an entry here, build its report
// renderer component, then grant it to a specific organization via
// scripts/grant-module.mjs. Nothing about this registry or the entitlement
// table needs to change to do that.

export interface ModuleDefinition {
  label: string;
  alwaysEnabled: boolean;
}

export const MODULE_REGISTRY: Record<string, ModuleDefinition> = {
  standard: {
    label: "Standard (GHG Protocol / ISO 14064-1)",
    alwaysEnabled: true,
  },
};

export function isKnownModuleKey(key: string): boolean {
  return key in MODULE_REGISTRY;
}
