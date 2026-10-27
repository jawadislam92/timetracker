import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Head, router } from '@inertiajs/react';
import { ArrowDown, ArrowUp, Building2, Check, ChevronDown, ChevronRight, Eye, EyeOff, Search, SlidersHorizontal, UsersRound, X } from 'lucide-react';
import AuthenticatedLayout from '@/Layouts/AuthenticatedLayout';
import PageShell from '@/Components/Layout/PageShell';
import Avatar from '@/Components/Avatar';
import { TooltipProvider } from './charts';
import { Clients, DayGrid, Departments, Flags, KpiStrip, Mix, People, PersonHeader, PersonTable, Segmented, TeamTable, Trend, Weekly } from './widgets';
import { RANGES, aggregate, daysBetween, fmtHours, fmtPct, pct, shortDate, weeksBetween } from './model';

/* ---------------- widget registry ---------------- */

const WIDGETS = {
    kpis: { name: 'Headline numbers', desc: 'Hours, billable share and change vs the previous period.', Component: KpiStrip, bare: true },
    flags: { name: 'Needs a look', desc: 'People under the billable line, with no billable hours, or nothing logged.', Component: Flags },
    departments: { name: 'Departments', desc: 'One card per department: hours, billable %, work mix, daily trend.', Component: Departments },
    trend: { name: 'Hours per day', desc: 'Daily columns, split billable/internal or by work type.', Component: Trend },
    mix: { name: 'Work type mix', desc: 'Donut plus a breakdown of the seven work types.', Component: Mix },
    people: { name: 'People', desc: 'Everyone ranked by billable share or hours.', Component: People },
    clients: { name: 'Clients', desc: 'Clients with the most billable hours.', Component: Clients },
    weekly: { name: 'Billable % by week', desc: 'Week-to-week billable share (per department on the company view).', Component: Weekly },
    daygrid: { name: 'Day-by-day grid', desc: 'A heat grid of hours per person (or work type) per day.', Component: DayGrid },
    teamTable: { name: 'Hours table', desc: 'Pivot table by person, department or client with a column picker.', Component: TeamTable },
    personTable: { name: 'Hours table', desc: 'Client × day (or week) table with a column picker.', Component: PersonTable },
};

const DEFAULTS = {
    company: [['kpis', 'full'], ['departments', 'full'], ['flags', 'full'], ['trend', 'twothirds'], ['mix', 'third'], ['people', 'half'], ['clients', 'half'], ['weekly', 'full'], ['daygrid', 'full', false], ['teamTable', 'full']],
    department: [['kpis', 'full'], ['flags', 'full'], ['trend', 'twothirds'], ['mix', 'third'], ['people', 'half'], ['clients', 'half'], ['weekly', 'half', false], ['daygrid', 'full'], ['teamTable', 'full']],
    person: [['kpis', 'full'], ['trend', 'twothirds'], ['mix', 'third'], ['clients', 'half'], ['weekly', 'half'], ['daygrid', 'full', false], ['personTable', 'full']],
};

const SIZES = [
    ['third', '⅓'],
    ['half', '½'],
    ['twothirds', '⅔'],
    ['full', 'Full'],
];
const SPAN = {
    third: 'col-span-12 lg:col-span-6 xl:col-span-4',
    half: 'col-span-12 lg:col-span-6',
    twothirds: 'col-span-12 xl:col-span-8',
    full: 'col-span-12',
};
const SCOPE_LABEL = { company: 'Company view', department: 'Department view', person: 'Person view' };

function normalizeLayout(saved) {
    const out = { widgets: {}, settings: { lowShare: 50, quietDepts: [] }, tables: {} };
    for (const scope of Object.keys(DEFAULTS)) {
        const defaults = DEFAULTS[scope].map(([id, size, on = true]) => ({ id, size, on }));
        const list = (saved?.widgets?.[scope] ?? []).filter((w) => defaults.some((d) => d.id === w.id) && SPAN[w.size]);
        defaults.forEach((d) => !list.some((w) => w.id === d.id) && list.push(d));
        out.widgets[scope] = list.map((w) => ({ id: w.id, size: w.size, on: w.on !== false }));
    }
    const s = saved?.settings ?? {};
    out.settings.lowShare = Number.isFinite(s.lowShare) ? Math.min(100, Math.max(0, s.lowShare)) : 50;
    out.settings.quietDepts = Array.isArray(s.quietDepts) ? s.quietDepts : [];
    out.tables = saved?.tables && typeof saved.tables === 'object' ? saved.tables : {};
    return out;
}

