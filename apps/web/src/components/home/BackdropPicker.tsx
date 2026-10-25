/**
 * The top-right backdrop switcher: a single quiet button that opens a
 * small panel with three tabs — solid, gradient, image — and the choices
 * under each, plus, for a gradient or image, how it's laid out (a banner
 * across the top, or the full window). Homebase places it in its top-right corner, left of refresh;
 * the panel drops down below the button.
 */
import { Check, Palette, X } from 'lucide-react';
import { Popover } from '@base-ui-components/react/popover';
import { Radio } from '@base-ui-components/react/radio';
import { RadioGroup } from '@base-ui-components/react/radio-group';
import { Tabs } from '@base-ui-components/react/tabs';
import { useState } from 'react';
import { GLOWS, PAINTINGS, SHAPES, glowSwatch, paintingUrl, type Backdrop, type BackdropStyle, type ShapeId } from '../../lib/covers.ts';
import { GlowScene } from './GlowScene.tsx';

type Tab = Backdrop['kind'];

const LAYOUTS: { style: BackdropStyle; label: string }[] = [
  { style: 'banner', label: 'Banner' },
  { style: 'window', label: 'Full window' },
];

/** A swatch's selection ring; Base UI marks the chosen radio `data-checked`. */
const SWATCH_CLASS =
  'rounded-md ring-offset-2 ring-offset-chrome-bg transition-transform hover:scale-105 data-checked:ring-2 data-checked:ring-chrome-fg';

const TABS: { kind: Tab; label: string }[] = [
  { kind: 'solid', label: 'Solid' },
  { kind: 'glow', label: 'Gradient' },
  { kind: 'image', label: 'Image' },
];

