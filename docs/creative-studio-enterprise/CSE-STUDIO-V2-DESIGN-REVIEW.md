# Creative Studio V2 — V1 postmortem and ALMA Aura design audit

> Historical V2 design record. V2 was subsequently rejected. The owner-authoritative
> V2 failure analysis, refreshed Aura audit, and V3 correction contract are in
> `CSE-STUDIO-V3-DESIGN-REVIEW.md`.

Date: 2026-07-25

Scope: owner-reviewable prototype only
Branch: `codex/cs-enterprise-studio-demo`

## Decision

V1 is rejected. It should not be defended or treated as an implementation baseline. Its deterministic edit-operation model remains useful, but the product architecture and presentation need replacement.

## Evidence reviewed

- Owner-supplied ElevenLabs editor reference at original resolution. It is used only to understand editor workflow anatomy.
- V1 authenticated Vercel preview at `/agent/creative-studio-demo`.
- V1 desktop, applied-plan, rollback, and 390 × 844 screenshots.
- V1 source:
  - `CreativeStudioEnterpriseDemo.tsx`
  - `CreativeStudioEnterpriseDemo.module.css`
  - `demo-operations.ts`
- ALMA source:
  - `src/app/globals.css`
  - `tailwind.config.ts`
  - `src/app/layout.tsx`
  - `src/lib/theme.ts`
  - `src/components/ui/index.tsx`
  - `src/components/ui-mobile/{Button,Card,Motion}.tsx`
  - `src/components/ambient/AmbientBackground.tsx`
  - `src/agent/components/creative-studio/StudioUi.tsx`
  - `src/agent/components/AgentBottomNav.tsx`
- Authenticated live ALMA Dashboard and Agent surfaces in the current owner theme.

## V1 visual and product postmortem

### 1. Information architecture

V1 opens directly inside a populated project editor. There is no Studio home, recent-work view, creation system, project state overview, review queue, reusable workflow entry, or operational context. “Back to projects” is a visual affordance without a real destination. The first screen therefore assumes a project has already been selected and removes the most important Studio decision layer.

### 2. Hierarchy

The live desktop rendered 48 buttons and only one heading at 2752 × 945. Most UI copy is 9–13px, so navigation, asset metadata, transport controls, track labels, status, and Agent operations compete at nearly the same visual weight. The canvas is physically large but visually weak; the right Agent list and bottom timeline carry more texture than the work itself.

There is no strong sequence of:

1. project identity and lifecycle;
2. current creative output;
3. edit context;
4. proposed action;
5. review or risk.

### 3. Composition

The fixed grid (`70px 284px minmax(480px, 1fr) 356px`) makes the interface read as four adjacent strips. The canvas, assets, timeline and Agent do not form one composition. The timeline consumes a large permanent band even when the owner is not editing timing. The right panel becomes a dense vertical document inside an already dense application shell.

At ultrawide width, the result is excessive dead stage space with undersized controls. At mobile, panels disappear into a bottom-tab arrangement rather than becoming intentionally composed task views.

### 4. Component quality

V1 relies on abstract text glyphs (`◇`, `◉`, `♫`, `▦`, `✦`, `↶`) as primary controls. Button sizes, corner radii, borders, typography and hover states are defined ad hoc across a 2,162-line CSS module. Many controls are visually too small for their importance, and cards often look like bordered rows rather than authored product components.

The visual vocabulary does not provide a clear primary/secondary/tertiary action system. “Export” looks complete even though it is disconnected; review acknowledgement looks like a generic checkbox block rather than a high-trust approval surface.

### 5. Theme fidelity

V1 bypasses ALMA’s theme system. It hard-codes:

- `#101311` application background;
- custom green-black panels;
- custom coral, teal, amber and violet accents;
- a Geist fallback that is not ALMA’s configured typography stack;
- fixed dark-mode-only foregrounds and focus colors.

It does not consume `--bg-*`, `--c-*`, `--border-*`, `--frost-*`, `--shadow-*`, the theme cookie, or accent presets. It therefore looks like a separate product embedded in ALMA rather than ALMA Studio.

### 6. Originality

The left tool rail, adjacent file panel, isolated center player, full-width bottom timeline and right Agent panel reproduce the supplied reference’s anatomy too literally. Even where colors differ, the silhouette and task grouping communicate “reference-product imitation” instead of an ALMA operating model.

V2 must preserve useful editing concepts while changing the product architecture, spatial rhythm, navigation model and component language.