function readScope(users) {
    const q = new URLSearchParams(window.location.search);
    const person = Number(q.get('person'));
    if (person && users.has(person)) return { kind: 'person', userId: person };
    if (q.get('department')) return { kind: 'department', department: q.get('department') };
    return { kind: 'company' };
}

/* ---------------- page ---------------- */

export default function SummaryIndex({ auth, range, start, end, previous, rows, users: userList, clients, designations, layout: savedLayout, canEditDepartments }) {
    const users = useMemo(() => new Map(userList.map((u) => [u.id, u])), [userList]);
    const [scope, setScope] = useState(() => readScope(users));
    const [layout, setLayout] = useState(() => normalizeLayout(savedLayout));
    const [customizing, setCustomizing] = useState(false);
    const [editingDepts, setEditingDepts] = useState(false);
    const [saveState, setSaveState] = useState('idle');

    // Persist the layout to the viewer's account, debounced.
    const firstSave = useRef(true);
    useEffect(() => {
        if (firstSave.current) {
            firstSave.current = false;
            return undefined;
        }
        setSaveState('saving');
        const t = setTimeout(() => {
            window.axios
                .put(route('summary.layout'), { layout })
                .then(() => setSaveState('saved'))
                .catch(() => setSaveState('error'));
        }, 700);
        return () => clearTimeout(t);
    }, [layout]);

    // Keep the scope in the address bar so a view can be bookmarked or shared.
    useEffect(() => {
        const url = new URL(window.location.href);
        url.searchParams.delete('person');
        url.searchParams.delete('department');
        if (scope.kind === 'person') url.searchParams.set('person', scope.userId);
        if (scope.kind === 'department') url.searchParams.set('department', scope.department);
        window.history.replaceState(window.history.state, '', url);
    }, [scope]);

    const open = useCallback((next) => {
        setScope(next);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }, []);

    const scopeParams = () => (scope.kind === 'person' ? { person: scope.userId } : scope.kind === 'department' ? { department: scope.department } : {});
    const changeRange = (params) => router.get(route('summary.index'), { ...params, ...scopeParams() }, { preserveScroll: true, preserveState: true, only: ['range', 'start', 'end', 'previous', 'rows', 'users', 'clients'] });

    const days = useMemo(() => daysBetween(start, end), [start, end]);
    const weeks = useMemo(() => weeksBetween(start, end), [start, end]);
    const companyAgg = useMemo(() => aggregate(rows, users), [rows, users]);

    const departments = useMemo(() => {
        const m = new Map();
        userList.forEach((u) => {
            if (!u.active && !companyAgg.byUser.has(u.id)) return;
            m.set(u.department, (m.get(u.department) || 0) + 1);
        });
        return [...m.entries()].sort((a, b) => (a[0] === 'Unassigned') - (b[0] === 'Unassigned') || a[0].localeCompare(b[0]));
    }, [userList, companyAgg]);

    // People who belong on the page: active, or archived but logged hours.
    const people = useMemo(() => userList.filter((u) => u.active || companyAgg.byUser.has(u.id)), [userList, companyAgg]);
    const scopePeople = useMemo(
        () => (scope.kind === 'person' ? people.filter((u) => u.id === scope.userId) : scope.kind === 'department' ? people.filter((u) => u.department === scope.department) : people),
        [people, scope],
    );
    const scopeIds = useMemo(() => new Set(scopePeople.map((u) => u.id)), [scopePeople]);
    const scopeRows = useMemo(() => (scope.kind === 'company' ? rows : rows.filter((r) => scopeIds.has(r[0]))), [rows, scope.kind, scopeIds]);
    const agg = useMemo(() => (scope.kind === 'company' ? companyAgg : aggregate(scopeRows, users)), [scope.kind, companyAgg, scopeRows, users]);

    const prevByUser = useMemo(() => new Map(previous.people.map(([id, total, billable]) => [id, { total, billable }])), [previous]);
    const prev = useMemo(() => {
        let total = 0;
        let billable = 0;
        prevByUser.forEach((p, id) => {
            if (scope.kind === 'company' || scopeIds.has(id)) {
                total += p.total;
                billable += p.billable;
            }
        });
        return { total, billable };
    }, [prevByUser, scope.kind, scopeIds]);

    const personDept = scope.kind === 'person' ? users.get(scope.userId)?.department : null;
    const deptAgg = useMemo(() => (personDept ? aggregate(rows.filter((r) => users.get(r[0])?.department === personDept), users) : null), [personDept, rows, users]);

    const { settings } = layout;
    const isLow = useCallback((share) => share < settings.lowShare, [settings.lowShare]);
    const tableConfig = (id) => layout.tables[id] ?? {};
    const setTableConfig = (id, cfg) => setLayout((l) => ({ ...l, tables: { ...l.tables, [id]: cfg } }));

    const ctx = { agg, prev, prevByUser, rows: scopeRows, days, weeks, users, people, scopePeople, scope, clients, settings, isLow, open, tableConfig, setTableConfig, start, end, deptAgg };
    const widgets = layout.widgets[scope.kind].filter((w) => w.on && !(w.id === 'departments' && scope.kind !== 'company'));
    const scopeName = scope.kind === 'person' ? users.get(scope.userId)?.name : scope.kind === 'department' ? scope.department : 'Whole company';

    return (
        <AuthenticatedLayout user={auth.user}>
            <Head title={`Summary · ${scopeName}`} />
            <TooltipProvider>
                <PageShell>
                    {/* header */}
                    <section className="flex flex-col gap-4 border-b border-slate-800 pb-4 xl:flex-row xl:items-end xl:justify-between">
                        <div className="min-w-0">
                            <nav aria-label="Summary scope" className="flex flex-wrap items-center gap-1 text-sm text-slate-400">
                                <button type="button" onClick={() => open({ kind: 'company' })} className={scope.kind === 'company' ? 'text-slate-200' : 'hover:text-white'}>
                                    Company
                                </button>
                                {(scope.kind === 'department' || personDept) && (
                                    <>
                                        <ChevronRight className="h-4 w-4 text-slate-600" />
                                        <button type="button" onClick={() => open({ kind: 'department', department: scope.department ?? personDept })} className={scope.kind === 'department' ? 'text-slate-200' : 'hover:text-white'}>
                                            {scope.department ?? personDept}
                                        </button>
                                    </>
                                )}
                                {scope.kind === 'person' && (
                                    <>
                                        <ChevronRight className="h-4 w-4 text-slate-600" />
                                        <span className="text-slate-200">{scopeName}</span>
                                    </>
                                )}
                            </nav>
                            <h1 className="mt-1 flex items-center gap-3 text-2xl font-bold text-white">
                                <span className="h-6 w-1 rounded-full bg-gradient-to-b from-orange-400 to-amber-500" aria-hidden="true" />
                                Summary
                                <span className="text-base font-normal text-slate-400">
                                    {shortDate(start)} – {shortDate(end)}
                                </span>
                            </h1>
                        </div>
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <RangePicker range={range} start={start} end={end} onChange={changeRange} />
                            <button
                                type="button"
                                onClick={() => setCustomizing(true)}
                                className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-3 py-1.5 text-sm font-semibold text-slate-950 shadow-lg shadow-orange-500/20 hover:brightness-110"
                            >
                                <SlidersHorizontal className="h-4 w-4" /> Customize
                            </button>
                        </div>
                    </section>

                    {/* scope bar */}
                    <section className="flex flex-col gap-3 lg:flex-row lg:items-center">
                        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                            <ScopeChip active={scope.kind === 'company'} onClick={() => open({ kind: 'company' })} icon={Building2} label="All departments" count={people.length} />
                            {departments.map(([name, count]) => (
                                <ScopeChip key={name} active={scope.department === name || (scope.kind === 'person' && personDept === name)} soft={scope.kind === 'person' && personDept === name} onClick={() => open({ kind: 'department', department: name })} label={name} count={count} />
                            ))}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <PersonPicker people={people} agg={companyAgg} value={scope.kind === 'person' ? scope.userId : null} onPick={(id) => open({ kind: 'person', userId: id })} departmentFilter={scope.kind === 'department' ? scope.department : null} />
                            {canEditDepartments && (
                                <button type="button" onClick={() => setEditingDepts(true)} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800" title="Choose which department each designation belongs to">
                                    <UsersRound className="h-4 w-4" /> Departments
                                </button>
                            )}
                        </div>
                    </section>

                    {scope.kind === 'person' && <PersonHeader ctx={ctx} />}

                    {/* widgets */}
                    <div className="grid grid-cols-12 gap-4">
                        {widgets.map((w) => {
                            const def = WIDGETS[w.id];
                            const C = def.Component;
                            return (
                                <div key={w.id} className={`${SPAN[w.size]} min-w-0`}>
                                    <C ctx={ctx} />
                                </div>
                            );
                        })}
                        {!widgets.length && (
                            <div className="col-span-12 rounded-2xl border border-dashed border-slate-700 p-10 text-center text-sm text-slate-400">
                                Every panel is switched off for this view.{' '}
                                <button type="button" onClick={() => setCustomizing(true)} className="font-medium text-orange-300 hover:text-orange-200">
                                    Customize
                                </button>
                            </div>
                        )}
                    </div>
                </PageShell>

                {customizing && <CustomizeDrawer scope={scope} layout={layout} setLayout={setLayout} departments={departments.map(([n]) => n)} onClose={() => setCustomizing(false)} saveState={saveState} />}
                {editingDepts && <DepartmentsDialog designations={designations} onClose={() => setEditingDepts(false)} />}
            </TooltipProvider>
        </AuthenticatedLayout>
    );
}

