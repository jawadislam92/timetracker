import { useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, ChevronRight, Minus } from 'lucide-react';
import Avatar from '@/Components/Avatar';
import { DailyColumns, Donut, Heatmap, LineChart, Ring, SegmentBar, Sparkline, useTip, TipRows } from './charts';
import DataTable from './DataTable';
import { BILLABLE, INTERNAL, TYPES, TYPE_KEYS, fmtHours, fmtPct, pct, shortDate, weekOf, dayName } from './model';

/* ---------------- building blocks ---------------- */

export function Panel({ title, subtitle, actions, children, className = '' }) {
    return (
        <section className={`flex min-w-0 flex-col rounded-2xl border border-slate-800 bg-slate-900 p-4 shadow-sm shadow-black/20 sm:p-5 ${className}`}>
            {(title || actions) && (
                <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h2 className="text-sm font-semibold text-white">{title}</h2>
                        {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
                    </div>
                    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
                </header>
            )}
            <div className="min-w-0 flex-1">{children}</div>
        </section>
    );
}

export function Segmented({ value, onChange, options, size = 'sm', label }) {
    return (
        <div role="group" aria-label={label} className="dark-scroll inline-flex max-w-full overflow-x-auto rounded-lg border border-slate-700 bg-slate-950/60 p-0.5">
            {options.map(([v, l]) => (
                <button
                    key={v}
                    type="button"
                    aria-pressed={value === v}
                    onClick={() => onChange(v)}
                    className={`shrink-0 whitespace-nowrap rounded-md px-2.5 ${size === 'sm' ? 'py-1 text-xs' : 'py-1.5 text-sm'} font-medium transition-colors ${value === v ? 'bg-slate-700 text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}
                >
                    {l}
                </button>
            ))}
        </div>
    );
}

function Delta({ now, before, unit = '%', invert = false, points = false }) {
    if (before === null || before === undefined) return <span className="text-[11px] text-slate-500">no earlier data</span>;
    const diff = points ? now - before : before > 0 ? ((now - before) / before) * 100 : null;
    if (diff === null) return <span className="text-[11px] text-slate-500">new this period</span>;
    const flat = Math.abs(diff) < 0.5;
    const good = invert ? diff < 0 : diff > 0;
    const Icon = flat ? Minus : diff > 0 ? ArrowUpRight : ArrowDownRight;
    return (
        <span className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${flat ? 'text-slate-400' : good ? 'text-emerald-400' : 'text-rose-400'}`}>
            <Icon className="h-3.5 w-3.5" />
            {flat ? 'same' : `${diff > 0 ? '+' : ''}${Math.round(diff)}${points ? ' pts' : unit}`}
            <span className="ml-1 font-normal text-slate-500">vs prev.</span>
        </span>
    );
}

function SharePill({ value, low }) {
    const cls = low ? 'bg-rose-500/15 text-rose-300 ring-rose-500/30' : value >= 75 ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' : 'bg-amber-500/10 text-amber-200 ring-amber-500/25';
    return <span className={`inline-flex min-w-[3rem] justify-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ring-1 ${cls}`}>{fmtPct(value)}</span>;
}

function TypeLegend({ keys = TYPE_KEYS }) {
    return (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
            {keys.map((k) => (
                <span key={k} className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: TYPES[k].color }} />
                    {TYPES[k].label}
                </span>
            ))}
        </div>
    );
}

const typeParts = (byType) => TYPE_KEYS.map((k) => ({ label: TYPES[k].label, value: byType[k] || 0, color: TYPES[k].color }));

/* ---------------- KPIs ---------------- */

export function KpiStrip({ ctx }) {
    const { agg, days, prev, scopePeople, isLow } = ctx;
    const share = pct(agg.billable, agg.total);
    const prevShare = prev.total > 0 ? pct(prev.billable, prev.total) : null;
    const logging = scopePeople.filter((u) => agg.byUser.has(u.id)).length;
    const personDays = [...agg.byUser.values()].reduce((s, u) => s + u.days.size, 0);
    const daily = (fn) => days.map((d) => fn(agg.byDay.get(d)));

    const tiles = [
        { label: 'Total hours', value: fmtHours(agg.total), delta: <Delta now={agg.total} before={prev.total || null} />, spark: daily((x) => (x ? x.billable + x.internal : 0)), color: '#e2e8f0' },
        { label: 'Billable hours', value: fmtHours(agg.billable), delta: <Delta now={agg.billable} before={prev.billable || null} />, spark: daily((x) => x?.billable || 0), color: BILLABLE },
        { label: 'Internal hours', value: fmtHours(agg.internal), delta: <Delta now={agg.internal} before={prev.total ? prev.total - prev.billable : null} invert />, spark: daily((x) => x?.internal || 0), color: INTERNAL },
    ];

    return (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <div className="flex items-center gap-4 rounded-2xl border border-slate-800 bg-gradient-to-br from-orange-500/10 via-slate-900/60 to-slate-900/60 p-4 sm:col-span-2 xl:col-span-1">
                <Ring value={share / 100} size={76} stroke={8} label={fmtPct(share)} sub="billable" color={isLow(share) ? '#fb7185' : BILLABLE} />
                <div className="min-w-0">
                    <div className="text-xs font-medium text-slate-400">Billable share</div>
                    <div className="mt-1">
                        <Delta now={share} before={prevShare} points />
                    </div>
                    <SegmentBar className="mt-2" height={6} parts={[{ label: 'Billable', value: agg.billable, color: BILLABLE }, { label: 'Internal', value: agg.internal, color: INTERNAL }]} />
                </div>
            </div>
            {tiles.map((t) => (
                <div key={t.label} className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
                        <span className="h-2 w-2 rounded-full" style={{ background: t.color }} />
                        {t.label}
                    </div>
                    <div className="mt-1 flex items-end justify-between gap-2">
                        <span className="text-2xl font-semibold tabular-nums tracking-tight text-white">{t.value}</span>
                        {t.delta}
                    </div>
                    <div className="mt-2">
                        <Sparkline values={t.spark} color={t.color} height={32} />
                    </div>
                </div>
            ))}
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
                <div className="text-xs font-medium text-slate-400">{ctx.scope.kind === 'person' ? 'Days worked' : 'People logging'}</div>
                {ctx.scope.kind === 'person' ? (
                    <>
                        <div className="mt-1 text-2xl font-semibold tabular-nums text-white">
                            {personDays}
                            <span className="ml-1 text-sm font-normal text-slate-500">days</span>
                        </div>
                        <div className="mt-2 text-xs text-slate-400">
                            <span className="font-semibold tabular-nums text-slate-200">{fmtHours(personDays ? agg.total / personDays : 0)} h</span> a day on average
                        </div>
                    </>
                ) : (
                    <>
                        <div className="mt-1 text-2xl font-semibold tabular-nums text-white">
                            {logging}
                            <span className="ml-1 text-sm font-normal text-slate-500">of {scopePeople.length}</span>
                        </div>
                        <div className="mt-2 text-xs text-slate-400">
                            <span className="font-semibold tabular-nums text-slate-200">{fmtHours(personDays ? agg.total / personDays : 0)} h</span> per person per working day
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

/* ---------------- flags ---------------- */

export function Flags({ ctx }) {
    const { agg, scopePeople, isLow, open, settings } = ctx;
    const people = scopePeople.map((u) => ({ u, a: agg.byUser.get(u.id) }));
    const counted = people.filter((p) => !settings.quietDepts.includes(p.u.department));
    const low = counted.filter((p) => p.a && p.a.total > 0 && isLow(pct(p.a.billable, p.a.total))).sort((a, b) => pct(a.a.billable, a.a.total) - pct(b.a.billable, b.a.total));
    const zero = counted.filter((p) => p.a && p.a.total > 0 && p.a.billable === 0);
    const silent = people.filter((p) => !p.a && p.u.active);

    const groups = [
        { key: 'low', title: `Under ${settings.lowShare}% billable`, tone: 'rose', list: low, metric: (p) => fmtPct(pct(p.a.billable, p.a.total)) },
        { key: 'zero', title: 'No billable hours', tone: 'amber', list: zero, metric: (p) => `${fmtHours(p.a.total)} h internal` },
        { key: 'silent', title: 'Logged nothing', tone: 'slate', list: silent, metric: () => '0 h' },
    ];
    const tones = { rose: 'text-rose-300 bg-rose-500/10 ring-rose-500/25', amber: 'text-amber-200 bg-amber-500/10 ring-amber-500/25', slate: 'text-slate-300 bg-slate-500/10 ring-slate-500/25' };

    return (
        <Panel title="Needs a look" subtitle={settings.quietDepts.length ? `Not counting ${settings.quietDepts.join(', ')} (internal by design)` : 'Click a person to open their summary'}>
            <div className="grid gap-4 lg:grid-cols-3">
                {groups.map((g) => (
                    <div key={g.key} className="min-w-0">
                        <div className="mb-2 flex items-center gap-2">
                            <span className={`rounded-md px-2 py-0.5 text-lg font-semibold tabular-nums ring-1 ${tones[g.tone]}`}>{g.list.length}</span>
                            <span className="text-sm font-medium text-slate-200">{g.title}</span>
                        </div>
                        <div className="dark-scroll flex max-h-40 flex-wrap gap-1.5 overflow-y-auto pr-1">
                            {g.list.map((p) => (
                                <button
                                    key={p.u.id}
                                    type="button"
                                    onClick={() => open({ kind: 'person', userId: p.u.id })}
                                    className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800/60 py-0.5 pl-0.5 pr-2.5 text-xs text-slate-200 hover:border-slate-500"
                                >
                                    <Avatar user={p.u} size="sm" className="!h-5 !w-5 border-slate-700 !text-[9px]" />
                                    <span className="max-w-[9rem] truncate">{p.u.name}</span>
                                    <span className="tabular-nums text-slate-400">{g.metric(p)}</span>
                                </button>
                            ))}
                            {!g.list.length && <span className="text-xs text-slate-500">Nobody — good.</span>}
                        </div>
                    </div>
                ))}
            </div>
        </Panel>
    );
}

/* ---------------- departments ---------------- */

export function Departments({ ctx }) {
    const { agg, days, people, isLow, open, prevByUser, settings } = ctx;
    const depts = useMemo(() => {
        const heads = new Map();
        people.forEach((u) => heads.set(u.department, (heads.get(u.department) || 0) + (u.active ? 1 : 0)));
        return [...new Set([...heads.keys(), ...agg.byDept.keys()])]
            .map((name) => {
                const d = agg.byDept.get(name) || { total: 0, billable: 0, people: new Set(), byType: {}, byDay: {} };
                const prev = people.filter((u) => u.department === name).reduce((s, u) => {
                    const p = prevByUser.get(u.id);
                    return p ? { total: s.total + p.total, billable: s.billable + p.billable } : s;
                }, { total: 0, billable: 0 });
                return { name, ...d, heads: heads.get(name) || 0, prev };
            })
            .filter((d) => d.total > 0 || d.heads > 0)
            .sort((a, b) => b.total - a.total);
    }, [agg, people, prevByUser]);

    return (
        <Panel title="Departments" subtitle="Click a department to see only its people">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {depts.map((d) => {
                    const share = pct(d.billable, d.total);
                    const quiet = settings.quietDepts.includes(d.name);
                    return (
                        <button
                            key={d.name}
                            type="button"
                            onClick={() => open({ kind: 'department', department: d.name })}
                            className="group flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-left transition hover:-translate-y-0.5 hover:border-slate-600 hover:bg-slate-900"
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-1 truncate font-semibold text-white">
                                        {d.name}
                                        <ChevronRight className="h-4 w-4 text-slate-600 transition group-hover:translate-x-0.5 group-hover:text-slate-300" />
                                    </div>
                                    <div className="text-xs text-slate-400">
                                        {d.people.size} of {d.heads} logging{quiet && ' · internal by design'}
                                    </div>
                                    <div className="mt-2 text-xl font-semibold tabular-nums text-white">
                                        {fmtHours(d.total)}
                                        <span className="ml-1 text-xs font-normal text-slate-500">h</span>
                                    </div>
                                    <Delta now={d.total} before={d.prev.total || null} />
                                </div>
                                <Ring value={share / 100} size={60} stroke={6} label={fmtPct(share)} color={quiet ? '#94a3b8' : isLow(share) ? '#fb7185' : BILLABLE} />
                            </div>
                            <SegmentBar parts={typeParts(d.byType)} height={6} />
                            <Sparkline values={days.map((x) => d.byDay[x] || 0)} color="#fb923c" height={28} />
                        </button>
                    );
                })}
            </div>
        </Panel>
    );
}

/* ---------------- trend ---------------- */

export function Trend({ ctx }) {
    const { agg, days } = ctx;
    const [mode, setMode] = useState('split');
    const series =
        mode === 'split'
            ? [
                  { key: 'b', label: 'Billable', color: BILLABLE, values: Object.fromEntries(days.map((d) => [d, agg.byDay.get(d)?.billable || 0])) },
                  { key: 'i', label: 'Internal', color: INTERNAL, values: Object.fromEntries(days.map((d) => [d, agg.byDay.get(d)?.internal || 0])) },
              ].reverse()
            : [...TYPE_KEYS].reverse().map((k) => ({ key: k, label: TYPES[k].label, color: TYPES[k].color, values: Object.fromEntries(days.map((d) => [d, agg.byDay.get(d)?.byType[k] || 0])) }));

    return (
        <Panel
            title="Hours per day"
            subtitle={mode === 'split' ? 'Billable on top of internal' : 'Split by work type'}
            actions={<Segmented label="Split hours by" value={mode} onChange={setMode} options={[['split', 'Billable / internal'], ['types', 'Work types']]} />}
        >
            <DailyColumns days={days} series={series} height={250} />
            <div className="mt-2">
                {mode === 'split' ? (
                    <div className="flex gap-4 text-[11px] text-slate-400">
                        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: BILLABLE }} />Billable</span>
                        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: INTERNAL }} />Internal</span>
                    </div>
                ) : (
                    <TypeLegend />
                )}
            </div>
        </Panel>
    );
}

/* ---------------- mix ---------------- */

export function Mix({ ctx }) {
    const { agg } = ctx;
    const row = (k) => {
        const v = agg.byType[k] || 0;
        return (
            <div key={k} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
                <span className="flex items-center gap-2 text-xs text-slate-300">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: TYPES[k].color }} />
                    {TYPES[k].label}
                </span>
                <span className="text-xs tabular-nums text-slate-200">
                    {fmtHours(v)} h <span className="text-slate-500">· {fmtPct(pct(v, agg.total))}</span>
                </span>
                <div className="col-span-2 h-1 overflow-hidden rounded-full bg-slate-800">
                    <div className="h-full rounded-full" style={{ width: `${pct(v, agg.total)}%`, background: TYPES[k].color }} />
                </div>
            </div>
        );
    };
    return (
        <Panel title="Work type mix" subtitle="Where the hours went">
            <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
                <Donut parts={typeParts(agg.byType)} centerLabel={fmtHours(agg.total)} centerSub="hours" size={156} stroke={16} />
                <div className="w-full min-w-0 space-y-4">
                    <div className="space-y-2">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-orange-300/80">Billable · {fmtHours(agg.billable)} h</div>
                        {TYPE_KEYS.filter((k) => TYPES[k].billable).map(row)}
                    </div>
                    <div className="space-y-2">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-sky-300/80">Internal · {fmtHours(agg.internal)} h</div>
                        {TYPE_KEYS.filter((k) => !TYPES[k].billable).map(row)}
                    </div>
                </div>
            </div>
        </Panel>
    );
}

