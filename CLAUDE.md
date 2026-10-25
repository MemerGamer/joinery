# Important rules
- don't write any new tests
- read `ARCHITECTURE.md` before changing the engine, git, agent runs or rendering; keep it current when an invariant changes

# Web UI (`apps/web`)
- Interactive elements use Base UI (`@base-ui-components/react`) directly. Use the matching part instead of hand-rolling one: Dialog, Popover, Menu, Select, Combobox, Tabs, RadioGroup, Checkbox, Switch, Toggle/ToggleGroup, NumberField, Input, Collapsible, Tooltip. Plain `<button>` is fine for a simple action.
- Reuse `components/controls.tsx` before writing new chrome:
  - `Segmented`/`Segment` for single-choice button rows
  - `MenuShell` and `Tick` for icon menus
  - `ChromeSwitch` for on/off settings
  - `MENU_POPUP_CLASS`, `LIST_POPUP_CLASS`, `POPUP_ITEM_CLASS` and `POPUP_LABEL_CLASS` for every popup list
- Never use the DOM `title` attribute. Wrap the element in `<Hint label=…>` instead; it shares app-wide timing through `HintProvider`. A hint is visual only, so icon-only controls still need an `aria-label`. A Menu or Select trigger under a `Hint` styles its open state with `aria-expanded:`, not `data-popup-open`.
- Style state with Base UI's data attributes (`data-checked`, `data-pressed`, `data-active`, `data-highlighted`, `data-starting-style`/`data-ending-style`). Guard hover with `not-data-*:hover:` so the selected item keeps its tint.
- Modal popups must keep `role="dialog"`, because `lib/keymapGuard.ts` relies on it to stop single-key shortcuts while a dialog is open. Don't `stopPropagation` on Escape inside a Base UI popup; that blocks its dismissal.
- There are no focus rings anywhere (see `styles/index.css`). Fields show focus with their own border.
- Icons are `lucide-react` only.
- Section headings and labels are sentence case, never `uppercase`.
- Check UI work with `bun run typecheck`; the full check is `bun run check`.