export function BackdropPicker({
  value,
  onChange,
  layout,
  onLayoutChange,
}: {
  value: Backdrop;
  onChange: (b: Backdrop) => void;
  layout: BackdropStyle;
  onLayoutChange: (s: BackdropStyle) => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>(value.kind);
  // The shape survives switching gradients; previews use the current gradient (or the first).
  const shape: ShapeId = value.kind === 'glow' ? value.shape : 'none';
  const previewGlow = GLOWS.find((g) => value.kind === 'glow' && g.id === value.id) ?? GLOWS[0];

  return (
    <Popover.Root>
      <Popover.Trigger aria-label="Change backdrop" title="Change backdrop" className="chrome-icon-btn">
        <Palette size={16} strokeWidth={1.75} aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={8} className="z-50">
          <Popover.Popup aria-label="Backdrop" className="home-island flex w-72 flex-col gap-3 p-3 outline-hidden">
            <Tabs.Root
              value={tab}
              onValueChange={(next: Tab) => {
                setTab(next);
                if (next === 'solid') onChange({ kind: 'solid' });
              }}
              className="flex flex-col gap-3"
            >
              <div className="flex items-center gap-1">
                <Tabs.List aria-label="Backdrop kind" className="flex gap-1">
                  {TABS.map((t) => (
                    <Tabs.Tab
                      key={t.kind}
                      value={t.kind}
                      className="flex h-6 items-center rounded-md px-2.5 text-xs font-medium text-chrome-fg-muted transition-colors hover:bg-chrome-bg-hover hover:text-chrome-fg data-active:bg-chrome-bg-active data-active:text-chrome-fg"
                    >
                      {t.label}
                    </Tabs.Tab>
                  ))}
                </Tabs.List>
                <div className="flex-1" />
                <Popover.Close aria-label="Close" className="chrome-icon-btn size-6!">
                  <X size={13} strokeWidth={1.75} aria-hidden />
                </Popover.Close>
              </div>

              <Tabs.Panel value="solid">
                <p className="px-0.5 text-xs leading-snug text-chrome-fg-muted">Just the shell. Nothing behind the islands.</p>
              </Tabs.Panel>

              <Tabs.Panel value="glow" className="flex flex-col gap-3">
                <RadioGroup
                  aria-label="Gradient"
                  value={value.kind === 'glow' ? value.id : null}
                  onValueChange={(id) => onChange({ kind: 'glow', id: id as string, shape })}
                  className="grid grid-cols-6 gap-2"
                >
                  {GLOWS.map((g) => (
                    <Radio.Root
                      key={g.id}
                      value={g.id}
                      title={g.name}
                      aria-label={g.name}
                      className={`${SWATCH_CLASS} flex aspect-square items-center justify-center`}
                      style={{ background: glowSwatch(g) }}
                    >
                      <Radio.Indicator>
                        <Check size={13} strokeWidth={3} className="text-white drop-shadow" aria-hidden />
                      </Radio.Indicator>
                    </Radio.Root>
                  ))}
                </RadioGroup>

                {previewGlow !== undefined && (
                  <div className="flex flex-col gap-2">
                    <p className="px-0.5 text-micro font-medium text-chrome-fg-subtle">Shapes</p>
                    <RadioGroup
                      aria-label="Shape"
                      value={value.kind === 'glow' ? shape : null}
                      onValueChange={(id) => onChange({ kind: 'glow', id: previewGlow.id, shape: id as ShapeId })}
                      className="grid grid-cols-3 gap-2"
                    >
                      {SHAPES.map((s) => (
                        <Radio.Root
                          key={s.id}
                          value={s.id}
                          title={s.name}
                          className={`${SWATCH_CLASS} relative aspect-[4/3] overflow-hidden`}
                        >
                          <GlowScene glow={previewGlow} shape={s.id} />
                          <span className="absolute inset-x-0 bottom-0 bg-black/35 px-1 py-0.5 text-center text-micro font-medium text-white">
                            {s.name}
                          </span>
                        </Radio.Root>
                      ))}
                    </RadioGroup>
                  </div>
                )}
              </Tabs.Panel>

              <Tabs.Panel value="image" className="flex flex-col gap-3">
                <RadioGroup
                  aria-label="Painting"
                  value={value.kind === 'image' ? value.id : null}
                  onValueChange={(id) => onChange({ kind: 'image', id: id as string })}
                  className="grid grid-cols-4 gap-2"
                >
                  {PAINTINGS.map((p) => (
                    <Radio.Root
                      key={p.id}
                      value={p.id}
                      title={`${p.name} — ${p.artist}`}
                      aria-label={`${p.name} — ${p.artist}`}
                      className={`${SWATCH_CLASS} relative aspect-[4/3] overflow-hidden bg-chrome-bg-hover`}
                    >
                      <img src={paintingUrl(p, 'thumb')} alt="" loading="lazy" className="size-full object-cover" />
                      <Radio.Indicator className="absolute inset-0 flex items-center justify-center bg-black/30">
                        <Check size={14} strokeWidth={3} className="text-white" aria-hidden />
                      </Radio.Indicator>
                    </Radio.Root>
                  ))}
                </RadioGroup>

                {value.kind === 'image' && (
                  <p className="truncate px-0.5 text-micro text-chrome-fg-subtle">
                    {PAINTINGS.find((p) => p.id === value.id)?.name} · {PAINTINGS.find((p) => p.id === value.id)?.artist} · public domain
                  </p>
                )}
              </Tabs.Panel>
            </Tabs.Root>

            {tab !== 'solid' && (
              <div className="flex flex-col gap-2">
                <p className="px-0.5 text-micro font-medium text-chrome-fg-subtle">Layout</p>
                <RadioGroup
                  aria-label="Layout"
                  value={layout}
                  onValueChange={(style) => onLayoutChange(style as BackdropStyle)}
                  className="grid grid-cols-2 gap-1 rounded-md bg-chrome-bg-hover p-0.5"
                >
                  {LAYOUTS.map((l) => (
                    <Radio.Root
                      key={l.style}
                      value={l.style}
                      className="flex h-6 items-center justify-center rounded-[5px] text-xs font-medium text-chrome-fg-muted transition-colors hover:text-chrome-fg data-checked:bg-chrome-bg data-checked:text-chrome-fg data-checked:shadow-sm"
                    >
                      {l.label}
                    </Radio.Root>
                  ))}
                </RadioGroup>
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