/* ---------------- people ---------------- */

export function People({ ctx }) {
    const { agg, scopePeople, isLow, open, settings } = ctx;
    const [order, setOrder] = useState('share');
    const [showAll, setShowAll] = useState(false);
    const tip = useTip();
    const list = scopePeople
        .map((u) => ({ u, a: agg.byUser.get(u.id) }))
        .filter((p) => p.a)
        .map((p) => ({ ...p, share: pct(p.a.billable, p.a.total) }))
        .sort((a, b) => (order === 'share' ? a.share - b.share : order === 'hours' ? b.a.total - a.a.total : a.u.name.localeCompare(b.u.name)));
    const max = Math.max(1, ...list.map((p) => p.a.total));
    const shown = showAll ? list : list.slice(0, 12);

    return (
        <Panel
            title="People"
            subtitle="Bar length = hours logged; orange part is billable"
            actions={<Segmented label="Sort people" value={order} onChange={setOrder} options={[['share', 'Lowest billable %'], ['hours', 'Most hours'], ['name', 'A–Z']]} />}
        >
            <ul className="space-y-1">
                {shown.map(({ u, a, share }) => {
                    const quiet = settings.quietDepts.includes(u.department);
                    return (
                        <li key={u.id}>
                            <button
                                type="button"
                                onClick={() => open({ kind: 'person', userId: u.id })}
                                className="grid w-full grid-cols-[minmax(0,11rem)_1fr_auto_auto] items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-slate-800/60"
                            >
                                <span className="flex min-w-0 items-center gap-2">
                                    <Avatar user={u} size="sm" className="!h-7 !w-7 border-slate-700" />
                                    <span className="min-w-0">
                                        <span className="block truncate text-sm text-slate-100">{u.name}</span>
                                        <span className="block truncate text-[11px] text-slate-500">{u.department}</span>
                                    </span>
                                </span>
                                <span
                                    className="flex h-2.5 overflow-hidden rounded-full bg-slate-800/80"
                                    onMouseMove={(e) => tip.show(<TipRows title={u.name} rows={[['Billable', `${fmtHours(a.billable)} h`, BILLABLE], ['Internal', `${fmtHours(a.total - a.billable)} h`, INTERNAL], ['Days', a.days.size]]} />, e)}
                                    onMouseLeave={tip.hide}
                                >
                                    <span className="flex h-full" style={{ width: `${(a.total / max) * 100}%` }}>
                                        <span className="h-full" style={{ width: `${share}%`, background: `linear-gradient(90deg, #f97316, #fbbf24)` }} />
                                        <span className="h-full flex-1" style={{ background: INTERNAL, opacity: 0.75 }} />
                                    </span>
                                </span>
                                <span className="w-14 text-right text-xs tabular-nums text-slate-300">{fmtHours(a.total)} h</span>
                                <SharePill value={share} low={!quiet && isLow(share)} />
                            </button>
                        </li>
                    );
                })}
            </ul>
            {list.length > 12 && (
                <button type="button" onClick={() => setShowAll(!showAll)} className="mt-2 text-xs font-medium text-orange-300 hover:text-orange-200">
                    {showAll ? 'Show fewer' : `Show all ${list.length} people`}
                </button>
            )}
            {!list.length && <p className="text-sm text-slate-500">Nobody logged hours in this period.</p>}
        </Panel>
    );
}

