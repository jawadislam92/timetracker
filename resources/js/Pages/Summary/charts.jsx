import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { BILLABLE, INTERNAL, fmtHours, isWeekend, longDate, shortDate, dayName } from './model';

/* ---------------- shared tooltip ---------------- */

const TipContext = createContext(() => {});
export const useTip = () => useContext(TipContext);

/** One floating tooltip for the whole page; charts call show(content, event) / hide(). */
export function TooltipProvider({ children }) {
    const [tip, setTip] = useState(null);
    const api = useRef({
        show: (content, e) => setTip({ content, x: e.clientX, y: e.clientY }),
        hide: () => setTip(null),
    }).current;
    const ref = useRef(null);
    const [pos, setPos] = useState({ left: 0, top: 0 });

    useLayoutEffect(() => {
        if (!tip || !ref.current) return;
        const r = ref.current.getBoundingClientRect();
        let left = tip.x + 14;
        let top = tip.y + 14;
        if (left + r.width > window.innerWidth - 8) left = tip.x - r.width - 14;
        if (top + r.height > window.innerHeight - 8) top = tip.y - r.height - 14;
        setPos({ left: Math.max(8, left), top: Math.max(8, top) });
    }, [tip]);

    return (
        <TipContext.Provider value={api}>
            {children}
            {tip && (
                <div
                    ref={ref}
                    role="tooltip"
                    className="pointer-events-none fixed z-[70] min-w-40 rounded-lg border border-slate-700/80 bg-slate-900/95 px-3 py-2 text-xs text-slate-200 shadow-2xl shadow-black/50 backdrop-blur"
                    style={pos}
                >
                    {tip.content}
                </div>
            )}
        </TipContext.Provider>
    );
}

export function TipRows({ title, rows }) {
    return (
        <div className="space-y-1">
            {title && <div className="font-semibold text-white">{title}</div>}
            {rows.map(([label, value, color]) => (
                <div key={label} className="flex items-center justify-between gap-4">
                    <span className="flex items-center gap-1.5 text-slate-400">
                        {color && <span className="h-2 w-2 rounded-full" style={{ background: color }} />}
                        {label}
                    </span>
                    <span className="font-medium tabular-nums text-slate-100">{value}</span>
                </div>
            ))}
        </div>
    );
}

/* ---------------- sizing ---------------- */

export function useWidth() {
    const ref = useRef(null);
    const [width, setWidth] = useState(0);
    useEffect(() => {
        if (!ref.current) return undefined;
        const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
        ro.observe(ref.current);
        return () => ro.disconnect();
    }, []);
    return [ref, width];
}

/** Top of a 4-step axis whose ticks are whole, round numbers (0, 60, 120, 180, 240). */
function niceMax(v) {
    if (v <= 4) return 4;
    const raw = v / 4;
    const p = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((n) => n * p).find((x) => x >= raw && (x >= 1 ? Number.isInteger(x) : true)) ?? 10 * p;
    return step * 4;
}

/* ---------------- sparkline ---------------- */