/* ---------------- scope chips ---------------- */

function ScopeChip({ active, soft, onClick, label, count, icon: Icon }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${
                active && !soft ? 'border-orange-500/60 bg-orange-500/15 text-orange-100' : soft ? 'border-orange-500/30 text-orange-200/80' : 'border-slate-700 bg-slate-900/60 text-slate-300 hover:border-slate-500 hover:text-white'
            }`}
        >
            {Icon && <Icon className="h-4 w-4" />}
            {label}
            <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${active ? 'bg-orange-500/20' : 'bg-slate-800 text-slate-400'}`}>{count}</span>
        </button>
    );
}

/* ---------------- range ---------------- */

function RangePicker({ range, start, end, onChange }) {
    const [custom, setCustom] = useState(range === 'custom');
    const [s, setS] = useState(start);
    const [e, setE] = useState(end);
    useEffect(() => {
        setS(start);
        setE(end);
    }, [start, end]);

    return (
        <div className="flex max-w-full flex-wrap items-center gap-2">
            <Segmented
                label="Period"
                size="md"
                value={custom ? 'custom' : range}
                onChange={(v) => {
                    if (v === 'custom') return setCustom(true);
                    setCustom(false);
                    onChange({ range: v });
                }}
                options={[...RANGES, ['custom', 'Custom']]}
            />
            {custom && (
                <form
                    className="flex items-center gap-1.5"
                    onSubmit={(ev) => {
                        ev.preventDefault();
                        onChange({ range: 'custom', start: s, end: e });
                    }}
                >
                    <input type="date" value={s} max={e} onChange={(ev) => setS(ev.target.value)} aria-label="From" className="rounded-lg border border-slate-700 bg-slate-950/60 px-2 py-1.5 text-sm text-slate-200 [color-scheme:dark]" />
                    <span className="text-slate-500">–</span>
                    <input type="date" value={e} min={s} onChange={(ev) => setE(ev.target.value)} aria-label="To" className="rounded-lg border border-slate-700 bg-slate-950/60 px-2 py-1.5 text-sm text-slate-200 [color-scheme:dark]" />
                    <button type="submit" className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-600">
                        Apply
                    </button>
                </form>
            )}
        </div>
    );
}

