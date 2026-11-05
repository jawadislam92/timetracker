import { useEffect, useState } from 'react';
import { BarChart3, TrendingUp, PieChart as PieIcon, Loader2 } from 'lucide-react';
import MultiTypeChart from './MultiTypeChart';

const TYPE_META = {
    bar: { icon: BarChart3, label: 'Bars' },
    line: { icon: TrendingUp, label: 'Line' },
    doughnut: { icon: PieIcon, label: 'Donut' },
    pie: { icon: PieIcon, label: 'Pie' },
};

/**
 * A titled card that wraps a MultiTypeChart with a small segmented control to
 * switch chart type. Only the chart's `allowedTypes` are offered (nonsensical
 * types are never shown), the chosen type persists per-chart in localStorage,
 * and switching never refetches — the caller passes a ready dataset for the
 * active type (typically chosen with a useMemo on the current type).
 *
 * @param {string} chartKey         stable name; used for the localStorage key
 * @param {string[]} allowedTypes   subset of ['bar','line','doughnut','pie']
 * @param {(type:string)=>object} buildData  returns Chart.js data for a type
 * @param {(type:string)=>object} [buildOptions]  returns Chart.js options for a type
 */
export default function SwitchableChartCard({
    title,
    subtitle,
    chartKey,
    allowedTypes = ['bar'],
    defaultType,
    buildData,
    buildOptions,
    loading = false,
    isEmpty = false,
    height = 280,
    actions = null,
    onSelect = null,
}) {
    const storageKey = `satrack.chart.${chartKey}.type`;
    const fallback = defaultType && allowedTypes.includes(defaultType) ? defaultType : allowedTypes[0];

    const [type, setType] = useState(() => {
        try {
            const saved = localStorage.getItem(storageKey);
            return saved && allowedTypes.includes(saved) ? saved : fallback;
        } catch {
            return fallback;
        }
    });

    useEffect(() => {
        try {
            localStorage.setItem(storageKey, type);
        } catch {
            // ignore (private mode etc.)
        }
    }, [storageKey, type]);

    return (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
                    {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
                </div>
                <div className="flex items-center gap-2">
                    {actions}
                    {allowedTypes.length > 1 && (
                        <div className="flex rounded-lg border border-slate-700 bg-slate-800/60 p-0.5">
                            {allowedTypes.map((t) => {
                                const Meta = TYPE_META[t] || TYPE_META.bar;
                                const Icon = Meta.icon;
                                const active = t === type;
                                return (
                                    <button
                                        key={t}
                                        type="button"
                                        onClick={() => setType(t)}
                                        aria-label={`Show as ${Meta.label}`}
                                        aria-pressed={active}
                                        className={`flex h-7 w-7 items-center justify-center rounded-md transition ${
                                            active ? 'bg-orange-500/20 text-orange-300' : 'text-slate-400 hover:text-slate-200'
                                        }`}
                                    >
                                        <Icon className="h-4 w-4" />
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {loading ? (
                <div className="flex items-center justify-center text-slate-500" style={{ height }}>
                    <Loader2 className="h-5 w-5 animate-spin" />
                </div>
            ) : isEmpty ? (
                <div className="flex items-center justify-center text-sm text-slate-500" style={{ height }}>
                    No data for this range.
                </div>
            ) : (
                <MultiTypeChart
                    type={type}
                    allowedTypes={allowedTypes}
                    data={buildData(type)}
                    options={buildOptions ? buildOptions(type) : {}}
                    height={height}
                    onSelect={onSelect}
                />
            )}
        </div>
    );
}