export function Sparkline({ values, color = BILLABLE, height = 36 }) {
    const id = useId().replace(/:/g, '');
    const [ref, width] = useWidth();
    const max = Math.max(...values, 0.0001);
    const n = values.length;
    const pts = values.map((v, i) => [n > 1 ? (i / (n - 1)) * (width - 4) + 2 : width / 2, height - 3 - (v / max) * (height - 8)]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    const last = pts[pts.length - 1];

    return (
        <div ref={ref} className="w-full" style={{ height }}>
            {width > 0 && n > 0 && (
                <svg width={width} height={height} aria-hidden="true">
                    <defs>
                        <linearGradient id={`sg${id}`} x1="0" x2="0" y1="0" y2="1">
                            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
                            <stop offset="100%" stopColor={color} stopOpacity="0" />
                        </linearGradient>
                    </defs>
                    <path d={`${line}L${last[0]},${height}L${pts[0][0]},${height}Z`} fill={`url(#sg${id})`} />
                    <path d={line} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
                    <circle cx={last[0]} cy={last[1]} r="2.75" fill={color} stroke="#0f172a" strokeWidth="1.5" />
                </svg>
            )}
        </div>
    );
}

/* ---------------- ring ---------------- */

export function Ring({ value, size = 64, stroke = 7, color = BILLABLE, track = 'rgba(56,189,248,0.22)', label, sub }) {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const v = Math.max(0, Math.min(1, value || 0));
    return (
        <div className="relative shrink-0" style={{ width: size, height: size }}>
            <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
                <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={r}
                    fill="none"
                    stroke={color}
                    strokeWidth={stroke}
                    strokeLinecap="round"
                    strokeDasharray={`${c * v} ${c}`}
                    style={{ transition: 'stroke-dasharray 500ms ease' }}
                />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
                <span className="text-sm font-semibold tabular-nums text-white">{label}</span>
                {sub && <span className="mt-0.5 text-[10px] text-slate-400">{sub}</span>}
            </div>
        </div>
    );
}

/* ---------------- segmented bar ---------------- */

export function SegmentBar({ parts, height = 8, className = '' }) {
    const tip = useTip();
    const total = parts.reduce((s, p) => s + p.value, 0);
    return (
        <div className={`flex w-full overflow-hidden rounded-full bg-slate-800 ${className}`} style={{ height }}>
            {total > 0 &&
                parts
                    .filter((p) => p.value > 0)
                    .map((p) => (
                        <div
                            key={p.label}
                            className="h-full transition-[width] duration-500 first:rounded-l-full last:rounded-r-full"
                            style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
                            onMouseMove={(e) => tip.show(<TipRows rows={[[p.label, `${fmtHours(p.value)} h · ${Math.round((p.value / total) * 100)}%`, p.color]]} />, e)}
                            onMouseLeave={tip.hide}
                        />
                    ))}
        </div>
    );
}

/* ---------------- daily stacked columns ---------------- */

/**
 * Billable stacked on internal per day, rounded caps, faint grid, weekend
 * columns shaded. `series` = [{key,label,color,values:{day:hours}}].
 */
export function DailyColumns({ days, series, height = 240, onPick }) {
    const tip = useTip();
    const [ref, width] = useWidth();
    const padL = 36;
    const padB = 26;
    const padT = 8;
    const totals = days.map((d) => series.reduce((s, x) => s + (x.values[d] || 0), 0));
    const max = niceMax(Math.max(...totals, 0));
    const plotW = Math.max(0, width - padL - 4);
    const plotH = height - padB - padT;
    const step = days.length ? plotW / days.length : 0;
    const barW = Math.max(3, Math.min(34, step * 0.62));
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
    const labelEvery = Math.ceil(days.length / Math.max(1, Math.floor(plotW / 46)));

    return (
        <div ref={ref} className="w-full" style={{ height }}>
            {width > 0 && (
                <svg width={width} height={height} role="img" aria-label="Hours per day">
                    {ticks.map((t) => {
                        const y = padT + plotH - (t / max) * plotH;
                        return (
                            <g key={t}>
                                <line x1={padL} x2={width} y1={y} y2={y} stroke="rgba(148,163,184,0.12)" strokeDasharray={t ? '3 4' : ''} />
                                <text x={padL - 8} y={y + 3.5} textAnchor="end" className="fill-slate-500 text-[10px] tabular-nums">
                                    {fmtHours(t)}
                                </text>
                            </g>
                        );
                    })}
                    {days.map((d, i) => {
                        const x = padL + i * step + (step - barW) / 2;
                        let y = padT + plotH;
                        const segs = series.map((s) => {
                            const v = s.values[d] || 0;
                            const h = (v / max) * plotH;
                            y -= h;
                            return { ...s, v, y, h };
                        });
                        const top = segs.filter((s) => s.h > 0).at(-1);
                        return (
                            <g
                                key={d}
                                className={onPick ? 'cursor-pointer' : ''}
                                onClick={() => onPick?.(d)}
                                onMouseMove={(e) =>
                                    tip.show(
                                        <TipRows
                                            title={longDate(d)}
                                            rows={[...segs.map((s) => [s.label, `${fmtHours(s.v)} h`, s.color]), ['Total', `${fmtHours(totals[i])} h`]]}
                                        />,
                                        e,
                                    )
                                }
                                onMouseLeave={tip.hide}
                            >
                                {isWeekend(d) && <rect x={padL + i * step} y={padT} width={step} height={plotH} fill="rgba(148,163,184,0.04)" />}
                                <rect x={padL + i * step} y={padT} width={step} height={plotH} fill="transparent" className="hover:fill-white/[0.03]" />
                                {segs.map((s) =>
                                    s.h > 0 ? (
                                        s === top ? (
                                            <path key={s.key} d={roundTop(x, s.y, barW, s.h, Math.min(4, barW / 2))} fill={s.color} />
                                        ) : (
                                            <rect key={s.key} x={x} y={s.y} width={barW} height={s.h} fill={s.color} />
                                        )
                                    ) : null,
                                )}
                                {i % labelEvery === 0 && (
                                    <text x={x + barW / 2} y={height - 8} textAnchor="middle" className={`text-[10px] ${isWeekend(d) ? 'fill-slate-600' : 'fill-slate-500'}`}>
                                        {days.length <= 8 ? `${dayName(d)} ${shortDate(d).split(' ')[0]}` : shortDate(d)}
                                    </text>
                                )}
                            </g>
                        );
                    })}
                </svg>
            )}
        </div>
    );
}

function roundTop(x, y, w, h, r) {
    const rr = Math.min(r, h);
    return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/* ---------------- line chart (weekly %) ---------------- */

export function LineChart({ labels, series, height = 200, max: fixedMax, unit = '' }) {
    const tip = useTip();
    const [ref, width] = useWidth();
    const padL = 36;
    const padB = 24;
    const padT = 10;
    const max = fixedMax ?? niceMax(Math.max(0, ...series.flatMap((s) => s.values.filter((v) => v !== null))));
    const plotW = Math.max(0, width - padL - 30);
    const plotH = height - padB - padT;
    const xAt = (i) => padL + (labels.length > 1 ? (i / (labels.length - 1)) * plotW : plotW / 2);
    const yAt = (v) => padT + plotH - (v / max) * plotH;
    const [hover, setHover] = useState(null);

    return (
        <div ref={ref} className="w-full" style={{ height }}>
            {width > 0 && (
                <svg
                    width={width}
                    height={height}
                    onMouseMove={(e) => {
                        const box = e.currentTarget.getBoundingClientRect();
                        const i = Math.round(((e.clientX - box.left - padL) / Math.max(1, plotW)) * (labels.length - 1));
                        const idx = Math.max(0, Math.min(labels.length - 1, i));
                        setHover(idx);
                        tip.show(
                            <TipRows
                                title={labels[idx]}
                                rows={series.filter((s) => s.values[idx] !== null).map((s) => [s.label, `${Math.round(s.values[idx])}${unit}`, s.color])}
                            />,
                            e,
                        );
                    }}
                    onMouseLeave={() => {
                        setHover(null);
                        tip.hide();
                    }}
                >
                    {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                        <g key={f}>
                            <line x1={padL} x2={width} y1={yAt(f * max)} y2={yAt(f * max)} stroke="rgba(148,163,184,0.12)" strokeDasharray={f ? '3 4' : ''} />
                            <text x={padL - 8} y={yAt(f * max) + 3.5} textAnchor="end" className="fill-slate-500 text-[10px] tabular-nums">
                                {Math.round(f * max)}
                                {unit}
                            </text>
                        </g>
                    ))}
                    {labels.map((l, i) => (
                        <text key={l} x={xAt(i)} y={height - 7} textAnchor="middle" className="fill-slate-500 text-[10px]">
                            {l}
                        </text>
                    ))}
                    {hover !== null && <line x1={xAt(hover)} x2={xAt(hover)} y1={padT} y2={padT + plotH} stroke="rgba(148,163,184,0.3)" />}
                    {series.map((s) => {
                        const pts = s.values.map((v, i) => (v === null ? null : [xAt(i), yAt(v)])).filter(Boolean);
                        if (!pts.length) return null;
                        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join('');
                        return (
                            <g key={s.label}>
                                <path d={d} fill="none" stroke={s.color} strokeWidth={s.bold ? 2.5 : 1.75} strokeOpacity={s.bold ? 1 : 0.85} strokeLinejoin="round" />
                                {pts.map((p, i) => (
                                    <circle key={i} cx={p[0]} cy={p[1]} r={s.bold ? 3.5 : 2.5} fill={s.color} stroke="#0f172a" strokeWidth="1.5" />
                                ))}
                            </g>
                        );
                    })}
                </svg>
            )}
        </div>
    );
}