/* ---------------- person picker ---------------- */

function PersonPicker({ people, agg, value, onPick, departmentFilter }) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState('');
    const [active, setActive] = useState(0);
    const ref = useRef(null);
    const input = useRef(null);
    const selected = people.find((u) => u.id === value);

    useEffect(() => {
        if (!open) return undefined;
        setTimeout(() => input.current?.focus(), 0);
        const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [open]);

    const list = useMemo(() => {
        const needle = q.trim().toLowerCase();
        return people
            .filter((u) => !needle || u.name.toLowerCase().includes(needle) || (u.designation ?? '').toLowerCase().includes(needle) || u.department.toLowerCase().includes(needle))
            .sort((a, b) => (departmentFilter ? (b.department === departmentFilter) - (a.department === departmentFilter) : 0) || a.department.localeCompare(b.department) || a.name.localeCompare(b.name));
    }, [people, q, departmentFilter]);
    useEffect(() => setActive(0), [q]);

    const pick = (u) => {
        onPick(u.id);
        setOpen(false);
        setQ('');
    };

    return (
        <div className="relative w-full sm:w-auto" ref={ref}>
            <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-haspopup="listbox"
                aria-expanded={open}
                className={`flex w-full items-center gap-2 rounded-lg border sm:w-64 px-2.5 py-1.5 text-left text-sm ${selected ? 'border-orange-500/50 bg-orange-500/10' : 'border-slate-700 bg-slate-900/60 hover:border-slate-500'}`}
            >
                {selected ? <Avatar user={selected} size="sm" className="!h-6 !w-6 border-slate-700 !text-[10px]" /> : <Search className="h-4 w-4 text-slate-500" />}
                <span className={`min-w-0 flex-1 truncate ${selected ? 'text-white' : 'text-slate-400'}`}>{selected ? selected.name : 'Find a person…'}</span>
                <ChevronDown className="h-4 w-4 text-slate-500" />
            </button>
            {open && (
                <div className="absolute right-0 z-50 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/60">
                    <div className="border-b border-slate-800 p-2">
                        <div className="relative">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                            <input
                                ref={input}
                                value={q}
                                onChange={(e) => setQ(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'ArrowDown') {
                                        e.preventDefault();
                                        setActive((a) => Math.min(list.length - 1, a + 1));
                                    } else if (e.key === 'ArrowUp') {
                                        e.preventDefault();
                                        setActive((a) => Math.max(0, a - 1));
                                    } else if (e.key === 'Enter' && list[active]) {
                                        e.preventDefault();
                                        pick(list[active]);
                                    } else if (e.key === 'Escape') setOpen(false);
                                }}
                                placeholder="Name, designation or department"
                                className="w-full rounded-lg border border-slate-700 bg-slate-950 py-1.5 pl-8 pr-3 text-sm text-slate-200 placeholder:text-slate-500 focus:border-orange-500/60 focus:ring-0"
                                role="combobox"
                                aria-expanded="true"
                                aria-controls="summary-person-list"
                            />
                        </div>
                    </div>
                    <ul id="summary-person-list" role="listbox" className="dark-scroll max-h-80 overflow-y-auto p-1">
                        {list.map((u, i) => {
                            const a = agg.byUser.get(u.id);
                            const showHeading = i === 0 || list[i - 1].department !== u.department;
                            return (
                                <li key={u.id} role="presentation">
                                    {showHeading && <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{u.department}</div>}
                                    <button
                                        type="button"
                                        role="option"
                                        aria-selected={u.id === value}
                                        onMouseEnter={() => setActive(i)}
                                        onClick={() => pick(u)}
                                        ref={(el) => i === active && el?.scrollIntoView({ block: 'nearest' })}
                                        className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left ${i === active ? 'bg-slate-800' : ''}`}
                                    >
                                        <Avatar user={u} size="sm" className="!h-7 !w-7 border-slate-700" />
                                        <span className="min-w-0 flex-1">
                                            <span className="flex items-center gap-1.5 truncate text-sm text-slate-100">
                                                {u.name}
                                                {u.id === value && <Check className="h-3.5 w-3.5 text-orange-400" />}
                                                {!u.active && <span className="rounded bg-slate-700 px-1 text-[10px] text-slate-300">archived</span>}
                                            </span>
                                            <span className="block truncate text-[11px] text-slate-500">{u.designation ?? 'No designation'}</span>
                                        </span>
                                        <span className="text-right text-[11px] tabular-nums text-slate-400">
                                            {a ? (
                                                <>
                                                    <span className="block text-slate-200">{fmtHours(a.total)} h</span>
                                                    {fmtPct(pct(a.billable, a.total))} billable
                                                </>
                                            ) : (
                                                'no hours'
                                            )}
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                        {!list.length && <li className="px-3 py-6 text-center text-sm text-slate-500">Nobody matches “{q}”.</li>}
                    </ul>
                </div>
            )}
        </div>
    );
}

/* ---------------- customize drawer ---------------- */

function CustomizeDrawer({ scope, layout, setLayout, departments, onClose, saveState }) {
    const [tab, setTab] = useState(scope.kind);
    const list = layout.widgets[tab];
    const closeRef = useRef(null);
    useEffect(() => {
        closeRef.current?.focus();
        const esc = (e) => e.key === 'Escape' && onClose();
        document.addEventListener('keydown', esc);
        return () => document.removeEventListener('keydown', esc);
    }, []);

    const setList = (next) => setLayout((l) => ({ ...l, widgets: { ...l.widgets, [tab]: next } }));
    const patch = (i, p) => setList(list.map((w, j) => (j === i ? { ...w, ...p } : w)));
    const move = (i, d) => {
        const j = i + d;
        if (j < 0 || j >= list.length) return;
        const next = [...list];
        [next[i], next[j]] = [next[j], next[i]];
        setList(next);
    };
    const setSettings = (p) => setLayout((l) => ({ ...l, settings: { ...l.settings, ...p } }));

    return (
        <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label="Customize summary">
            <button type="button" aria-label="Close" className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm" onClick={onClose} />
            <aside className="relative flex h-full w-full max-w-md flex-col border-l border-slate-800 bg-slate-900 shadow-2xl">
                <header className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
                    <div>
                        <h2 className="text-base font-semibold text-white">Customize</h2>
                        <p className="text-xs text-slate-400">
                            {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Could not save — changes apply on this screen only.' : 'Saved to your account; follows you to any computer.'}
                        </p>
                    </div>
                    <button ref={closeRef} type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Close customize">
                        <X className="h-5 w-5" />
                    </button>
                </header>
                <div className="dark-scroll flex-1 space-y-6 overflow-y-auto px-5 py-4">
                    <div>
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Panels for</div>
                        <Segmented label="Panels for" value={tab} onChange={setTab} options={Object.entries(SCOPE_LABEL)} />
                        <ul className="mt-3 space-y-2">
                            {list.map((w, i) => {
                                const def = WIDGETS[w.id];
                                return (
                                    <li key={w.id} className={`rounded-xl border p-3 ${w.on ? 'border-slate-700 bg-slate-800/40' : 'border-slate-800 bg-slate-900 opacity-70'}`}>
                                        <div className="flex items-start gap-3">
                                            <button type="button" onClick={() => patch(i, { on: !w.on })} aria-pressed={w.on} className={`mt-0.5 rounded-md p-1 ${w.on ? 'text-orange-300 hover:bg-slate-700' : 'text-slate-500 hover:bg-slate-800'}`} title={w.on ? 'Hide panel' : 'Show panel'}>
                                                {w.on ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                                            </button>
                                            <div className="min-w-0 flex-1">
                                                <div className="text-sm font-medium text-slate-100">{def.name}</div>
                                                <div className="text-xs text-slate-400">{def.desc}</div>
                                                {w.on && !def.bare && (
                                                    <div className="mt-2">
                                                        <Segmented label="Width" value={w.size} onChange={(size) => patch(i, { size })} options={SIZES} />
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex flex-col">
                                                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-white disabled:opacity-30" aria-label={`Move ${def.name} up`}>
                                                    <ArrowUp className="h-4 w-4" />
                                                </button>
                                                <button type="button" onClick={() => move(i, 1)} disabled={i === list.length - 1} className="rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-white disabled:opacity-30" aria-label={`Move ${def.name} down`}>
                                                    <ArrowDown className="h-4 w-4" />
                                                </button>
                                            </div>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                        <button type="button" onClick={() => setList(DEFAULTS[tab].map(([id, size, on = true]) => ({ id, size, on })))} className="mt-2 text-xs text-slate-400 hover:text-white">
                            Reset {SCOPE_LABEL[tab].toLowerCase()} to default
                        </button>
                    </div>

                    <div>
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Flag people below</div>
                        <div className="flex items-center gap-3">
                            <input type="range" min="0" max="100" step="5" value={layout.settings.lowShare} onChange={(e) => setSettings({ lowShare: Number(e.target.value) })} className="flex-1 accent-orange-500" aria-label="Low billable threshold" />
                            <span className="w-12 text-right text-sm font-semibold tabular-nums text-white">{layout.settings.lowShare}%</span>
                        </div>
                        <p className="mt-1 text-xs text-slate-400">Anyone under this billable share is marked red.</p>
                    </div>

                    <div>
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Internal by design</div>
                        <p className="mb-2 text-xs text-slate-400">Departments whose job is internal (e.g. bidding or admin). Their people are never flagged as low billable.</p>
                        <div className="space-y-1">
                            {departments.map((d) => (
                                <label key={d} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-200 hover:bg-slate-800">
                                    <input
                                        type="checkbox"
                                        checked={layout.settings.quietDepts.includes(d)}
                                        onChange={(e) => setSettings({ quietDepts: e.target.checked ? [...layout.settings.quietDepts, d] : layout.settings.quietDepts.filter((x) => x !== d) })}
                                        className="rounded border-slate-600 bg-slate-800 text-orange-500 focus:ring-orange-500/40"
                                    />
                                    {d}
                                </label>
                            ))}
                        </div>
                    </div>
                </div>
            </aside>
        </div>
    );
}

/* ---------------- departments dialog ---------------- */

function DepartmentsDialog({ designations, onClose }) {
    const [items, setItems] = useState(() => designations.map((d) => ({ ...d, department: d.department ?? '' })));
    const [saving, setSaving] = useState(false);
    const [showUnused, setShowUnused] = useState(false);
    const known = [...new Set(items.map((d) => d.department).filter(Boolean))].sort();
    const shown = items.filter((d) => showUnused || d.people > 0 || !d.department);

    useEffect(() => {
        const esc = (e) => e.key === 'Escape' && onClose();
        document.addEventListener('keydown', esc);
        return () => document.removeEventListener('keydown', esc);
    }, []);

    const save = () => {
        setSaving(true);
        router.put(
            route('summary.departments'),
            { designations: items.map(({ name, department }) => ({ name, department: department.trim() || null })) },
            { preserveScroll: true, preserveState: true, onSuccess: onClose, onFinish: () => setSaving(false) },
        );
    };

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="dept-title">
            <button type="button" aria-label="Close" className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm" onClick={onClose} />
            <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
                <header className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4">
                    <div>
                        <h2 id="dept-title" className="text-base font-semibold text-white">
                            Departments
                        </h2>
                        <p className="text-xs text-slate-400">Each designation belongs to one department. Everyone with that designation moves with it. Type a new name to create a department.</p>
                    </div>
                    <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Close departments">
                        <X className="h-5 w-5" />
                    </button>
                </header>
                <div className="dark-scroll flex-1 overflow-y-auto px-5 py-3">
                    <datalist id="summary-dept-names">
                        {known.map((k) => (
                            <option key={k} value={k} />
                        ))}
                    </datalist>
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
                                <th className="py-2 font-semibold">Designation</th>
                                <th className="py-2 text-right font-semibold">People</th>
                                <th className="py-2 pl-4 font-semibold">Department</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                            {shown.map((d) => (
                                <tr key={d.name}>
                                    <td className="py-2 text-slate-200">{d.name}</td>
                                    <td className="py-2 text-right tabular-nums text-slate-400">{d.people}</td>
                                    <td className="py-2 pl-4">
                                        <input
                                            list="summary-dept-names"
                                            value={d.department}
                                            maxLength={60}
                                            placeholder="Unassigned"
                                            onChange={(e) => setItems((all) => all.map((x) => (x.name === d.name ? { ...x, department: e.target.value } : x)))}
                                            className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-2.5 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 focus:border-orange-500/60 focus:ring-0"
                                            aria-label={`Department for ${d.name}`}
                                        />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <footer className="flex items-center justify-between gap-3 border-t border-slate-800 px-5 py-3">
                    <label className="inline-flex items-center gap-2 text-xs text-slate-400">
                        <input type="checkbox" checked={showUnused} onChange={(e) => setShowUnused(e.target.checked)} className="rounded border-slate-600 bg-slate-800 text-orange-500 focus:ring-orange-500/40" />
                        Show designations nobody has
                    </label>
                    <div className="flex gap-2">
                        <button type="button" onClick={onClose} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">
                            Cancel
                        </button>
                        <button type="button" onClick={save} disabled={saving} className="rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-1.5 text-sm font-semibold text-slate-950 disabled:opacity-60">
                            {saving ? 'Saving…' : 'Save departments'}
                        </button>
                    </div>
                </footer>
            </div>
        </div>
    );
}