/* ---------------- clients ---------------- */

export function Clients({ ctx }) {
    const { agg, clients } = ctx;
    const [showAll, setShowAll] = useState(false);
    const tip = useTip();
    const list = [...agg.byClient.entries()].map(([id, c]) => ({ id, name: clients[id] ?? `Client #${id}`, ...c })).sort((a, b) => b.total - a.total);
    const max = Math.max(1, ...list.map((c) => c.total));
    const shown = showAll ? list : list.slice(0, 10);

    return (
        <Panel title={ctx.scope.kind === 'person' ? 'Hours by client' : 'Top clients'} subtitle={`${list.length} clients · billable hours only`}>
            <ul className="space-y-2.5">
                {shown.map((c) => (
                    <li
                        key={c.id}
                        onMouseMove={(e) => tip.show(<TipRows title={c.name} rows={[...TYPE_KEYS.filter((k) => c.byType[k]).map((k) => [TYPES[k].label, `${fmtHours(c.byType[k])} h`, TYPES[k].color]), ['People', c.people.size]]} />, e)}
                        onMouseLeave={tip.hide}
                    >
                        <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                            <span className="truncate text-slate-200">{c.name}</span>
                            <span className="shrink-0 tabular-nums text-slate-400">
                                <span className="font-semibold text-slate-100">{fmtHours(c.total)} h</span> · {fmtPct(pct(c.total, agg.billable))}
                                {ctx.scope.kind !== 'person' && ` · ${c.people.size} ${c.people.size === 1 ? 'person' : 'people'}`}
                            </span>
                        </div>
                        <div className="flex h-2 overflow-hidden rounded-full bg-slate-800/80">
                            <span className="flex h-full" style={{ width: `${(c.total / max) * 100}%` }}>
                                {TYPE_KEYS.filter((k) => c.byType[k]).map((k) => (
                                    <span key={k} className="h-full" style={{ width: `${(c.byType[k] / c.total) * 100}%`, background: TYPES[k].color }} />
                                ))}
                            </span>
                        </div>
                    </li>
                ))}
            </ul>
            {list.length > 10 && (
                <button type="button" onClick={() => setShowAll(!showAll)} className="mt-3 text-xs font-medium text-orange-300 hover:text-orange-200">
                    {showAll ? 'Show top 10' : `Show all ${list.length} clients`}
                </button>
            )}
            {!list.length && <p className="text-sm text-slate-500">No billable client hours in this period.</p>}
        </Panel>
    );
}