/* ---------------- donut ---------------- */

export function Donut({ parts, size = 168, stroke = 18, centerLabel, centerSub }) {
    const tip = useTip();
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const total = parts.reduce((s, p) => s + p.value, 0);
    let offset = 0;
    const gap = parts.filter((p) => p.value > 0).length > 1 ? 2 : 0;

    return (
        <div className="relative shrink-0" style={{ width: size, height: size }}>
            <svg width={size} height={size} className="-rotate-90">
                <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(51,65,85,0.5)" strokeWidth={stroke} />
                {total > 0 &&
                    parts
                        .filter((p) => p.value > 0)
                        .map((p) => {
                            const len = (p.value / total) * c;
                            const el = (
                                <circle
                                    key={p.label}
                                    cx={size / 2}
                                    cy={size / 2}
                                    r={r}
                                    fill="none"
                                    stroke={p.color}
                                    strokeWidth={stroke}
                                    strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
                                    strokeDashoffset={-offset}
                                    className="cursor-default transition-opacity hover:opacity-80"
                                    onMouseMove={(e) => tip.show(<TipRows rows={[[p.label, `${fmtHours(p.value)} h · ${Math.round((p.value / total) * 100)}%`, p.color]]} />, e)}
                                    onMouseLeave={tip.hide}
                                />
                            );
                            offset += len;
                            return el;
                        })}
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-semibold tabular-nums text-white">{centerLabel}</span>
                {centerSub && <span className="text-[11px] uppercase tracking-wider text-slate-400">{centerSub}</span>}
            </div>
        </div>
    );
}

