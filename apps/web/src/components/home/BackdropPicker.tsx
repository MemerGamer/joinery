/**
 * The bottom-right backdrop switcher: a single quiet button that opens a
 * small panel with three tabs — solid, gradient, image — and the choices
 * under each. Lives in the shell's corner on both Homebase and Explore.
 */
import { Check, Palette, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { GLOWS, PAINTINGS, SHAPES, glowSwatch, paintingUrl, type Backdrop, type ShapeId } from '../../lib/covers.ts';
import { GlowScene } from './GlowScene.tsx';

type Tab = Backdrop['kind'];

const TABS: { kind: Tab; label: string }[] = [
  { kind: 'solid', label: 'Solid' },
  { kind: 'glow', label: 'Gradient' },
  { kind: 'image', label: 'Image' },
];

export function BackdropPicker({ value, onChange }: { value: Backdrop; onChange: (b: Backdrop) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>(value.kind);
  const ref = useRef<HTMLDivElement>(null);
  // The shape survives switching gradients; previews use the current gradient (or the first).
  const shape: ShapeId = value.kind === 'glow' ? value.shape : 'none';
  const previewGlow = GLOWS.find((g) => value.kind === 'glow' && g.id === value.id) ?? GLOWS[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="absolute right-4 bottom-4 z-20 flex flex-col items-end gap-2">
      {open && (
        <div className="home-island flex w-72 flex-col gap-3 p-3" role="dialog" aria-label="Backdrop">
          <div className="flex items-center gap-1">
            <div role="tablist" aria-label="Backdrop kind" className="flex gap-1">
              {TABS.map((t) => (
                <button
                  key={t.kind}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.kind}
                  onClick={() => {
                    setTab(t.kind);
                    if (t.kind === 'solid') onChange({ kind: 'solid' });
                  }}
                  className={`flex h-6 items-center rounded-md px-2.5 text-xs font-medium transition-colors ${
                    tab === t.kind ? 'bg-chrome-bg-active text-chrome-fg' : 'text-chrome-fg-muted hover:bg-chrome-bg-hover hover:text-chrome-fg'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="flex-1" />
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="chrome-icon-btn size-6!">
              <X size={13} strokeWidth={1.75} aria-hidden />
            </button>
          </div>

          {tab === 'solid' && (
            <p className="px-0.5 text-xs leading-snug text-chrome-fg-muted">Just the shell. Nothing behind the islands.</p>
          )}

          {tab === 'glow' && (
            <div role="radiogroup" aria-label="Gradient" className="grid grid-cols-6 gap-2">
              {GLOWS.map((g) => {
                const selected = value.kind === 'glow' && value.id === g.id;
                return (
                  <button
                    key={g.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    title={g.name}
                    onClick={() => onChange({ kind: 'glow', id: g.id, shape })}
                    className={`flex aspect-square items-center justify-center rounded-md ring-offset-2 ring-offset-chrome-bg transition-transform hover:scale-105 ${
                      selected ? 'ring-2 ring-chrome-fg' : ''
                    }`}
                    style={{ background: glowSwatch(g) }}
                  >
                    {selected && <Check size={13} strokeWidth={3} className="text-white drop-shadow" aria-hidden />}
                  </button>
                );
              })}
            </div>
          )}

          {tab === 'glow' && previewGlow !== undefined && (
            <div className="flex flex-col gap-2">
              <p className="px-0.5 text-micro font-medium text-chrome-fg-subtle">Shapes</p>
              <div role="radiogroup" aria-label="Shape" className="grid grid-cols-3 gap-2">
                {SHAPES.map((s) => {
                  const selected = value.kind === 'glow' && shape === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      title={s.name}
                      onClick={() => onChange({ kind: 'glow', id: previewGlow.id, shape: s.id })}
                      className={`relative aspect-[4/3] overflow-hidden rounded-md ring-offset-2 ring-offset-chrome-bg transition-transform hover:scale-105 ${
                        selected ? 'ring-2 ring-chrome-fg' : ''
                      }`}
                    >
                      <GlowScene glow={previewGlow} shape={s.id} />
                      <span className="absolute inset-x-0 bottom-0 bg-black/35 px-1 py-0.5 text-center text-micro font-medium text-white">
                        {s.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {tab === 'image' && (
            <div role="radiogroup" aria-label="Painting" className="grid grid-cols-4 gap-2">
              {PAINTINGS.map((p) => {
                const selected = value.kind === 'image' && value.id === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    title={`${p.name} — ${p.artist}`}
                    onClick={() => onChange({ kind: 'image', id: p.id })}
                    className={`relative aspect-[4/3] overflow-hidden rounded-md bg-chrome-bg-hover ring-offset-2 ring-offset-chrome-bg transition-transform hover:scale-105 ${
                      selected ? 'ring-2 ring-chrome-fg' : ''
                    }`}
                  >
                    <img src={paintingUrl(p, 'thumb')} alt="" loading="lazy" className="size-full object-cover" />
                    {selected && (
                      <span className="absolute inset-0 flex items-center justify-center bg-black/30">
                        <Check size={14} strokeWidth={3} className="text-white" aria-hidden />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {tab === 'image' && value.kind === 'image' && (
            <p className="truncate px-0.5 text-micro text-chrome-fg-subtle">
              {PAINTINGS.find((p) => p.id === value.id)?.name} · {PAINTINGS.find((p) => p.id === value.id)?.artist} · public domain
            </p>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Change backdrop"
        title="Change backdrop"
        className="home-island flex size-9 items-center justify-center text-chrome-fg-muted transition-colors hover:text-chrome-fg"
      >
        <Palette size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}
