import { Fragment, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Download, Search } from 'lucide-react';
import { downloadCsv } from './model';

/**
 * Sortable, searchable table with CSV export and optional period blocks
 * (Upwork-style: a heading per day/week/month, its rows, then "Total for …").
 * Which columns show, density and sort live in `config` and are written back
 * through `onConfig`, so they persist with the viewer's saved layout. Column
 * choice itself is made in the Display settings dialog.
 *
 * columns: [{ id, label, align?, sticky?, value(row), render?(row), footer?(rows)|string, csv?(row) }]
 * groupOf(row) => { key, label } puts rows into blocks ordered by key.
 */
export default function DataTable({ columns, rows, config = {}, onConfig, filename = 'summary', toolbar = null, empty = 'Nothing to show for this period.', searchPlaceholder = 'Search…', groupOf = null, searchable = true }) {
    const hidden = new Set(config.hidden ?? columns.filter((c) => c.defaultHidden).map((c) => c.id));
    const sort = config.sort ?? null;
    const dense = config.dense ?? false;
    const [query, setQuery] = useState('');
    const update = (patch) => onConfig?.({ ...config, ...patch });

    const visible = columns.filter((c) => c.locked || !hidden.has(c.id));
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

    const blocks = useMemo(() => {
        if (!groupOf) return null;
        const map = new Map();
        for (const r of shown) {
            const g = groupOf(r);
            if (!map.has(g.key)) map.set(g.key, { ...g, rows: [] });
            map.get(g.key).rows.push(r);
        }
        return [...map.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));
    }, [shown, groupOf]);

    const toggleSort = (id) => {
        if (sort?.id !== id) update({ sort: { id, dir: 'desc' } });
        else if (sort.dir === 'desc') update({ sort: { id, dir: 'asc' } });
        else update({ sort: null });
    };

    const cellText = (c, r) => (c.csv ? c.csv(r) : c.value(r));
    const exportCsv = () => {
        if (!blocks) {
            downloadCsv(`${filename}.csv`, visible.map((c) => c.label), shown.map((r) => visible.map((c) => cellText(c, r))));
            return;
        }
        const lines = [];
        for (const b of blocks) {
            b.rows.forEach((r) => lines.push([b.label, ...visible.map((c) => cellText(c, r))]));
            lines.push([`Total for ${b.label}`, ...visible.map((c, i) => (i === 0 ? '' : typeof c.footer === 'function' ? c.footer(b.rows) : ''))]);
        }
        downloadCsv(`${filename}.csv`, ['Period', ...visible.map((c) => c.label)], lines);
    };

    const pad = dense ? 'py-1.5' : 'py-2.5';
    const hasFooter = visible.some((c) => c.footer !== undefined);
    const stickyCell = 'sticky left-0 z-10';

    const renderRow = (r, i) => (
        <tr key={r.key ?? i} className="group hover:bg-slate-800">
            {visible.map((c) => (
                <td key={c.id} className={`whitespace-nowrap px-3 ${pad} ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${c.sticky ? `${stickyCell} bg-slate-900 group-hover:bg-slate-800` : ''}`}>
                    {c.render ? c.render(r) : c.value(r)}
                </td>
            ))}
        </tr>
    );

    const totalsRow = (list, label, strong) =>
        visible.map((c, i) => (
            <td
                key={c.id}
                className={`whitespace-nowrap px-3 py-2.5 text-sm ${strong ? 'font-semibold text-white' : 'font-medium text-slate-200'} ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${c.sticky ? `${stickyCell} ${strong ? 'bg-slate-800' : 'bg-slate-800/90'}` : ''}`}
            >
                {i === 0 ? label : typeof c.footer === 'function' ? c.footer(list) : c.footer}
            </td>
        ));

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                {searchable && (
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
                )}
                {toolbar}
                <button type="button" onClick={exportCsv} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800">
                    <Download className="h-3.5 w-3.5" /> CSV
                </button>
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
                                    className={`whitespace-nowrap px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 ${c.align === 'right' ? 'text-right' : 'text-left'} ${c.sticky ? `${stickyCell} bg-slate-800` : ''}`}
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
                        {blocks
                            ? blocks.map((b) => (
                                  <Fragment key={b.key}>
                                      <tr className="bg-slate-950/70">
                                          <td colSpan={visible.length} className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-orange-200/90">
                                              <span className="sticky left-3">{b.label}</span>
                                          </td>
                                      </tr>
                                      {b.rows.map(renderRow)}
                                      {hasFooter && <tr className="border-t border-slate-700 bg-slate-800/50">{totalsRow(b.rows, `Total for ${b.label}`, false)}</tr>}
                                  </Fragment>
                              ))
                            : shown.map(renderRow)}
                        {!shown.length && (
                            <tr>
                                <td colSpan={visible.length || 1} className="px-3 py-10 text-center text-sm text-slate-500">
                                    {query ? `No rows match “${query}”.` : empty}
                                </td>
                            </tr>
                        )}
                    </tbody>
                    {hasFooter && shown.length > 0 && (
                        <tfoot className="border-t-2 border-slate-700 bg-slate-800">
                            <tr>{totalsRow(shown, blocks ? 'Grand total' : 'Total', true)}</tr>
                        </tfoot>
                    )}
                </table>
            </div>
            <p className="text-xs text-slate-500">
                {shown.length} {shown.length === 1 ? 'row' : 'rows'}
                {blocks && ` in ${blocks.length} ${blocks.length === 1 ? 'block' : 'blocks'}`}
                {hidden.size > 0 && ` · ${columns.filter((c) => !c.locked && hidden.has(c.id)).length} columns hidden`}
            </p>
        </div>
    );
}