/* ---------------- weekly billable % ---------------- */

const LINE_COLORS = ['#38bdf8', '#a78bfa', '#34d399', '#f472b6', '#facc15', '#2dd4bf', '#f87171', '#c084fc', '#94a3b8'];

export function Weekly({ ctx }) {
    const { rows, weeks, users, scope, settings } = ctx;
    const bucket = (filter) =>
        weeks.map((w) => {
            let t = 0;
            let b = 0;
            for (const r of rows) {
                if (weekOf(r[1]) !== w || !filter(r)) continue;
                t += r[4];
                if (TYPES[r[2]]?.billable) b += r[4];
            }
            return t > 0 ? pct(b, t) : null;
        });
    const labels = weeks.map((w) => `wk ${shortDate(w)}`);
    let series;
    if (scope.kind === 'company') {
        const depts = [...new Set(rows.map((r) => users.get(r[0])?.department ?? 'Unassigned'))].filter((d) => !settings.quietDepts.includes(d)).sort();
        series = [
            { label: 'Whole company', color: BILLABLE, bold: true, values: bucket(() => true) },
            ...depts.map((d, i) => ({ label: d, color: LINE_COLORS[i % LINE_COLORS.length], values: bucket((r) => (users.get(r[0])?.department ?? 'Unassigned') === d) })),
        ];
    } else {
        series = [{ label: scope.kind === 'person' ? users.get(scope.userId)?.name : scope.department, color: BILLABLE, bold: true, values: bucket(() => true) }];
    }

    return (
        <Panel title="Billable % by week" subtitle={scope.kind === 'company' ? 'Company line in orange; each department beside it' : 'Share of hours charged to clients, week by week'}>
            <LineChart labels={labels} series={series} max={100} unit="%" height={220} />
            {series.length > 1 && (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
                    {series.map((s) => (
                        <span key={s.label} className="inline-flex items-center gap-1.5">
                            <span className="h-0.5 w-3 rounded" style={{ background: s.color }} />
                            {s.label}
                        </span>
                    ))}
                </div>
            )}
        </Panel>
    );
}