### 7. Density and readability

Metadata and safety-critical distinctions are compressed into tiny pills and mono labels. The Agent plan contains the right information but is difficult to scan: safe local edits, paid generation and external publishing appear in one long list with insufficient grouping. The owner must read too much before understanding what can happen now.

### 8. Responsive behavior

The 390 × 844 version avoids document overflow, but it is a cropped editor rather than a purpose-built mobile workflow. It keeps a detailed multi-track timeline, tiny labels and a canvas-first layout while removing project/library context. Tablet has no distinct composition contract.

V2 needs three designed modes:

- desktop command center and full editor;
- tablet split workspace with drawers;
- mobile focused canvas/project view with explicit sheets.

### 9. Accessibility and interaction

V1 includes semantic buttons, tabs, a skip link and focus outlines, but semantic structure is thin relative to control count. Small text and targets weaken usability. Some disabled controls look merely inactive rather than explaining the missing permission or confirmation. Hover/focus behavior is not connected to ALMA’s shared interaction vocabulary.

### 10. Product completeness

V1 represents one editing session. It does not make brand isolation, recent projects, campaign workflows, saved models, reviews, publishing, performance, retention, worker health and cost control feel like one Creative Studio product. Feature parity exists mostly in documentation, not in the default experience.

## ALMA Aura design-system audit

### Foundation

| System | Exact ALMA source | V2 rule |
|---|---|---|
| Body typography | Inter, Noto Sans Bengali, Hind Siliguri | Use the configured `font-sans`; no alternate product font |
| Numeric/technical typography | JetBrains Mono via `--font-mono-nums` | Reserve for timecode, versions, IDs, cost and fingerprints |
| Primary accent | `--c-accent: 224 122 95` / `#E07A5F` | Coral drives primary action, active navigation and focus |
| Accent light/dim | `#F4A28C` / `#C45A3C` | Hover, selected borders and high-emphasis text |
| Primary ink | `#1a1a2e` light, near-white dark | Use `text-cream`; never hard-code editor text |
| Muted ink | `#94a3b8`, `#64748b` channels | Metadata and helper text only |
| Elevation backgrounds | `--bg-0 #FAF9F6`, `--bg-1 #FFF`, `--bg-2 #F8F7F4`, `--bg-3 #F3F2EF` | Build hierarchy with elevation, not unrelated hue shifts |
| Dark elevation | `#141418`, `#1C1C22`, `#232329`, `#2A2A31` | Automatic dark counterpart through tokens |
| Hairlines | 6%, 8%, 12% black in light; 8%, 10%, 16% white in dark | One-pixel separation; strong border only for selected/focus |
| Radius | 10px, 14px, 20px; standard cards 26px | 26px primary surfaces, 14–20px nested controls |
| Floating shadow | `0 14px 34px -14px ...` plus layered ambient shadow | Use selectively on primary cards/drawers |
| Frost | `--frost-surface`, 20px blur, 1.1 saturation | Header pods, command bar and drawers only |

### Aura background

ALMA’s ambient background is a fixed, theme-aware canvas over a restrained base wash. It contains blue, violet, magenta, pink and orange light, but it is an application atmosphere—not a license to place decorative gradients on every card.

V2 will:

- let the existing `AmbientBackground` show around and through translucent shell surfaces;
- use coral as the product/action accent;
- keep cards predominantly `bg-card`, `bg-card/80`, `bg-bg-1` or `bg-bg-2`;
- avoid purple/cyan “AI dashboard” cards, giant gradient ornaments and random glow borders.

### Typography hierarchy

ALMA defines:

- H1: 28px / 700 / tight;
- H2: 22px / 700;
- H3: 18px / 600;
- H4: 16px / 600;
- body: 14px / 1.5;
- caption: 11px with limited tracking.

V2 will not use 9px for primary metadata or navigation. Desktop editor density may use 11–12px for timecode and track metadata, but task labels and controls remain 13–15px.

### Surfaces and cards

The best existing ALMA pattern is a calm surface hierarchy:

- ambient Aura behind the page;
- translucent sticky/floating chrome;
- white or dark-token cards with 26px corners;
- subtle hairline border;
- layered `shadow-card` or `shadow-float`;
- coral left edge or border only for real emphasis.

Dashboard KPI cards show that status color can be a small edge signal rather than a full-card fill. The Agent composer shows that frost works best as a single functional surface, not repeated glass-card decoration.

