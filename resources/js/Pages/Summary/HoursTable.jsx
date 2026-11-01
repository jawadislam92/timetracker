import { useMemo, useState } from 'react';
import { Settings2 } from 'lucide-react';
import Avatar from '@/Components/Avatar';
import Dialog, { DialogButtons, RadioGroup } from '@/Components/Reporting/Dialog';
import ColumnChecklist from '@/Components/Reporting/ColumnChecklist';
import DataTable from './DataTable';
import { Delta, Panel, SharePill } from './widgets';
import { BILLABLE, INTERNAL, TYPES, TYPE_KEYS, addDays, dayKey, dayName, fmtHours, fmtPct, parseDay, pct, shortDate, weekOf } from './model';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const SHOWS = {
    company: [['person', 'Person'], ['department', 'Department'], ['designation', 'Designation'], ['client', 'Client'], ['work_type', 'Work type']],
    department: [['person', 'Person'], ['designation', 'Designation'], ['client', 'Client'], ['work_type', 'Work type']],
    person: [['client', 'Client'], ['work_type', 'Work type']],
};
const GROUPS = [['all', 'All time'], ['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
const SHOW_NOUN = { person: 'people', department: 'departments', designation: 'designations', client: 'clients', work_type: 'work types' };

export const periodOf = (d, group) => (group === 'day' ? d : group === 'week' ? weekOf(d) : group === 'month' ? d.slice(0, 7) : 'all');
export function periodLabel(key, group) {
    if (group === 'day') return `${dayName(key)}, ${shortDate(key)}`;
    if (group === 'week') return `${shortDate(key)} – ${shortDate(dayKey(addDays(parseDay(key), 6)))}`;
    if (group === 'month') return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
    return 'All time';
}

const sumBy = (rows, fn) => rows.reduce((s, r) => s + (fn(r) || 0), 0);

/**
 * The Summary's hours table. What each row is (Show), how it's split by time
 * (Grouped by) and which columns appear are chosen in an Upwork-style Display
 * settings dialog and saved with the viewer's layout.
 */
export default function HoursTable({ ctx }) {
    const { scope, tableConfig, setTableConfig } = ctx;
    const tableId = scope.kind === 'person' ? 'personHours' : 'hours';
    const defaults = scope.kind === 'person' ? { show: 'client', group: 'week', pivot: true } : { show: 'person', group: 'all', pivot: false };
    const saved = tableConfig(tableId);
    const allowed = SHOWS[scope.kind].map(([v]) => v);
    const cfg = { ...defaults, ...saved, show: allowed.includes(saved.show) ? saved.show : defaults.show };
    const [dialog, setDialog] = useState(false);

    const view = useMemo(() => buildView(ctx, cfg), [ctx.rows, ctx.agg, ctx.scopePeople, cfg.show, cfg.group, cfg.pivot, cfg.showSilent, ctx.settings, ctx.days]);
    const hiddenFor = (show, pivot) => cfg.hidden?.[`${show}${pivot ? ':pivot' : ''}`];
    const pivotOn = cfg.pivot && cfg.group !== 'all';

    const description = `One row per ${SHOWS[scope.kind].find(([v]) => v === cfg.show)?.[1].toLowerCase()}${cfg.group === 'all' ? '' : pivotOn ? `, ${cfg.group}s as columns` : `, grouped by ${cfg.group}`}`;

    return (
        <Panel title="Hours table" subtitle={description}>
            <DataTable
                key={`${cfg.show}-${cfg.group}-${pivotOn}`}
                columns={view.columns}
                rows={view.rows}
                groupOf={view.groupOf}
                config={{ sort: view.defaultSort, ...(cfg.sorts?.[cfg.show] ? { sort: cfg.sorts[cfg.show] } : {}), dense: cfg.dense, hidden: hiddenFor(cfg.show, pivotOn) }}
                onConfig={(next) => setTableConfig(tableId, { ...saved, sorts: { ...(saved.sorts || {}), [cfg.show]: next.sort } })}
                filename={`hours-by-${cfg.show}${cfg.group === 'all' ? '' : `-per-${cfg.group}`}-${ctx.start}-to-${ctx.end}`}
                searchPlaceholder={`Search ${SHOW_NOUN[cfg.show]}…`}
                toolbar={
                    <button type="button" onClick={() => setDialog(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800">
                        <Settings2 className="h-3.5 w-3.5 text-orange-300" /> Display settings
                    </button>
                }
            />
            {dialog && (
                <DisplayDialog
                    scope={scope}
                    cfg={cfg}
                    defaults={defaults}
                    columnsFor={(staged) => buildView(ctx, staged, true).columns}
                    hiddenFor={hiddenFor}
                    onClose={() => setDialog(false)}
                    onApply={(staged) => {
                        const key = `${staged.show}${staged.pivot && staged.group !== 'all' ? ':pivot' : ''}`;
                        setTableConfig(tableId, { ...saved, show: staged.show, group: staged.group, pivot: staged.pivot, showSilent: staged.showSilent, dense: staged.dense, hidden: { ...(saved.hidden || {}), [key]: staged.hidden } });
                        setDialog(false);
                    }}
                />
            )}
        </Panel>
    );
}

function DisplayDialog({ scope, cfg, defaults, columnsFor, hiddenFor, onClose, onApply }) {
    const init = (c) => {
        const pivot = !!c.pivot && c.group !== 'all';
        const cols = columnsFor({ ...c, pivot });
        return { show: c.show, group: c.group, pivot: !!c.pivot, showSilent: !!c.showSilent, dense: !!c.dense, hidden: hiddenFor(c.show, pivot) ?? cols.filter((x) => x.defaultHidden).map((x) => x.id) };
    };
    const [st, setSt] = useState(() => init(cfg));
    const set = (patch) =>
        setSt((s) => {
            const next = { ...s, ...patch };
            if (patch.show !== undefined || patch.group !== undefined || patch.pivot !== undefined) {
                const pivot = next.pivot && next.group !== 'all';
                const cols = columnsFor({ ...next, pivot });
                next.hidden = hiddenFor(next.show, pivot) ?? cols.filter((x) => x.defaultHidden).map((x) => x.id);
            }
            return next;
        });
    const columns = columnsFor({ ...st, pivot: st.pivot && st.group !== 'all' }).map((c) => ({ ...c, label: c.pickerLabel ?? c.label }));

    return (
        <Dialog
            title="Display settings"
            onClose={onClose}
            width="max-w-2xl"
            footer={<DialogButtons onCancel={onClose} onReset={() => setSt(init({ ...defaults }))} onApply={() => onApply(st)} />}
        >
            <div className="grid gap-6 sm:grid-cols-2">
                <RadioGroup label="Show" name="hours-show" value={st.show} onChange={(show) => set({ show })} options={SHOWS[scope.kind]} />
                <div className="space-y-4">
                    <RadioGroup label="Grouped by" name="hours-group" value={st.group} onChange={(group) => set({ group })} options={GROUPS} />
                    {st.group !== 'all' && (
                        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                            <input type="checkbox" checked={st.pivot} onChange={(e) => set({ pivot: e.target.checked })} className="mt-0.5 rounded border-slate-600 bg-slate-800 text-orange-500 focus:ring-orange-500/40" />
                            <span>
                                <span className="block text-sm text-slate-100">Put each {st.group} in its own column</span>
                                <span className="block text-xs text-slate-500">A pivot like Excel's, instead of one block per {st.group}.</span>
                            </span>
                        </label>
                    )}
                </div>
            </div>
            <div className="mt-6 space-y-4">
                <ColumnChecklist columns={columns} hidden={st.hidden} onChange={(hidden) => setSt((s) => ({ ...s, hidden }))} />
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                    <label className="inline-flex items-center gap-2 text-sm text-slate-300">
                        <input type="checkbox" checked={st.dense} onChange={(e) => setSt((s) => ({ ...s, dense: e.target.checked }))} className="rounded border-slate-600 bg-slate-800 text-orange-500 focus:ring-orange-500/40" />
                        Compact rows
                    </label>
                    {st.show === 'person' && st.group === 'all' && (
                        <label className="inline-flex items-center gap-2 text-sm text-slate-300">
                            <input type="checkbox" checked={st.showSilent} onChange={(e) => setSt((s) => ({ ...s, showSilent: e.target.checked }))} className="rounded border-slate-600 bg-slate-800 text-orange-500 focus:ring-orange-500/40" />
                            Include people with 0 hours
                        </label>
                    )}
                </div>
            </div>
        </Dialog>
    );
}

/* ---------------- rows + columns ---------------- */

function buildView(ctx, cfg, columnsOnly = false) {
    const { users, clients, scopePeople, isLow, settings, open, prevByUser, scope, days } = ctx;
    const { show, group } = cfg;
    const pivot = cfg.pivot && group !== 'all';
    const quiet = (r) => settings.quietDepts.includes(r.department);

    const dimOf = (uid, t, cid) => {
        const u = users.get(uid);
        switch (show) {
            case 'person':
                return { key: `u${uid}`, label: u?.name ?? `#${uid}`, user: u, department: u?.department };
            case 'department':
                return { key: `d${u?.department}`, label: u?.department ?? 'Unassigned', department: u?.department };
            case 'designation':
                return { key: `g${(u?.designation ?? '').toLowerCase()}`, label: u?.designation || 'No designation' };
            case 'client':
                if (TYPES[t]?.billable) return cid ? { key: `c${cid}`, label: clients[cid] ?? `Client #${cid}`, kind: 'Billable' } : { key: 'c0', label: 'No client', kind: 'Billable' };
                return { key: `t${t}`, label: `${TYPES[t]?.label ?? t}`, kind: 'Internal' };
            default:
                return { key: `t${t}`, label: TYPES[t]?.label ?? t, kind: TYPES[t]?.billable ? 'Billable' : 'Internal', color: TYPES[t]?.color };
        }
    };

    // ----- aggregate -----
    const map = new Map();
    const periods = new Set();
    if (!columnsOnly) {
        for (const [uid, d, t, cid, h] of ctx.rows) {
            const dim = dimOf(uid, t, cid);
            const p = pivot ? 'all' : periodOf(d, group);
            const id = `${p}|${dim.key}`;
            let row = map.get(id);
            if (!row) {
                row = { ...dim, key: id, period: p, total: 0, billable: 0, byType: {}, cells: {}, days: new Set(), people: new Set() };
                map.set(id, row);
            }
            row.total += h;
            if (TYPES[t]?.billable) row.billable += h;
            row.byType[t] = (row.byType[t] || 0) + h;
            row.days.add(d);
            row.people.add(uid);
            if (pivot) {
                const pk = periodOf(d, group);
                row.cells[pk] = (row.cells[pk] || 0) + h;
                periods.add(pk);
            }
        }
        if (show === 'person' && group === 'all' && cfg.showSilent) {
            scopePeople.forEach((u) => {
                const id = `all|u${u.id}`;
                if (!map.has(id)) map.set(id, { key: id, period: 'all', label: u.name, user: u, department: u.department, total: 0, billable: 0, byType: {}, cells: {}, days: new Set(), people: new Set() });
            });
        }
    }
    const rows = [...map.values()].map((r) => ({ ...r, nDays: r.days.size, nPeople: r.people.size, prevTotal: r.user ? prevByUser.get(r.user.id)?.total ?? null : null }));

    // ----- columns -----
    const nameCol = {
        id: 'name',
        label: { person: 'Person', department: 'Department', designation: 'Designation', client: 'Client / work', work_type: 'Work type' }[show],
        sticky: true,
        locked: true,
        searchable: true,
        value: (r) => r.label,
        render: (r) => {
            if (show === 'person' && r.user)
                return (
                    <button type="button" onClick={() => open({ kind: 'person', userId: r.user.id })} className="flex items-center gap-2 text-left hover:text-orange-300">
                        <Avatar user={r.user} size="sm" className="!h-6 !w-6 border-slate-700 !text-[10px]" />
                        <span className="font-medium text-slate-100">{r.label}</span>
                    </button>
                );
            if (show === 'department')
                return (
                    <button type="button" onClick={() => open({ kind: 'department', department: r.department })} className="font-medium text-slate-100 hover:text-orange-300">
                        {r.label}
                    </button>
                );
            return (
                <span className="flex items-center gap-2">
                    {r.kind && <span className="h-2 w-2 rounded-full" style={{ background: r.color ?? (r.kind === 'Billable' ? BILLABLE : INTERNAL) }} />}
                    <span className="text-slate-100">{r.label}</span>
                </span>
            );
        },
    };

    const details = [];
    if (show === 'person') {
        details.push(
            { id: 'department', label: 'Department', group: 'Details', value: (r) => r.department ?? '', render: (r) => <span className="text-slate-400">{r.department}</span>, defaultHidden: scope.kind !== 'company' },
            { id: 'designation', label: 'Designation', group: 'Details', value: (r) => r.user?.designation ?? '', render: (r) => <span className="text-slate-400">{r.user?.designation ?? '—'}</span>, defaultHidden: true },
        );
    }
    if (show === 'client' || show === 'work_type') {
        details.push({ id: 'kind', label: 'Billable?', group: 'Details', value: (r) => r.kind, render: (r) => <span className={r.kind === 'Billable' ? 'text-orange-200' : 'text-sky-200'}>{r.kind}</span>, defaultHidden: pivot ? false : show === 'work_type' });
    }
    if (show !== 'person' && scope.kind !== 'person') {
        details.push({ id: 'people', label: 'People', group: 'Details', align: 'right', value: (r) => r.nPeople, footer: () => '' });
    }
    details.push({ id: 'days', label: 'Days worked', group: 'Details', align: 'right', value: (r) => r.nDays, defaultHidden: pivot, footer: () => '' });
    if (show === 'person' || scope.kind === 'person') {
        details.push({ id: 'avg', label: 'Avg h / day', group: 'Details', align: 'right', value: (r) => (r.nDays ? r.total / r.nDays : 0), render: (r) => fmtHours(r.nDays ? r.total / r.nDays : 0), defaultHidden: pivot, footer: () => '' });
    }

    const totalCol = { id: 'total', label: 'Total', group: 'Totals', align: 'right', value: (r) => r.total, render: (r) => <span className="font-semibold text-white">{fmtHours(r.total)}</span>, footer: (rs) => fmtHours(sumBy(rs, (r) => r.total)) };

    let columns;
    if (pivot) {
        const order = [...periods].sort();
        const list = order.length ? order : group === 'day' ? days : [...new Set(days.map((d) => periodOf(d, group)))];
        columns = [
            nameCol,
            ...details,
            ...list.map((p) => ({
                id: `p_${p}`,
                label: group === 'day' ? `${dayName(p)} ${shortDate(p)}` : group === 'week' ? `Wk ${shortDate(p)}` : periodLabel(p, 'month'),
                pickerLabel: periodLabel(p, group),
                group: group === 'day' ? 'Days' : group === 'week' ? 'Weeks' : 'Months',
                align: 'right',
                value: (r) => r.cells[p] || 0,
                render: (r) => (r.cells[p] ? fmtHours(r.cells[p]) : <span className="text-slate-600">–</span>),
                footer: (rs) => fmtHours(sumBy(rs, (r) => r.cells[p])),
            })),
            totalCol,
        ];
    } else {
        columns = [
            nameCol,
            ...details,
            ...TYPE_KEYS.map((k) => ({
                id: `t_${k}`,
                label: TYPES[k].short,
                pickerLabel: TYPES[k].label,
                dot: TYPES[k].color,
                group: TYPES[k].billable ? 'Billable work types' : 'Internal work types',
                align: 'right',
                defaultHidden: show === 'work_type',
                value: (r) => r.byType[k] || 0,
                render: (r) => (r.byType[k] ? fmtHours(r.byType[k]) : <span className="text-slate-600">–</span>),
                footer: (rs) => fmtHours(sumBy(rs, (r) => r.byType[k])),
            })),
            { id: 'billable', label: 'Billable', group: 'Totals', align: 'right', value: (r) => r.billable, render: (r) => <span className="text-orange-200">{fmtHours(r.billable)}</span>, footer: (rs) => fmtHours(sumBy(rs, (r) => r.billable)) },
            { id: 'internal', label: 'Internal', group: 'Totals', align: 'right', value: (r) => r.total - r.billable, render: (r) => <span className="text-sky-200">{fmtHours(r.total - r.billable)}</span>, footer: (rs) => fmtHours(sumBy(rs, (r) => r.total - r.billable)) },
            totalCol,
            {
                id: 'share',
                label: 'Billable %',
                group: 'Totals',
                align: 'right',
                value: (r) => pct(r.billable, r.total),
                csv: (r) => Math.round(pct(r.billable, r.total)),
                render: (r) => <SharePill value={pct(r.billable, r.total)} low={(show === 'person' || show === 'department') && !quiet(r) && isLow(pct(r.billable, r.total))} />,
                footer: (rs) => fmtPct(pct(sumBy(rs, (r) => r.billable), sumBy(rs, (r) => r.total))),
            },
        ];
        if (show === 'person' && group === 'all') {
            columns.push({
                id: 'vsprev',
                label: 'vs prev. period',
                group: 'Totals',
                align: 'right',
                defaultHidden: true,
                value: (r) => (r.prevTotal ? ((r.total - r.prevTotal) / r.prevTotal) * 100 : null),
                render: (r) => <Delta now={r.total} before={r.prevTotal} />,
                csv: (r) => (r.prevTotal ? Math.round(((r.total - r.prevTotal) / r.prevTotal) * 100) : ''),
            });
        }
    }

    return {
        columns,
        rows,
        groupOf: !pivot && group !== 'all' ? (r) => ({ key: r.period, label: periodLabel(r.period, group) }) : null,
        defaultSort: { id: 'total', dir: 'desc' },
    };
}