/* ---------------- heatmap ---------------- */

export function DayGrid({ ctx }) {
    const { agg, days, scopePeople, scope, open } = ctx;
    if (scope.kind === 'person') {
        const rows = TYPE_KEYS.map((k) => ({ id: k, label: TYPES[k].label, values: Object.fromEntries(days.map((d) => [d, agg.byDay.get(d)?.byType[k] || 0])) })).filter((r) => Object.values(r.values).some(Boolean));
        return (
            <Panel title="Day by day" subtitle="Hours per work type on each day">
                <Heatmap days={days} rows={rows} />
            </Panel>
        );
    }
    const rows = scopePeople
        .filter((u) => agg.byUser.has(u.id))
        .map((u) => ({ id: u.id, label: u.name, values: agg.byUser.get(u.id).byDay }))
        .sort((a, b) => a.label.localeCompare(b.label));
    return (
        <Panel title="Who logged what, day by day" subtitle="Darker = more hours. Gaps show days with nothing logged">
            <Heatmap days={days} rows={rows} onPickRow={(id) => open({ kind: 'person', userId: id })} />
        </Panel>
    );
}

/* ---------------- tables ---------------- */

const typeColumns = (get, onlyBillable = false) =>
    TYPE_KEYS.filter((k) => !onlyBillable || TYPES[k].billable).map((k) => ({
        id: `t_${k}`,
        label: TYPES[k].short,
        dot: TYPES[k].color,
        group: TYPES[k].billable ? 'Billable work types' : 'Internal work types',
        align: 'right',
        value: (r) => get(r)[k] || 0,
        render: (r) => (get(r)[k] ? fmtHours(get(r)[k]) : <span className="text-slate-600">–</span>),
        footer: (rs) => fmtHours(rs.reduce((s, r) => s + (get(r)[k] || 0), 0)),
    }));

