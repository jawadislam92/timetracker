import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

/** Modal shell shared by Filter by / Display settings. Escape and the scrim close it. */
export default function Dialog({ title, onClose, children, footer, width = 'max-w-xl', scroll = true }) {
    const panel = useRef(null);
    useEffect(() => {
        const prev = document.activeElement;
        panel.current?.querySelector('input, select, button:not([data-close])')?.focus();
        const esc = (e) => e.key === 'Escape' && onClose();
        document.addEventListener('keydown', esc);
        return () => {
            document.removeEventListener('keydown', esc);
            prev?.focus?.();
        };
    }, []);

    return (
        <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto p-4 sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
            <button type="button" aria-label="Close" data-close className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm" onClick={onClose} />
            <div ref={panel} className={`relative flex ${scroll ? 'max-h-[calc(100vh-2rem)]' : ''} w-full ${width} flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/60`}>
                <header className="flex items-start justify-between gap-4 px-6 pb-2 pt-6">
                    <h2 className="text-2xl font-semibold tracking-tight text-white">{title}</h2>
                    <button type="button" data-close onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label={`Close ${title}`}>
                        <X className="h-5 w-5" />
                    </button>
                </header>
                <div className={`px-6 py-3 ${scroll ? 'dark-scroll flex-1 overflow-y-auto' : ''}`}>{children}</div>
                {footer && <footer className="flex flex-wrap items-center justify-end gap-2 px-6 pb-6 pt-3">{footer}</footer>}
            </div>
        </div>
    );
}

export function DialogButtons({ onCancel, onReset, onApply, applyLabel = 'Apply', dirty = true, resettable = true }) {
    return (
        <>
            <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-sm font-medium text-orange-300 hover:bg-slate-800">
                Cancel
            </button>
            {onReset && (
                <button type="button" onClick={onReset} disabled={!resettable} className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-40">
                    Reset
                </button>
            )}
            <button type="button" onClick={onApply} disabled={!dirty} className="rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-5 py-2 text-sm font-semibold text-slate-950 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
                {applyLabel}
            </button>
        </>
    );
}

/** A labelled radio column, e.g. "Show" or "Grouped by". */
export function RadioGroup({ label, name, value, options, onChange }) {
    return (
        <fieldset>
            <legend className="mb-2 text-sm font-medium text-slate-300">{label}</legend>
            <div className="space-y-1">
                {options.map(([v, l, hint]) => (
                    <label key={v} className="flex cursor-pointer items-start gap-3 rounded-lg px-1 py-1.5 hover:bg-slate-800/50">
                        <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} className="mt-0.5 h-4 w-4 border-slate-600 bg-slate-800 text-orange-500 focus:ring-orange-500/40" />
                        <span>
                            <span className="block text-sm text-slate-100">{l}</span>
                            {hint && <span className="block text-xs text-slate-500">{hint}</span>}
                        </span>
                    </label>
                ))}
            </div>
        </fieldset>
    );
}
