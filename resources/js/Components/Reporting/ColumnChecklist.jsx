import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * "Customize columns": a field listing the visible columns that opens a
 * grouped checklist. columns: [{ id, label, group?, dot?, locked? }]
 * Locked columns always show and cannot be unticked.
 */
export default function ColumnChecklist({ columns, hidden, onChange, label = 'Customize columns' }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
        if (!open) return undefined;
        const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [open]);

    const visible = columns.filter((c) => c.locked || !hidden.includes(c.id));
    const groups = [...new Set(columns.map((c) => c.group || 'Columns'))];
    const toggle = (id) => onChange(hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id]);
    const setGroup = (g, show) => {
        const ids = columns.filter((c) => !c.locked && (c.group || 'Columns') === g).map((c) => c.id);
        onChange(show ? hidden.filter((h) => !ids.includes(h)) : [...new Set([...hidden, ...ids])]);
    };

    return (
        <div ref={ref} className="relative">
            <div className="mb-2 text-sm font-medium text-slate-300">{label}</div>
            <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-sm text-slate-100 ${open ? 'border-orange-500/70 ring-2 ring-orange-500/20' : 'border-slate-700 bg-slate-950/60 hover:border-slate-500'}`}
            >
                <span className="flex-1 truncate">{visible.map((c) => c.label).join(', ') || 'No columns'}</span>
                <span className="shrink-0 text-xs tabular-nums text-slate-500">
                    {visible.length}/{columns.length}
                </span>
                <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
                <div className="dark-scroll mt-1.5 max-h-72 overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 p-1.5 shadow-xl">
                    {groups.map((g) => (
                        <div key={g} className="py-1">
                            {groups.length > 1 && (
                                <div className="flex items-center justify-between px-2 pb-1">
                                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{g}</span>
                                    <span className="flex gap-2 text-[11px]">
                                        <button type="button" className="text-slate-400 hover:text-white" onClick={() => setGroup(g, true)}>
                                            All
                                        </button>
                                        <button type="button" className="text-slate-400 hover:text-white" onClick={() => setGroup(g, false)}>
                                            None
                                        </button>
                                    </span>
                                </div>
                            )}
                            {columns
                                .filter((c) => (c.group || 'Columns') === g)
                                .map((c) => (
                                    <label key={c.id} className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm ${c.locked ? 'text-slate-500' : 'cursor-pointer text-slate-200 hover:bg-slate-800'}`}>
                                        <input
                                            type="checkbox"
                                            disabled={c.locked}
                                            checked={c.locked || !hidden.includes(c.id)}
                                            onChange={() => toggle(c.id)}
                                            className="rounded border-slate-600 bg-slate-800 text-orange-500 focus:ring-orange-500/40 disabled:opacity-50"
                                        />
                                        {c.dot && <span className="h-2 w-2 rounded-full" style={{ background: c.dot }} />}
                                        {c.label}
                                        {c.locked && <span className="ml-auto text-[10px] uppercase tracking-wider">always</span>}
                                    </label>
                                ))}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