const totalsColumns = (isLow, quiet = () => false) => [
    { id: 'billable', label: 'Billable', group: 'Totals', align: 'right', value: (r) => r.billable, render: (r) => <span className="text-orange-200">{fmtHours(r.billable)}</span>, footer: (rs) => fmtHours(rs.reduce((s, r) => s + r.billable, 0)) },
    { id: 'internal', label: 'Internal', group: 'Totals', align: 'right', value: (r) => r.total - r.billable, render: (r) => <span className="text-sky-200">{fmtHours(r.total - r.billable)}</span>, footer: (rs) => fmtHours(rs.reduce((s, r) => s + r.total - r.billable, 0)) },
    { id: 'total', label: 'Total', group: 'Totals', align: 'right', value: (r) => r.total, render: (r) => <span className="font-semibold text-white">{fmtHours(r.total)}</span>, footer: (rs) => fmtHours(rs.reduce((s, r) => s + r.total, 0)) },
    {
        id: 'share',
        label: 'Billable %',
        group: 'Totals',
        align: 'right',
        value: (r) => pct(r.billable, r.total),
        csv: (r) => Math.round(pct(r.billable, r.total)),
        render: (r) => (
            <span className="inline-flex items-center justify-end gap-2">
                <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-slate-800 2xl:inline-block">
                    <span className="block h-full rounded-full bg-gradient-to-r from-orange-500 to-amber-400" style={{ width: `${pct(r.billable, r.total)}%` }} />
                </span>
                <SharePill value={pct(r.billable, r.total)} low={!quiet(r) && isLow(pct(r.billable, r.total))} />
            </span>
        ),
        footer: (rs) => {
            const t = rs.reduce((s, r) => s + r.total, 0);
            return fmtPct(pct(rs.reduce((s, r) => s + r.billable, 0), t));
        },
    },
];

