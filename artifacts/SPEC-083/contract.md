# SPEC-083 — Contract (tool-map.ts, v1.0.0)
- `toolsForCapability(key): ToolManifest[]` (resolved from G08 loader)
- `capabilitiesForTool(toolName): string[]` (reverse index)
- `checkToolMapping(c) / checkAllToolMappings(set): ToolMapIssue[]` —
  MISSING_TOOL (phantom tool) | DUPLICATE_ROUTING | UNCOVERED_TOOL
- `coverage(set): CoverageReport{ totalTools, routedTools, uncovered[], duplicated[] }`
- Boundary `queryToolMap(raw): ComponentResult` — toolsFor|capsFor|coverage;
  identity-enforced; never throws.