### Controls

ALMA’s shared controls establish:

- pill buttons;
- 44px mobile targets;
- solid coral primary action;
- neutral/card secondary action;
- transparent tertiary action;
- `focus-visible:ring-2 focus-visible:ring-gold/40`;
- pressed scale around 0.97–0.98;
- disabled opacity plus explanatory text.

V2 will use repository-owned 24 × 24 SVG icons with approximately 1.8 stroke width, following `StudioUi.tsx` and `AgentBottomNav.tsx`. Emoji and typographic symbols will not be primary control icons.

### Motion

ALMA motion is restrained:

- 180ms fade + 8px entrance;
- 120–180ms hover/press transitions;
- 3px hover lift for interactive cards;
- transform/opacity only;
- all continuous or entrance motion disabled under `prefers-reduced-motion`.

V2 uses motion for focus changes, panel/sheet arrival and selection—not decorative looping.

### Theme and responsive rules

- Theme is applied server-side through `data-theme` and accent-channel variables.
- V2 must not force a theme or set its own color scheme.
- `html { overflow-x: clip; }` is the global last guard; the demo must still produce no document overflow itself.
- Inputs are at least 16px on mobile to prevent iOS focus zoom.
- Mobile controls are at least 44px.
- Internal horizontal scrollers are allowed only for timeline or compact create lanes and must not widen the document.

## V2 product architecture

### Level A — Studio Home / command center

The default route is an operational home, not a marketing page.

1. **Studio command bar**
   - return to Agent;
   - Studio identity;
   - active brand and isolation state;
   - global search;
   - theme-aware prototype status;
   - Creative Agent entry.
2. **Create dock**
   - Image;
   - Video / Reel;
   - Voice;
   - Audio / Music / SFX;
   - Campaign Pack;
   - Long-form.
3. **Work ledger**
   - recent and in-progress projects;
   - visual preview;
   - workflow type;
   - owner/collaborators;
   - review state;
   - progress and last activity;
   - direct open.
4. **Reusable systems**
   - templates;
   - recipes;
   - saved models;
   - campaign workflows;
   - asset/library/catalog entry.
5. **Studio pulse**
   - review queue;
   - dry-run/publishing state;
   - performance/attribution signal;
   - retention/archive;
   - worker/provider health;
   - cost and security gates.
6. **Creative Agent brief**
   - natural-language orchestration entry;
   - explicit “plan only” default;
   - selected brand/project context;
   - no paid or external execution.

### Level B — Project Editor

1. **Lifecycle bar**
   - real Home return;
   - brand/project/folder breadcrumb;
   - save/version/review state;
   - undo/redo;
   - prototype Share/Export with truthful disabled behavior.
2. **Media dock and asset context**
   - Image, Video, Voice, Audio and Library;
   - project/workspace scope;
   - selected asset;
   - source, model/recipe, QC and permission metadata.
3. **Stage**
   - professional neutral theatre inside the Aura shell;
   - aspect, fit, safe-area and QC controls;
   - player transport.
4. **Timeline**
   - video, captions, voice, music and SFX tracks;
   - selected clip;
   - split, playhead and zoom;
   - timecode in mono;
   - compact mode on mobile.
5. **Context panel**
   - Inspector, Creative Agent and Review as peer modes;
   - one selected-node model across stage, asset and timeline.
6. **Deterministic Agent**
   - instruction;
   - plan;
   - safe/blocked grouping;
   - fingerprint acknowledgement;
   - apply only three reversible ৳0 edits;
   - audit ID and new version;
   - rollback as a new audited version;
   - paid generation and external publish remain separately blocked.

## Originality guardrails

- Do not reproduce the reference product’s flat white four-column editor silhouette.
- Do not reproduce V1’s four full-height strips.
- Use ALMA’s command-center home and floating Aura surface hierarchy.
- Treat the editor as a focused mode entered from Home.
- Keep the deterministic command model; replace the visual/product shell.

## V2 acceptance checks

- Home is the default route and is useful before opening a project.
- Home → create/open → Editor → Home works.
- All primary controls use vector icons and accessible names.
- Light and dark follow ALMA tokens without duplicated palettes.
- Desktop, tablet and 390 × 844 are separately composed.
- No document horizontal overflow.
- Reduced-motion and keyboard focus are explicit.
- Provider generation, upload, export, publish and paid actions remain disconnected.
- Existing `/agent/creative-studio` is untouched.