export function TeamTable({ ctx }) {
    const { agg, scopePeople, isLow, open, clients, prevByUser, tableConfig, setTableConfig, settings, scope } = ctx;
    const cfg = tableConfig('team');
    const by = cfg.by ?? 'person';
    const quiet = (r) => settings.quietDepts.includes(r.department);

    let rows;
    let columns;
    if (by === 'department') {
        rows = [...agg.byDept.entries()].map(([name, d]) => ({ key: name, name, department: name, total: d.total, billable: d.billable, byType: d.byType, people: d.people.size, days: Object.keys(d.byDay).length }));
        columns = [
            { id: 'name', label: 'Department', sticky: true, hideable: false, searchable: true, value: (r) => r.name, render: (r) => <button type="button" onClick={() => open({ kind: 'department', department: r.name })} className="font-medium text-slate-100 hover:text-orange-300">{r.name}</button>, footer: 'Total' },
            { id: 'people', label: 'People', group: 'Details', align: 'right', value: (r) => r.people },
            { id: 'avg', label: 'Avg h / person', group: 'Details', align: 'right', value: (r) => (r.people ? r.total / r.people : 0), render: (r) => fmtHours(r.people ? r.total / r.people : 0) },
            ...typeColumns((r) => r.byType),
            ...totalsColumns(isLow, quiet),
        ];
    } else if (by === 'client') {
        rows = [...agg.byClient.entries()].map(([id, c]) => ({ key: id, name: clients[id] ?? `Client #${id}`, total: c.total, billable: c.total, byType: c.byType, people: c.people.size, days: Object.keys(c.byDay).length }));
        columns = [
            { id: 'name', label: 'Client', sticky: true, hideable: false, searchable: true, value: (r) => r.name, render: (r) => <span className="text-slate-100">{r.name}</span>, footer: 'Total' },
            { id: 'people', label: 'People', group: 'Details', align: 'right', value: (r) => r.people },
            { id: 'days', label: 'Days worked', group: 'Details', align: 'right', value: (r) => r.days },
            ...typeColumns((r) => r.byType, true),
            { id: 'total', label: 'Total', group: 'Totals', align: 'right', value: (r) => r.total, render: (r) => <span className="font-semibold text-white">{fmtHours(r.total)}</span>, footer: (rs) => fmtHours(rs.reduce((s, r) => s + r.total, 0)) },
            { id: 'cshare', label: 'Share of billable', group: 'Totals', align: 'right', value: (r) => pct(r.total, agg.billable), render: (r) => fmtPct(pct(r.total, agg.billable)), csv: (r) => Math.round(pct(r.total, agg.billable)) },
        ];
    } else {
        rows = scopePeople
            .filter((u) => agg.byUser.has(u.id) || cfg.showSilent)
            .map((u) => {
                const a = agg.byUser.get(u.id) || { total: 0, billable: 0, days: new Set(), byType: {} };
                const p = prevByUser.get(u.id);
                return { key: u.id, user: u, name: u.name, department: u.department, designation: u.designation, total: a.total, billable: a.billable, byType: a.byType, days: a.days.size, prevTotal: p?.total ?? null };
            });
        columns = [
            {
                id: 'name',
                label: 'Person',
                sticky: true,
                hideable: false,
                searchable: true,
                value: (r) => r.name,
                render: (r) => (
                    <button type="button" onClick={() => open({ kind: 'person', userId: r.user.id })} className="flex items-center gap-2 text-left hover:text-orange-300">
                        <Avatar user={r.user} size="sm" className="!h-6 !w-6 border-slate-700 !text-[10px]" />
                        <span className="font-medium text-slate-100">{r.name}</span>
                    </button>
                ),
                footer: 'Total',
            },
            { id: 'department', label: 'Department', group: 'Details', value: (r) => r.department, render: (r) => <span className="text-slate-400">{r.department}</span>, defaultHidden: scope.kind === 'department' },
            { id: 'designation', label: 'Designation', group: 'Details', value: (r) => r.designation ?? '', render: (r) => <span className="text-slate-400">{r.designation ?? '—'}</span>, defaultHidden: true },
            { id: 'days', label: 'Days', group: 'Details', align: 'right', value: (r) => r.days },
            { id: 'avg', label: 'Avg h / day', group: 'Details', align: 'right', value: (r) => (r.days ? r.total / r.days : 0), render: (r) => fmtHours(r.days ? r.total / r.days : 0) },
            ...typeColumns((r) => r.byType),
            ...totalsColumns(isLow, quiet),
            {
                id: 'vsprev',
                label: 'vs prev. period',
                group: 'Totals',
                align: 'right',
                defaultHidden: true,
                value: (r) => (r.prevTotal ? ((r.total - r.prevTotal) / r.prevTotal) * 100 : null),
                render: (r) => <Delta now={r.total} before={r.prevTotal} />,
                csv: (r) => (r.prevTotal ? Math.round(((r.total - r.prevTotal) / r.prevTotal) * 100) : ''),
            },
        ];
    }

    return (
        <Panel title="Hours table" subtitle="The pivot you used to build in Excel. Choose rows, hide columns, sort, export.">
            <DataTable
                key={by}
                columns={columns}
                rows={rows}
                config={cfg[by] ?? {}}
                onConfig={(next) => setTableConfig('team', { ...cfg, [by]: next })}
                filename={`summary-by-${by}-${ctx.start}-to-${ctx.end}`}
                searchPlaceholder={`Search ${by === 'person' ? 'people' : by === 'client' ? 'clients' : 'departments'}…`}
                toolbar={
                    <>
                        <Segmented
                            label="One row per"
                            value={by}
                            onChange={(v) => setTableConfig('team', { ...cfg, by: v })}
                            options={scope.kind === 'company' ? [['person', 'Person'], ['department', 'Department'], ['client', 'Client']] : [['person', 'Person'], ['client', 'Client']]}
                        />
                        {by === 'person' && (
                            <label className="inline-flex items-center gap-2 text-xs text-slate-400">
                                <input type="checkbox" checked={!!cfg.showSilent} onChange={(e) => setTableConfig('team', { ...cfg, showSilent: e.target.checked })} className="rounded border-slate-600 bg-slate-800 text-orange-500 focus:ring-orange-500/40" />
                                Include people with 0 h
                            </label>
                        )}
                    </>
                }
            />
        </Panel>
    );
}