/* ---------------- heatmap ---------------- */

/** rows = [{id,label,sub,values:{day:hours}}]; colour deepens with hours. */
export function Heatmap({ days, rows, onPickRow }) {
    const tip = useTip();
    const max = Math.max(8, ...rows.flatMap((r) => Object.values(r.values)));
    const shade = (v) => {
        if (!v) return 'rgba(51,65,85,0.28)';
        const t = Math.min(1, v / max);
        return `rgba(249,115,22,${(0.18 + t * 0.82).toFixed(2)})`;
    };
    return (
        <div className="dark-scroll overflow-x-auto pb-1">
            <table className="border-separate" style={{ borderSpacing: 3 }}>
                <thead>
                    <tr>
                        <th className="sticky left-0 z-10 bg-slate-900 pr-3 text-left text-[11px] font-medium text-slate-500" />
                        {days.map((d) => (
                            <th key={d} className={`px-0 text-center text-[10px] font-medium ${isWeekend(d) ? 'text-slate-600' : 'text-slate-500'}`}>
                                <div>{dayName(d)[0]}</div>
                                <div className="tabular-nums">{shortDate(d).split(' ')[0]}</div>
                            </th>
                        ))}
                        <th className="pl-2 text-right text-[11px] font-medium text-slate-500">Total</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r) => {
                        const sum = Object.values(r.values).reduce((a, b) => a + b, 0);
                        return (
                            <tr key={r.id}>
                                <th className="sticky left-0 z-10 max-w-[13rem] bg-slate-900 pr-3 text-left font-normal">
                                    <button type="button" onClick={() => onPickRow?.(r.id)} className="block w-full truncate text-left text-xs text-slate-200 hover:text-orange-300">
                                        {r.label}
                                    </button>
                                </th>
                                {days.map((d) => (
                                    <td
                                        key={d}
                                        className="h-6 w-6 min-w-6 rounded-[5px] p-0"
                                        style={{ background: shade(r.values[d]) }}
                                        onMouseMove={(e) => tip.show(<TipRows title={`${r.label} · ${longDate(d)}`} rows={[['Hours', fmtHours(r.values[d] || 0)]]} />, e)}
                                        onMouseLeave={tip.hide}
                                    />
                                ))}
                                <td className="pl-2 text-right text-xs tabular-nums text-slate-300">{fmtHours(sum)}</td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            <div className="mt-3 flex items-center gap-2 text-[11px] text-slate-500">
                <span>Less</span>
                {[0, 0.2, 0.45, 0.7, 1].map((t) => (
                    <span key={t} className="h-3 w-3 rounded-[3px]" style={{ background: t ? `rgba(249,115,22,${0.18 + t * 0.82})` : 'rgba(51,65,85,0.28)' }} />
                ))}
                <span>More</span>
            </div>
        </div>
    );
}

export { BILLABLE, INTERNAL };
