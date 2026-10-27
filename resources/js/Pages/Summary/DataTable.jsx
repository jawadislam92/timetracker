import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Columns3, Download, Rows3, Search } from 'lucide-react';
import { downloadCsv } from './model';

/**
 * Table with a column picker, sortable headers, search, density and CSV
 * export. Column visibility/sort/density live in `config` and are written back
 * through `onConfig`, so they persist with the viewer's saved layout.
 *
 * columns: [{ id, label, group?, align?, sticky?, value(row), render?(row), footer?, csv?(row), hideable? }]
 */
export default function DataTable({ columns, rows, config = {}, onConfig, filename = 'summary', toolbar = null, empty = 'Nothing to show for this period.', searchPlaceholder = 'Search…' }) {
    const hidden = new Set(config.hidden ?? columns.filter((c) => c.defaultHidden).map((c) => c.id));
    const sort = config.sort ?? null;
    const dense = config.dense ?? false;
    const [query, setQuery] = useState('');
    const [picker, setPicker] = useState(false);
    const update = (patch) => onConfig?.({ ...config, hidden: [...hidden], ...patch });

    const visible = columns.filter((c) => !hidden.has(c.id));
    const searchCol = columns.find((c) => c.searchable) ?? columns[0];

    const shown = useMemo(() => {
        let out = rows;
        const q = query.trim().toLowerCase();
        if (q) out = out.filter((r) => String(searchCol.value(r) ?? '').toLowerCase().includes(q));
        if (sort) {
            const col = columns.find((c) => c.id === sort.id);
            if (col) {
                const dir = sort.dir === 'asc' ? 1 : -1;
                out = [...out].sort((a, b) => {
                    const va = col.value(a);
                    const vb = col.value(b);
                    if (typeof va === 'number' || typeof vb === 'number') return ((va ?? -Infinity) - (vb ?? -Infinity)) * dir;
                    return String(va ?? '').localeCompare(String(vb ?? '')) * dir;
                });
            }
        }
        return out;
    }, [rows, query, sort?.id, sort?.dir, columns]);

    const toggleSort = (id) => {
        if (sort?.id !== id) update({ sort: { id, dir: 'desc' } });
        else if (sort.dir === 'desc') update({ sort: { id, dir: 'asc' } });
        else update({ sort: null });
    };

    const exportCsv = () =>
        downloadCsv(
            `${filename}.csv`,
            visible.map((c) => c.label),
            shown.map((r) => visible.map((c) => (c.csv ? c.csv(r) : c.value(r)))),
        );

    const pad = dense ? 'py-1.5' : 'py-2.5';
    const hasFooter = visible.some((c) => c.footer !== undefined);

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <label className="relative min-w-[12rem] flex-1 sm:max-w-xs">
                    <span className="sr-only">Search rows</span>
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={searchPlaceholder}
                        className="w-full rounded-lg border border-slate-700 bg-slate-950/60 py-1.5 pl-8 pr-3 text-sm text-slate-200 placeholder:text-slate-500 focus:border-orange-500/60 focus:ring-0"
                    />
                </label>
                {toolbar}
                <div className="ml-auto flex items-center gap-2">
                    <ColumnPicker
                        open={picker}
                        setOpen={setPicker}
                        columns={columns}
                        hidden={hidden}
                        onChange={(next) => update({ hidden: [...next] })}
                        onReset={() => onConfig?.({ ...config, hidden: undefined })}
                    />
                    <button
                        type="button"
                        onClick={() => update({ dense: !dense })}
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${dense ? 'border-orange-500/50 bg-orange-500/10 text-orange-200' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}
                        aria-pressed={dense}
                        title="Compact rows"
                    >
                        <Rows3 className="h-3.5 w-3.5" /> Compact
                    </button>
                    <button type="button" onClick={exportCsv} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800">
                        <Download className="h-3.5 w-3.5" /> CSV
                    </button>
                </div>
            </div>

            <div className="dark-scroll overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
                <table className="w-full min-w-max text-sm">
                    <thead className="bg-slate-800/60">
                        <tr className="border-b border-slate-800">
                            {visible.map((c) => (
                                <th
                                    key={c.id}
                                    scope="col"
                                    aria-sort={sort?.id === c.id ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                                    className={`whitespace-nowrap px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 ${c.align === 'right' ? 'text-right' : 'text-left'} ${c.sticky ? 'sticky left-0 z-10 bg-slate-800' : ''}`}
                                >
                                    <button type="button" onClick={() => toggleSort(c.id)} className={`inline-flex items-center gap-1 hover:text-slate-200 ${c.align === 'right' ? 'flex-row-reverse' : ''}`}>
                                        {c.dot && <span className="h-2 w-2 rounded-full" style={{ background: c.dot }} />}
                                        {c.label}
                                        {sort?.id === c.id && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3 text-orange-400" /> : <ArrowDown className="h-3 w-3 text-orange-400" />)}
                                    </button>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70">
                        {shown.map((r, i) => (
                            <tr key={r.key ?? i} className="group hover:bg-slate-800">
                                {visible.map((c) => (
                                    <td
                                        key={c.id}
                                        className={`whitespace-nowrap px-3 ${pad} ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${c.sticky ? 'sticky left-0 z-10 bg-slate-900 group-hover:bg-slate-800' : ''}`}
                                    >
                                        {c.render ? c.render(r) : c.value(r)}
                                    </td>
                                ))}
                            </tr>
                        ))}
                        {!shown.length && (
                            <tr>
                                <td colSpan={visible.length || 1} className="px-3 py-10 text-center text-sm text-slate-500">
                                    {query ? `No rows match “${query}”.` : empty}
                                </td>
                            </tr>
                        )}
                    </tbody>
                    {hasFooter && shown.length > 0 && (
                        <tfoot className="border-t border-slate-700 bg-slate-900/80">
                            <tr>
                                {visible.map((c) => (
                                    <td
                                        key={c.id}
                                        className={`whitespace-nowrap px-3 py-2.5 text-sm font-semibold text-white ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${c.sticky ? 'sticky left-0 z-10 bg-slate-900' : ''}`}
                                    >
                                        {typeof c.footer === 'function' ? c.footer(shown) : c.footer}
                                    </td>
                                ))}
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>
            <p className="text-xs text-slate-500">
                {shown.length} {shown.length === 1 ? 'row' : 'rows'}
                {hidden.size > 0 && ` · ${[...hidden].filter((id) => columns.some((c) => c.id === id)).length} columns hidden`}
            </p>
        </div>
    );
}

function ColumnPicker({ open, setOpen, columns, hidden, onChange, onReset }) {
    const ref = useRef(null);
    useEffect(() => {
        if (!open) return undefined;
        const close = (e) => {
            if (ref.current && !ref.current.contains(e.target)) setOpen(false);
        };
        const esc = (e) => e.key === 'Escape' && setOpen(false);
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', esc);
        return () => {
            document.removeEventListener('mousedown', close);
            document.removeEventListener('keydown', esc);
        };
    }, [open]);

    const hideable = columns.filter((c) => c.hideable !== false);
    const groups = [...new Set(hideable.map((c) => c.group || 'Columns'))];
    const toggle = (id) => {
        const next = new Set(hidden);
        next.has(id) ? next.delete(id) : next.add(id);
        onChange(next);
    };
    const setGroup = (g, show) => {
        const next = new Set(hidden);
        hideable.filter((c) => (c.group || 'Columns') === g).forEach((c) => (show ? next.delete(c.id) : next.add(c.id)));
        onChange(next);
    };
    const hiddenCount = hideable.filter((c) => hidden.has(c.id)).length;

    return (
        <div className="relative" ref={ref}>
            <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${open || hiddenCount ? 'border-orange-500/50 bg-orange-500/10 text-orange-200' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}
            >
                <Columns3 className="h-3.5 w-3.5" /> Columns
                {hiddenCount > 0 && <span className="rounded bg-orange-500/20 px-1 tabular-nums">{hideable.length - hiddenCount}/{hideable.length}</span>}
            </button>
            {open && (
                <div className="dark-scroll absolute right-0 z-40 mt-2 max-h-[26rem] w-64 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-2xl shadow-black/50">
                    {groups.map((g) => (
                        <div key={g} className="py-1">
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
                            {hideable
                                .filter((c) => (c.group || 'Columns') === g)
                                .map((c) => (
                                    <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-200 hover:bg-slate-800">
                                        <input type="checkbox" checked={!hidden.has(c.id)} onChange={() => toggle(c.id)} className="rounded border-slate-600 bg-slate-800 text-orange-500 focus:ring-orange-500/40" />
                                        {c.dot && <span className="h-2 w-2 rounded-full" style={{ background: c.dot }} />}
                                        {c.label}
                                    </label>
                                ))}
                        </div>
                    ))}
                    <div className="mt-1 border-t border-slate-800 px-2 pt-2">
                        <button type="button" onClick={onReset} className="text-xs text-slate-400 hover:text-white">
                            Reset to default
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