export function PersonTable({ ctx }) {
    const { rows: raw, days, weeks, clients, tableConfig, setTableConfig } = ctx;
    const cfg = tableConfig('person');
    const cols = cfg.cols ?? (days.length > 14 ? 'week' : 'day');
    const buckets = cols === 'week' ? weeks : days;
    const bucketOf = (d) => (cols === 'week' ? weekOf(d) : d);

    const map = new Map();
    for (const [, d, t, cid, h] of raw) {
        const bill = TYPES[t]?.billable;
        const key = bill && cid ? `c${cid}` : `t${t}`;
        let row = map.get(key);
        if (!row) {
            row = { key, name: bill && cid ? clients[cid] ?? `Client #${cid}` : TYPES[t]?.label ?? t, kind: bill ? 'Billable' : 'Internal', color: TYPES[t]?.color, cells: {}, total: 0, billable: 0 };
            map.set(key, row);
        }
        row.cells[bucketOf(d)] = (row.cells[bucketOf(d)] || 0) + h;
        row.total += h;
        if (bill) row.billable += h;
    }
    const rows = [...map.values()];

    const columns = [
        {
            id: 'name',
            label: 'Client / work',
            sticky: true,
            hideable: false,
            searchable: true,
            value: (r) => r.name,
            render: (r) => (
                <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ background: r.kind === 'Billable' ? BILLABLE : INTERNAL }} />
                    <span className="text-slate-100">{r.name}</span>
                </span>
            ),
            footer: 'Total',
        },
        { id: 'kind', label: 'Type', group: 'Details', value: (r) => r.kind, render: (r) => <span className={r.kind === 'Billable' ? 'text-orange-200' : 'text-sky-200'}>{r.kind}</span> },
        ...buckets.map((b) => ({
            id: `b_${b}`,
            label: cols === 'week' ? `Wk ${shortDate(b)}` : `${dayName(b)} ${shortDate(b)}`,
            group: cols === 'week' ? 'Weeks' : 'Days',
            align: 'right',
            value: (r) => r.cells[b] || 0,
            render: (r) => (r.cells[b] ? fmtHours(r.cells[b]) : <span className="text-slate-600">–</span>),
            footer: (rs) => fmtHours(rs.reduce((s, r) => s + (r.cells[b] || 0), 0)),
        })),
        { id: 'total', label: 'Total', group: 'Totals', align: 'right', value: (r) => r.total, render: (r) => <span className="font-semibold text-white">{fmtHours(r.total)}</span>, footer: (rs) => fmtHours(rs.reduce((s, r) => s + r.total, 0)) },
    ];

    return (
        <Panel title="Hours table" subtitle="Each client (and internal work) against each day or week">
            <DataTable
                key={cols}
                columns={columns}
                rows={rows}
                config={{ sort: { id: 'total', dir: 'desc' }, ...(cfg[cols] ?? {}) }}
                onConfig={(next) => setTableConfig('person', { ...cfg, [cols]: next })}
                filename={`summary-${ctx.users.get(ctx.scope.userId)?.name ?? 'person'}-${ctx.start}-to-${ctx.end}`}
                searchPlaceholder="Search clients…"
                toolbar={<Segmented label="Columns are" value={cols} onChange={(v) => setTableConfig('person', { ...cfg, cols: v })} options={[['day', 'Days'], ['week', 'Weeks']]} />}
            />
        </Panel>
    );
}

/* ---------------- person header ---------------- */

export function PersonHeader({ ctx }) {
    const { users, scope, agg, deptAgg, isLow, open } = ctx;
    const u = users.get(scope.userId);
    if (!u) return null;
    const share = pct(agg.billable, agg.total);
    const deptShare = pct(deptAgg.billable, deptAgg.total);
    const ranked = [...deptAgg.byUser.entries()].sort((a, b) => b[1].billable - a[1].billable).map(([id]) => id);
    const rank = ranked.indexOf(u.id) + 1;

    return (
        <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-slate-800 bg-gradient-to-r from-slate-900 via-slate-900/70 to-orange-950/30 p-4 sm:p-5">
            <Avatar user={u} size="lg" className="border-slate-700" />
            <div className="min-w-0 flex-1">
                <h2 className="truncate text-xl font-semibold text-white">{u.name}</h2>
                <p className="text-sm text-slate-400">
                    {u.designation ?? 'No designation'} ·{' '}
                    <button type="button" className="text-orange-300 hover:text-orange-200" onClick={() => open({ kind: 'department', department: u.department })}>
                        {u.department}
                    </button>
                    {!u.active && <span className="ml-2 rounded bg-slate-700 px-1.5 py-0.5 text-[11px] text-slate-300">Archived</span>}
                </p>
            </div>
            <div className="flex flex-wrap gap-6 text-sm">
                <div>
                    <div className="text-xs text-slate-400">Billable share</div>
                    <div className={`text-lg font-semibold tabular-nums ${isLow(share) ? 'text-rose-300' : 'text-white'}`}>{fmtPct(share)}</div>
                </div>
                <div>
                    <div className="text-xs text-slate-400">{u.department} average</div>
                    <div className="text-lg font-semibold tabular-nums text-white">{fmtPct(deptShare)}</div>
                </div>
                {rank > 0 && (
                    <div>
                        <div className="text-xs text-slate-400">Billable hours rank</div>
                        <div className="text-lg font-semibold tabular-nums text-white">
                            #{rank}
                            <span className="ml-1 text-sm font-normal text-slate-500">of {ranked.length}</span>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
