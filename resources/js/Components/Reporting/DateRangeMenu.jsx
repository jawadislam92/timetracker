import { useEffect, useRef, useState } from 'react';
import { CalendarDays, Check, ChevronDown } from 'lucide-react';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-26" -> "Oct 26, 2026" */
export function prettyDate(s) {
    if (!s) return '';
    const [y, m, d] = s.split('-').map(Number);
    return `${MON[m - 1]} ${d}, ${y}`;
}
export const prettySpan = (start, end) => (start && end ? (start === end ? prettyDate(start) : `${prettyDate(start)} – ${prettyDate(end)}`) : 'All dates');

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromIso = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
};

/**
 * Standard preset spans relative to `today` (YYYY-MM-DD, the business-day
 * "today" from the server). Weeks run Monday–Sunday; current periods run to date.
 */
export function presetSpans(today) {
    const t = fromIso(today);
    const monday = new Date(t);
    monday.setDate(t.getDate() - ((t.getDay() + 6) % 7));
    const add = (d, n) => {
        const x = new Date(d);
        x.setDate(x.getDate() + n);
        return x;
    };
    const firstOfMonth = new Date(t.getFullYear(), t.getMonth(), 1);
    const lastMonthStart = new Date(t.getFullYear(), t.getMonth() - 1, 1);
    const lastMonthEnd = new Date(t.getFullYear(), t.getMonth(), 0);
    return {
        today: [today, today],
        this_week: [iso(monday), today],
        last_week: [iso(add(monday, -7)), iso(add(monday, -1))],
        last_4_weeks: [iso(add(monday, -28)), iso(add(monday, -1))],
        this_month: [iso(firstOfMonth), today],
        last_month: [iso(lastMonthStart), iso(lastMonthEnd)],
        last_30_days: [iso(add(t, -29)), today],
    };
}

/**
 * Upwork-style date range picker: a field showing the active span, opening a
 * list of presets that each show the dates they cover, plus a custom range.
 *
 * presets: [{ id, label, start, end }] — start/end null means "all dates".
 * onChange({ range, start, end })
 */
export default function DateRangeMenu({ range, start, end, presets, onChange, label = 'Date range', allowCustom = true, maxDate }) {
    const [open, setOpen] = useState(false);
    const [custom, setCustom] = useState(false);
    const [s, setS] = useState(start || '');
    const [e, setE] = useState(end || '');
    const ref = useRef(null);

    useEffect(() => {
        setS(start || '');
        setE(end || '');
    }, [start, end]);

    useEffect(() => {
        if (!open) return undefined;
        setCustom(range === 'custom');
        const close = (ev) => ref.current && !ref.current.contains(ev.target) && setOpen(false);
        const esc = (ev) => ev.key === 'Escape' && setOpen(false);
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', esc);
        return () => {
            document.removeEventListener('mousedown', close);
            document.removeEventListener('keydown', esc);
        };
    }, [open]);

    const pick = (p) => {
        setOpen(false);
        onChange({ range: p.id, start: p.start, end: p.end });
    };

    return (
        <div className="relative" ref={ref}>
            <span className="sr-only">{label}</span>
            <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-haspopup="listbox"
                aria-expanded={open}
                className={`flex min-w-[15rem] items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm text-slate-100 transition ${open ? 'border-orange-500/70 ring-2 ring-orange-500/20' : 'border-slate-700 bg-slate-900 hover:border-slate-500'}`}
            >
                <span className="flex-1 truncate tabular-nums">{prettySpan(start, end)}</span>
                <CalendarDays className="h-4 w-4 shrink-0 text-slate-400" />
            </button>
            {open && (
                <div className="absolute left-0 z-50 mt-2 w-[20rem] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-700 bg-slate-900 p-1.5 shadow-2xl shadow-black/60">
                    <ul role="listbox" aria-label={label}>
                        {presets.map((p) => {
                            const active = range === p.id;
                            return (
                                <li key={p.id}>
                                    <button
                                        type="button"
                                        role="option"
                                        aria-selected={active}
                                        onClick={() => pick(p)}
                                        className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-slate-800 ${active ? 'bg-slate-800/60' : ''}`}
                                    >
                                        <Check className={`mt-0.5 h-4 w-4 shrink-0 ${active ? 'text-orange-400' : 'text-transparent'}`} />
                                        <span className="min-w-0">
                                            <span className="block text-sm text-slate-100">{p.label}</span>
                                            <span className="block text-xs tabular-nums text-slate-500">{prettySpan(p.start, p.end)}</span>
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                        {allowCustom && (
                            <li>
                                <button
                                    type="button"
                                    onClick={() => setCustom(true)}
                                    className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-slate-800 ${range === 'custom' ? 'bg-slate-800/60' : ''}`}
                                >
                                    <Check className={`mt-0.5 h-4 w-4 shrink-0 ${range === 'custom' ? 'text-orange-400' : 'text-transparent'}`} />
                                    <span className="flex-1">
                                        <span className="block text-sm text-slate-100">Custom date range</span>
                                        <span className="block text-xs text-slate-500">Pick any start and end</span>
                                    </span>
                                    <ChevronDown className={`mt-0.5 h-4 w-4 text-slate-500 transition ${custom ? 'rotate-180' : ''}`} />
                                </button>
                            </li>
                        )}
                    </ul>
                    {allowCustom && custom && (
                        <form
                            className="mt-1 space-y-2 border-t border-slate-800 px-2.5 pb-1.5 pt-3"
                            onSubmit={(ev) => {
                                ev.preventDefault();
                                if (!s || !e) return;
                                setOpen(false);
                                onChange({ range: 'custom', start: s <= e ? s : e, end: s <= e ? e : s });
                            }}
                        >
                            <div className="grid grid-cols-2 gap-2">
                                <label className="text-xs text-slate-400">
                                    From
                                    <input type="date" value={s} max={e || maxDate} onChange={(ev) => setS(ev.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 [color-scheme:dark] focus:border-orange-500/60 focus:ring-0" />
                                </label>
                                <label className="text-xs text-slate-400">
                                    To
                                    <input type="date" value={e} min={s} max={maxDate} onChange={(ev) => setE(ev.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 [color-scheme:dark] focus:border-orange-500/60 focus:ring-0" />
                                </label>
                            </div>
                            <button type="submit" disabled={!s || !e} className="w-full rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 py-1.5 text-sm font-semibold text-slate-950 disabled:opacity-50">
                                Apply range
                            </button>
                        </form>
                    )}
                </div>
            )}
        </div>
    );
}
