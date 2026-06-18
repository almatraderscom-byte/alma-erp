# ui-mobile — shared mobile design system

The **floor** for every screen in Alma ERP + the agent. Build pages out of these
parts instead of re-solving zoom / keyboard / safe-area / touch-targets per page.
Palette is fixed (`#FAF9F6` cream + coral brand tokens) — these primitives change
**layout/behavior only**, never colors.

```ts
import { MobileScreen, Container, Button, Field, Input, Card, DataList, SheetModal } from '@/components/ui-mobile'
```

## The three app-wide bugs this fixes

1. **iOS auto-zoom on input focus** — iOS zooms when a focused control's
   font-size is `< 16px`. Fixed globally, not by disabling pinch-zoom:
   - `globals.css` forces `input, select, textarea { font-size: 16px }` on touch
     devices (`@media (hover: none) and (pointer: coarse)`) **and** at the mobile
     width breakpoint.
   - The `<Input>` / `<Textarea>` / `<Select>` here render at `16px` by design.
   - Viewport: ERP (`src/app/layout.tsx`) and agent (`src/app/agent/layout.tsx`)
     both use `viewportFit: 'cover'` + locked scale. The agent layout
     additionally omits `interactiveWidget` on purpose (it drives `--kb-inset`
     itself; see below).

2. **Input hidden behind the keyboard** — `capacitor.config.ts` sets
   `Keyboard.resize: None`, so **the app owns keyboard layout**. A single
   `<GlobalKeyboardManager>` (mounted once in the root layout) writes the live
   keyboard height to `--kb-inset` on `<html>` and toggles `body.kb-open`.
   Any footer that needs to clear the keyboard uses
   `padding-bottom: max(var(--kb-inset), env(safe-area-inset-bottom))`.
   `<KeyboardAwareFooter>`, `<MobileScreen footer>` and `<SheetModal footer>`
   all do this for you.

3. **Inconsistent scale / cramped tables / tiny tap targets** — every control
   here is `≥ 44px` (Apple's minimum touch target), spacing is shared, and
   `<DataList>` renders real tables on wide screens but **stacked cards on
   phones** so desktop tables are never squeezed onto a phone.

## Primitives

| Component | Use it for |
|---|---|
| `<MobileScreen header footer>` | The screen scaffold: safe-area header, scroll body, keyboard-aware footer. Every page lives inside one. |
| `<Container size>` | Max-width + consistent horizontal gutters. |
| `<Button variant size fullWidth>` | The tappable button. `≥44px`, pressed state. Variants: `primary` (coral) · `secondary` · `ghost` · `danger`. |
| `<Field>` + `<Input>` / `<Textarea>` / `<Select>` / `<LabelledInput>` | Form controls. `16px` (no auto-zoom), label, error/hint. |
| `<Card>` + `<CardHeader>` | The standard surface. `accent` for a coral border. |
| `<DataList columns rows rowKey>` | Table → card responsive list. |
| `<SheetModal open onClose title footer>` | Bottom-sheet modal; safe-area + keyboard aware. |
| `<KeyboardAwareFooter>` | Standalone sticky footer that stays above the keyboard. |
| `useKeyboardInset()` | Low-level hook behind `<GlobalKeyboardManager>`. You normally don't need it directly. |

## Patterns

### A full screen with a form

```tsx
<MobileScreen
  header={<PageHeader title="New Order" />}
  footer={<Button fullWidth type="submit" form="order-form">Save</Button>}
>
  <Container>
    <form id="order-form" className="flex flex-col gap-4 py-4">
      <LabelledInput label="Customer" required />
      <Field label="Amount"><Input inputMode="numeric" /></Field>
    </form>
  </Container>
</MobileScreen>
```

### A responsive list

```tsx
<DataList
  rows={orders}
  rowKey={(o) => o.id}
  onRowClick={(o) => router.push(`/orders/${o.id}`)}
  renderCardTitle={(o) => o.customerName}
  columns={[
    { key: 'id', header: 'Order' , render: (o) => o.code },
    { key: 'amt', header: 'Amount', align: 'right', render: (o) => <Money value={o.total} /> },
    { key: 'status', header: 'Status', render: (o) => <StatusBadge status={o.status} /> },
  ]}
/>
```

### A bottom sheet

```tsx
<SheetModal open={open} onClose={close} title="Filters" footer={<Button fullWidth onClick={apply}>Apply</Button>}>
  <Field label="Status"><Select>…</Select></Field>
</SheetModal>
```

## Rules

- **Don't fix zoom / keyboard / safe-area per page.** Use these parts so it's
  fixed once. If a screen needs a bottom input, wrap it in `<KeyboardAwareFooter>`
  (or `<MobileScreen footer>`), never hand-roll `--kb-inset`.
- **Never change the palette.** Use the Tailwind brand tokens (`gold`, `gold-dim`,
  `cream`, `bg-0..3`, `card`, `border`) — no raw hex.
- This is separate from the older `@/components/ui` set. New mobile screens
  should prefer `ui-mobile`; the legacy `ui` exports remain for existing pages.

## Relationship to the agent

The agent has its own `src/agent/hooks/useKeyboardInset.ts` because of the
one-way dependency rule (ERP code must never import from `src/agent/`). Both
write the **same** `--kb-inset` value, so they never conflict — on an agent
route the writes are simply idempotent.
