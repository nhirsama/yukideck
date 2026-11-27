import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  searchable?: boolean;
  className?: string;
  menuClassName?: string;
  ariaLabel?: string;
}

interface MenuCoords {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = '请选择',
  disabled = false,
  size = 'sm',
  searchable,
  className = '',
  menuClassName = '',
  ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(-1);
  const [coords, setCoords] = useState<MenuCoords | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const enableSearch = searchable ?? options.length >= 10;

  const selectedOption = useMemo(
    () => options.find((o) => o.value === value),
    [options, value],
  );

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q) ||
        (o.description && o.description.toLowerCase().includes(q)),
    );
  }, [options, query]);

  const updatePosition = () => {
    const btn = triggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const gap = 4;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const spaceBelow = viewportH - rect.bottom - gap - 12;
    const spaceAbove = rect.top - gap - 12;
    const openUpward = spaceBelow < 210 && spaceAbove > spaceBelow;
    const width = Math.min(Math.max(rect.width, 140), viewportW - 16);
    const left = Math.min(Math.max(8, rect.left), viewportW - width - 8);
    const maxHeight = Math.max(120, Math.min(280, openUpward ? spaceAbove : spaceBelow));

    if (openUpward) {
      setCoords({ left, width, bottom: viewportH - rect.top + gap, maxHeight });
    } else {
      setCoords({ left, width, top: rect.bottom + gap, maxHeight });
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    const idx = filteredOptions.findIndex((o) => o.value === value);
    setActiveIdx(idx >= 0 ? idx : 0);

    if (enableSearch && !window.matchMedia?.('(pointer: coarse)').matches) {
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, enableSearch]);

  useEffect(() => {
    if (!open) return;
    const idx = filteredOptions.findIndex((o) => o.value === value);
    setActiveIdx(idx >= 0 ? idx : filteredOptions.length > 0 ? 0 : -1);
  }, [query, filteredOptions, value, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((prev) =>
          filteredOptions.length === 0 ? -1 : (prev + 1) % filteredOptions.length,
        );
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((prev) =>
          filteredOptions.length === 0
            ? -1
            : (prev - 1 + filteredOptions.length) % filteredOptions.length,
        );
      } else if (e.key === 'Enter' && activeIdx >= 0 && activeIdx < filteredOptions.length) {
        e.preventDefault();
        onChange(filteredOptions[activeIdx].value);
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onScrollOrResize = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return;
      }
      updatePosition();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.visualViewport?.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.visualViewport?.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, filteredOptions, activeIdx, onChange]);

  const hasCoords = Boolean(coords);

  useEffect(() => {
    if (!open || !hasCoords || activeIdx < 0 || !listRef.current) return;
    const el = listRef.current.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, open, hasCoords]);

  const sizeClass =
    size === 'md'
      ? 'rounded-lg px-3 py-2 text-sm'
      : 'rounded-lg px-2.5 py-1.5 text-[13px]';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          if (!disabled) setOpen((v) => !v);
        }}
        className={`inline-flex items-center justify-between gap-2 border bg-white text-left transition-colors focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-400 ${sizeClass} ${
          open
            ? 'border-sky-300 ring-2 ring-sky-500/12 text-zinc-900'
            : 'border-zinc-200/90 text-zinc-800 hover:border-zinc-300/90'
        } ${className}`}
      >
        <span className={`truncate ${selectedOption ? 'text-zinc-800' : 'text-zinc-400'}`}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${
            open ? 'rotate-180 text-sky-500' : 'text-zinc-400'
          }`}
        />
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            style={{
              position: 'fixed',
              left: coords.left,
              width: coords.width,
              top: coords.top,
              bottom: coords.bottom,
            }}
            className={`z-[70] rounded-xl border border-zinc-200/90 bg-white p-1 shadow-[0_10px_28px_rgba(15,23,42,0.10)] ${menuClassName}`}
          >
            {enableSearch && (
              <div className="relative mb-1 px-0.5 pt-0.5">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索选项..."
                  className="w-full rounded-lg border border-zinc-200/80 bg-[#f8fafc] py-1.5 pl-7 pr-2.5 text-[13px] text-zinc-800 placeholder:text-zinc-400 focus:border-sky-300 focus:bg-white focus:outline-none"
                />
              </div>
            )}
            <div
              ref={listRef}
              style={{ maxHeight: coords.maxHeight - (enableSearch ? 44 : 0) }}
              className="overflow-y-auto space-y-0.5"
            >
              {filteredOptions.length === 0 ? (
                <div className="px-2.5 py-3 text-center text-[13px] text-zinc-400">无匹配项</div>
              ) : (
                filteredOptions.map((opt, idx) => {
                  const isSelected = opt.value === value;
                  const isActive = idx === activeIdx;
                  return (
                    <button
                      key={`${opt.value}-${idx}`}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => {
                        onChange(opt.value);
                        setOpen(false);
                        triggerRef.current?.focus();
                      }}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                        isSelected
                          ? 'bg-sky-50/90 text-sky-700 font-medium'
                          : isActive
                            ? 'bg-zinc-100/80 text-zinc-900'
                            : 'text-zinc-700 hover:bg-zinc-50'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{opt.label}</div>
                        {opt.description && (
                          <div className="truncate text-xs text-zinc-400">{opt.description}</div>
                        )}
                      </div>
                      {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-sky-500" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
