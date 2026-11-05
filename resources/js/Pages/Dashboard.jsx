import React, { useEffect, useMemo, useRef, useState } from 'react';
import AuthenticatedLayout from '@/Layouts/AuthenticatedLayout';
import { Head, Link } from '@inertiajs/react';
import { useFormatters } from '@/lib/datetime';
import SearchableMultiSelect from '@/Components/Filters/SearchableMultiSelect';
import {
    Activity,
    AlertTriangle,
    CalendarDays,
    Clock,
    Coffee,
    Download,
    Loader2,
    LogOut,
    Moon,
    PauseCircle,
    PlayCircle,
    Radio,
    RotateCcw,
    Square,
    Sunrise,
    Sunset,
    Table,
    Timer,
    Trophy,
    Users,
    UserCheck,
    UserRound,
    X,
} from 'lucide-react';
import axios from 'axios';
import toast from 'react-hot-toast';
import {
    showActionBlocked,
    showError,
    showExportSuccess,
    showLoading,
    showTimeActionSuccess,
} from '@/Utils/notifications';
import { formatHours, getTimeBasedGreeting } from '@/Utils/timeUtils';
import MetricCard from '@/Components/MetricCard';
import SwitchableChartCard from '@/Components/Charts/SwitchableChartCard';
import NeedsAttentionList from '@/Components/NeedsAttentionList';
import { getChartOptions, toTrendData, toShareData } from '@/lib/chartConfig';

const ACTIONS = [
    { type: 'clock_in', label: 'Clock In', description: 'Start work', icon: PlayCircle, activeClass: 'bg-emerald-600 text-white hover:bg-emerald-700' },
    { type: 'clock_out', label: 'Clock Out', description: 'End work', icon: Square, activeClass: 'bg-rose-600 text-white hover:bg-rose-700' },
    { type: 'break_start', label: 'Start Break', description: 'Pause work', icon: PauseCircle, activeClass: 'bg-amber-500 text-slate-950 hover:bg-amber-600' },
    { type: 'break_end', label: 'End Break', description: 'Resume work', icon: RotateCcw, activeClass: 'bg-blue-600 text-white hover:bg-blue-700' },
];

const actionLabel = (type) => ACTIONS.find((action) => action.type === type)?.label || 'Not Started';

const statusFromAction = (lastAction) => {
    if (!lastAction) return { label: 'Not Started', className: 'bg-white/10 text-slate-300', dot: 'bg-slate-400' };
    if (lastAction === 'break_start') return { label: 'On Break', className: 'bg-amber-500/15 text-amber-300', dot: 'bg-amber-400' };
    if (lastAction === 'clock_out') return { label: 'Clocked Out', className: 'bg-rose-500/15 text-rose-300', dot: 'bg-rose-400' };
    return { label: 'Working', className: 'bg-emerald-500/15 text-emerald-300', dot: 'bg-emerald-400' };
};

const calculateStats = (entries) => {
    if (!entries.length) {
        return { totalHours: 0, totalBreakTime: 0, sessionsCount: 0, lastAction: null };
    }

    const sorted = [...entries].sort((a, b) => new Date(a.action_timestamp) - new Date(b.action_timestamp));
    let totalMinutes = 0;
    let breakMinutes = 0;
    let sessionsCount = 0;
    let sessionStart = null;
    let breakStart = null;

    sorted.forEach((entry) => {
        const timestamp = new Date(entry.action_timestamp);

        if (entry.action_type === 'clock_in') {
            sessionStart = timestamp;
            sessionsCount += 1;
        } else if (entry.action_type === 'clock_out' && sessionStart) {
            totalMinutes += (timestamp - sessionStart) / 60000;
            sessionStart = null;
        } else if (entry.action_type === 'break_start') {
            breakStart = timestamp;
        } else if (entry.action_type === 'break_end' && breakStart) {
            breakMinutes += (timestamp - breakStart) / 60000;
            breakStart = null;
        }
    });

    if (sessionStart) totalMinutes += (Date.now() - sessionStart.getTime()) / 60000;
    if (breakStart) breakMinutes += (Date.now() - breakStart.getTime()) / 60000;

    return {
        totalHours: Math.max(0, (totalMinutes - breakMinutes) / 60),
        totalBreakTime: Math.max(0, breakMinutes / 60),
        sessionsCount,
        lastAction: entries[0]?.action_type || null,
    };
};

// Falls back to initials when the avatar file 404s (deploys can prune
// storage files), instead of showing the browser's broken-image icon.
function EmployeeAvatar({ src, name }) {
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        setFailed(false);
    }, [src]);

    if (src && !failed) {
        return <img src={src} alt="" onError={() => setFailed(true)} className="h-9 w-9 rounded-full object-cover" />;
    }

    return (
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-700 text-sm font-bold text-slate-200">
            {name.charAt(0).toUpperCase()}
        </span>
    );
}

// ---- Team panel: shared bits for the Shift Board / Live / Leaderboard tabs ----

const SHIFT_STATUS = {
    working: { label: 'Working', pill: 'bg-emerald-500/15 text-emerald-300', dot: 'bg-emerald-400' },
    on_break: { label: 'On break', pill: 'bg-amber-500/15 text-amber-300', dot: 'bg-amber-400' },
    clocked_out: { label: 'Clocked out', pill: 'bg-slate-500/15 text-slate-300', dot: 'bg-slate-400' },
    still_in: { label: 'Still clocked in', pill: 'bg-rose-500/15 text-rose-300', dot: 'bg-rose-400' },
    not_in_yet: { label: 'Not clocked in', pill: 'bg-amber-500/15 text-amber-300', dot: 'bg-amber-400' },
    not_started: { label: 'Not started', pill: 'bg-slate-700/40 text-slate-400', dot: 'bg-slate-500' },
};

const BAND_ICON = { day: Sunrise, evening: Sunset, night: Moon, unscheduled: Clock };

const secondsToHours = (s) => formatHours((Number(s) || 0) / 3600);

function activityPill(pct) {
    const v = Math.max(0, Math.min(100, Number(pct) || 0));
    const cls = v >= 60 ? 'bg-emerald-500/15 text-emerald-300' : v >= 30 ? 'bg-amber-500/15 text-amber-300' : 'bg-rose-500/15 text-rose-300';
    return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{v}%</span>;
}

// Running duration since an ISO instant (the active tracker session's start).
function durationSince(iso) {
    if (!iso) return null;
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    const mins = Math.floor(ms / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Shift handover board: the team grouped by shift band, exceptions surfaced.
function ShiftBoardView({ board, canManage, onClockOut }) {
    const bands = board?.bands || [];
    if (!bands.length) {
        return (
            <div className="px-5 py-12 text-center">
                <UserRound className="mx-auto h-10 w-10 text-slate-600" />
                <h3 className="mt-3 font-semibold text-white">No one scheduled</h3>
                <p className="mt-1 text-sm text-slate-400">Shift activity will appear here.</p>
            </div>
        );
    }
    return (
        <div className="divide-y divide-slate-800">
            {bands.map((band) => {
                const Icon = BAND_ICON[band.key] || Clock;
                const s = band.summary;
                return (
                    <div key={band.key} className="px-5 py-4">
                        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                            <div className="flex items-center gap-2">
                                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-800 text-slate-300"><Icon className="h-4 w-4" /></span>
                                <h3 className="text-sm font-bold text-white">{band.label}</h3>
                                <span className="text-xs text-slate-500">{band.range}</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5 text-xs">
                                {s.on_now > 0 && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-300">{s.on_now} on now</span>}
                                {s.still_in > 0 && <span className="rounded-full bg-rose-500/10 px-2 py-0.5 text-rose-300">{s.still_in} still in</span>}
                                {s.not_in_yet > 0 && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-300">{s.not_in_yet} not in yet</span>}
                                {s.clocked_out > 0 && <span className="rounded-full bg-slate-700/40 px-2 py-0.5 text-slate-400">{s.clocked_out} done</span>}
                                <span className="text-slate-500">· {s.total} total</span>
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            {band.members.map((m) => {
                                const st = SHIFT_STATUS[m.status] || SHIFT_STATUS.not_started;
                                const alert = m.severity === 'red' ? 'border-rose-500/30 bg-rose-500/5' : m.severity === 'amber' ? 'border-amber-500/25 bg-amber-500/5' : 'border-transparent';
                                return (
                                    <div key={m.user_id} className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${alert}`}>
                                        <div className="flex min-w-0 items-center gap-3">
                                            <EmployeeAvatar src={m.avatar} name={m.name} />
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2 truncate text-sm font-semibold text-slate-100">
                                                    {m.name}
                                                    {m.is_live && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" title="Tracking now" />}
                                                    {m.shift_start && <span className="shrink-0 text-[11px] font-normal text-slate-500">{m.shift_start}</span>}
                                                </div>
                                                <div className="truncate text-xs text-slate-400">
                                                    {m.exception
                                                        ? <span className={m.severity === 'red' ? 'text-rose-300' : 'text-amber-300'}>{m.exception}</span>
                                                        : (m.first_in ? `In ${m.first_in}${m.last_out ? ` → ${m.last_out}` : ''}` : m.designation)}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-2">
                                            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${st.pill}`}>
                                                <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />{st.label}
                                            </span>
                                            {canManage && m.can_clock_out && (
                                                <button
                                                    type="button"
                                                    onClick={() => onClockOut(m)}
                                                    className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs font-semibold text-slate-200 transition hover:border-rose-600 hover:bg-rose-600 hover:text-white"
                                                    title="Clock this person out"
                                                >
                                                    <LogOut className="h-3.5 w-3.5" /> Clock out
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

// Live work board: who's clocked in and working right now.
function LiveBoardView({ employees }) {
    const rank = (s) => (s === 'Working' ? 0 : s === 'On Break' ? 1 : 2);
    const live = [...employees]
        .filter((e) => e.is_live || e.current_status === 'Working' || e.current_status === 'On Break')
        .sort((a, b) => {
            const d = rank(a.current_status) - rank(b.current_status);
            if (d) return d;
            return (Number(b.activity_percent) || 0) - (Number(a.activity_percent) || 0);
        });
    if (!live.length) {
        return (
            <div className="px-5 py-12 text-center">
                <Radio className="mx-auto h-10 w-10 text-slate-600" />
                <h3 className="mt-3 font-semibold text-white">Nobody working right now</h3>
                <p className="mt-1 text-sm text-slate-400">People currently clocked in and tracking show here live.</p>
            </div>
        );
    }
    return (
        <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-800">
                <thead className="bg-slate-950">
                    <tr>{['Member', 'Status', 'Session', 'Activity', 'Tracked today'].map((h) => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase text-slate-300">{h}</th>
                    ))}</tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                    {live.map((e) => {
                        const onBreak = e.current_status === 'On Break';
                        const hasData = e.is_live || (Number(e.tracked_hours) || 0) > 0;
                        return (
                            <tr key={e.user_id} className="hover:bg-white/5">
                                <td className="whitespace-nowrap px-4 py-3">
                                    <div className="flex items-center gap-3">
                                        <EmployeeAvatar src={e.avatar} name={e.user_name} />
                                        <div>
                                            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                                                {e.user_name}
                                                {e.is_live && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" title="Tracking now" />}
                                            </div>
                                            <div className="text-xs text-slate-400">{e.designation}</div>
                                        </div>
                                    </div>
                                </td>
                                <td className="whitespace-nowrap px-4 py-3">
                                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${onBreak ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300'}`}>
                                        <span className={`h-1.5 w-1.5 rounded-full ${onBreak ? 'bg-amber-400' : 'bg-emerald-400'}`} />{e.current_status}
                                    </span>
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-300">{durationSince(e.live_since) || '—'}</td>
                                <td className="whitespace-nowrap px-4 py-3">{hasData ? activityPill(e.activity_percent) : <span className="text-xs text-slate-400">—</span>}</td>
                                <td className="whitespace-nowrap px-4 py-3 text-sm font-semibold text-orange-300">{formatHours(e.tracked_hours || 0)}</td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

// Leaderboard: ranked by tracked time, low activity flagged.
function LeaderboardView({ rows, loading, rangeLabel }) {
    if (loading) {
        return (
            <div className="px-5 py-12 text-center">
                <Loader2 className="mx-auto h-8 w-8 animate-spin text-slate-500" />
                <p className="mt-3 text-sm text-slate-400">Loading {rangeLabel}…</p>
            </div>
        );
    }
    if (!rows.length) {
        return (
            <div className="px-5 py-12 text-center">
                <Trophy className="mx-auto h-10 w-10 text-slate-600" />
                <h3 className="mt-3 font-semibold text-white">No tracked time yet</h3>
                <p className="mt-1 text-sm text-slate-400">Rankings for {rangeLabel} appear once people start tracking.</p>
            </div>
        );
    }
    const max = Math.max(...rows.map((r) => r.seconds), 1);
    return (
        <div className="space-y-1.5 px-5 py-4">
            {rows.map((r, i) => (
                <div key={r.user_id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/5">
                    <div className={`w-6 text-center text-sm font-bold ${i === 0 ? 'text-amber-300' : i === 1 ? 'text-slate-300' : i === 2 ? 'text-orange-300' : 'text-slate-500'}`}>{i + 1}</div>
                    <EmployeeAvatar src={r.avatar} name={r.user_name} />
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                            <div className="truncate text-sm font-semibold text-slate-100">{r.user_name}</div>
                            <div className="shrink-0 text-sm font-semibold text-orange-300">{secondsToHours(r.seconds)}</div>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                                <div className="h-full rounded-full bg-orange-500/70" style={{ width: `${Math.round((r.seconds / max) * 100)}%` }} />
                            </div>
                            {r.activity_percent != null ? activityPill(r.activity_percent) : null}
                        </div>
                    </div>
                    {r.low && <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" title="Low activity" />}
                </div>
            ))}
        </div>
    );
}

export default function Dashboard({ auth, shiftOptions = [] }) {
    // Renders the live clock in the viewer's chosen display timezone (Profile →
    // Time zone), not a hard-coded Asia/Karachi, so the switcher applies here too.
    const { formatTime, tz } = useFormatters();
    const can = (permission) => auth.user?.is_super_admin || auth.user?.permissions?.includes(permission);
    const canViewTeam = can('dashboard.view_team') || can('attendance.view');
    const canViewAnalytics = can('analytics.view');
    const [entries, setEntries] = useState([]);
    const [employeesData, setEmployeesData] = useState([]);
    const [teamKpis, setTeamKpis] = useState(null);
    const [needsAttention, setNeedsAttention] = useState([]);
    // At-a-glance trend: own state + quick toggle (today / yesterday / week).
    const [trendRange, setTrendRange] = useState('today');
    const [trend, setTrend] = useState(null);
    const [trendLoading, setTrendLoading] = useState(false);
    // Team Activity table: a date filter (today / yesterday / this week / custom).
    // "today" keeps the live status table; other ranges show historical totals.
    const [tableRange, setTableRange] = useState('today');
    const [tableCustom, setTableCustom] = useState({ start: '', end: '' });
    const [rangedRows, setRangedRows] = useState([]);
    const [rangedLoading, setRangedLoading] = useState(false);
    // Team panel: which view (shifts handover / live / leaderboard / table).
    const [teamTab, setTeamTab] = useState('shifts');
    const [shiftBoard, setShiftBoard] = useState(null);
    const [canClockOutOthers, setCanClockOutOthers] = useState(false);
    // Shift filter for the team panel. A ref mirrors it so the live-refresh
    // interval + clock-action refetch read the current selection without being
    // re-created on every change.
    const [shiftIds, setShiftIds] = useState([]);
    const shiftIdsRef = useRef([]);
    shiftIdsRef.current = shiftIds;
    const shiftFilterOptions = (shiftOptions || []).map((s) => ({ value: String(s.id), label: s.name }))
        .concat([{ value: 'no_shift', label: 'No shift' }]);
    const summaryParams = () => (shiftIdsRef.current.length ? { params: { shift_ids: shiftIdsRef.current } } : {});
    // Admin "clock out for them" modal: the target member + chosen time/note.
    const [clockOut, setClockOut] = useState(null);
    // Leaderboard: today (from the live summary) vs this week (ranged endpoint).
    const [lbRange, setLbRange] = useState('today');
    const [lbWeekRows, setLbWeekRows] = useState([]);
    const [lbLoading, setLbLoading] = useState(false);
    const [loading, setLoading] = useState(false);
    // Distinguishes "still loading the first time" from "loaded, genuinely
    // empty" so the team table never flashes "No activity recorded today"
    // before its data arrives.
    const [dashboardLoaded, setDashboardLoaded] = useState(false);
    const [currentTime, setCurrentTime] = useState(new Date());
    // Seed the clock state from the server-rendered page props so the action
    // buttons are correct on first paint — no "Clock In" flash while the
    // entries request is in flight.
    const [todayStats, setTodayStats] = useState(() => ({
        ...calculateStats([]),
        lastAction: auth.lastActionToday || null,
    }));

    useEffect(() => {
        const timer = window.setInterval(() => setCurrentTime(new Date()), 1000);
        return () => window.clearInterval(timer);
    }, []);

    const loadDashboard = async (notifyOnError = true) => {
        // Settle the two independently: the team table only needs the summary,
        // so a hiccup on /time-entries/today must NOT blank it (and vice-versa).
        // Previously both shared one try/Promise.all, so any single failure wiped
        // the whole "Team Activity Today" table — the intermittent "No activity
        // recorded today" people saw on a perfectly good day.
        const [entriesResult, summaryResult] = await Promise.allSettled([
            axios.get('/time-entries/today'),
            axios.get('/time-entries/today-summary', summaryParams()),
        ]);

        if (entriesResult.status === 'fulfilled') {
            const nextEntries = entriesResult.value.data.entries || [];
            setEntries(nextEntries);
            setTodayStats(calculateStats(nextEntries));
        }
        if (summaryResult.status === 'fulfilled') {
            setEmployeesData(summaryResult.value.data.employees || []);
            setTeamKpis(summaryResult.value.data.team_kpis || null);
            setNeedsAttention(summaryResult.value.data.needs_attention || []);
            setShiftBoard(summaryResult.value.data.shift_board || null);
            setCanClockOutOthers(!!summaryResult.value.data.can_clock_out_others);
        }

        setDashboardLoaded(true);

        if (entriesResult.status === 'rejected' || summaryResult.status === 'rejected') {
            console.error('Dashboard load failed:', entriesResult.reason || summaryResult.reason);
            if (notifyOnError) showError('Some dashboard data could not be refreshed.');
        }
    };

    // Load on mount, then keep in sync with actions taken elsewhere (the
    // desktop app's clock bar): refresh when the tab regains focus and on a
    // slow background cadence.
    useEffect(() => {
        loadDashboard();
        const onFocus = () => loadDashboard(false);
        window.addEventListener('focus', onFocus);
        const interval = window.setInterval(() => loadDashboard(false), 45_000);
        return () => {
            window.removeEventListener('focus', onFocus);
            window.clearInterval(interval);
        };
    }, []);

    // Re-fetch the team panel when the shift filter changes (skip the mount run).
    const shiftFilterMounted = useRef(false);
    useEffect(() => {
        if (!shiftFilterMounted.current) { shiftFilterMounted.current = true; return; }
        loadDashboard(false);
    }, [shiftIds]);

    // At-a-glance trend: refetch whenever the quick toggle changes. Only team
    // viewers get the command center, so only they hit this endpoint.
    useEffect(() => {
        if (!canViewTeam) return undefined;
        let cancelled = false;
        setTrendLoading(true);
        axios
            .get('/time-entries/dashboard-trend', { params: { range: trendRange } })
            .then((res) => {
                if (!cancelled) setTrend(res.data);
            })
            .catch(() => {
                if (!cancelled) setTrend(null);
            })
            .finally(() => {
                if (!cancelled) setTrendLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [trendRange, canViewTeam]);

    // Team Activity table for a non-today range. "today" reuses the live summary
    // already loaded above, so we only hit the ranged endpoint when needed.
    useEffect(() => {
        if (!canViewTeam || tableRange === 'today') return undefined;
        if (tableRange === 'custom' && (!tableCustom.start || !tableCustom.end)) return undefined;
        let cancelled = false;
        setRangedLoading(true);
        const params = {
            ...(tableRange === 'custom'
                ? { start: tableCustom.start, end: tableCustom.end }
                : { range: tableRange }),
            ...(shiftIds.length ? { shift_ids: shiftIds } : {}),
        };
        axios
            .get('/time-entries/team-activity', { params })
            .then((res) => {
                if (!cancelled) setRangedRows(res.data.employees || []);
            })
            .catch(() => {
                if (!cancelled) setRangedRows([]);
            })
            .finally(() => {
                if (!cancelled) setRangedLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [tableRange, tableCustom, canViewTeam, shiftIds]);

    // Leaderboard "this week": fetch the ranged totals only when that view + range
    // is actually open ("today" derives from the live summary already in hand).
    useEffect(() => {
        if (!canViewTeam || teamTab !== 'leaderboard' || lbRange !== 'week') return undefined;
        let cancelled = false;
        setLbLoading(true);
        axios
            .get('/time-entries/team-activity', { params: { range: 'week' } })
            .then((res) => {
                if (!cancelled) setLbWeekRows(res.data.employees || []);
            })
            .catch(() => {
                if (!cancelled) setLbWeekRows([]);
            })
            .finally(() => {
                if (!cancelled) setLbLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [canViewTeam, teamTab, lbRange]);

    const currentStatus = useMemo(() => statusFromAction(todayStats.lastAction), [todayStats.lastAction]);

    // Trend labels: hourly buckets show as "9a"/"1p"; weekly buckets are ISO
    // dates formatted to a weekday in the viewer's own display timezone.
    const trendLabels = useMemo(() => {
        if (!trend) return [];
        if (trend.granularity === 'day') {
            return trend.labels.map((d) => {
                try {
                    return new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' });
                } catch {
                    return d;
                }
            });
        }
        return trend.labels.map((hhmm) => {
            const h = parseInt(hhmm.slice(0, 2), 10);
            const ampm = h < 12 ? 'a' : 'p';
            const h12 = h % 12 === 0 ? 12 : h % 12;
            return `${h12}${ampm}`;
        });
    }, [trend, tz]);

    const TREND_RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week']];
    const statusMix = teamKpis?.status_mix
        ? teamKpis.status_mix.map((s) => ({
            label: s.label,
            value: s.value,
            color: { Working: '#34d399', 'On break': '#f59e0b', 'Clocked out': '#fb7185', 'Not started': '#64748b' }[s.label],
        }))
        : [];
    const hasStatusMix = statusMix.some((s) => s.value > 0);
    const hasTrend = (trend?.hours || []).some((v) => v > 0);
    const fmtH = (v) => `${Math.round(v * 10) / 10}h`;

    const TABLE_RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['custom', 'Custom']];
    const isTodayTable = tableRange === 'today';
    const tableRangeLabel = tableRange === 'custom'
        ? `${tableCustom.start || '…'} → ${tableCustom.end || '…'}`
        : (TABLE_RANGES.find(([k]) => k === tableRange)?.[1] || 'Today');
    const activityBadge = (pct) => {
        const v = Math.max(0, Math.min(100, Number(pct) || 0));
        const cls = v >= 60 ? 'bg-emerald-500/15 text-emerald-300' : v >= 30 ? 'bg-amber-500/15 text-amber-300' : 'bg-rose-500/15 text-rose-300';
        return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{v}%</span>;
    };
    const fmtSecs = (s) => formatHours((Number(s) || 0) / 3600);

    const isActionDisabled = (actionType) => {
        if (loading) return true;
        if (!todayStats.lastAction) return actionType !== 'clock_in';
        if (todayStats.lastAction === 'clock_in') return actionType === 'clock_in' || actionType === 'break_end';
        if (todayStats.lastAction === 'clock_out') return actionType !== 'clock_in';
        if (todayStats.lastAction === 'break_start') return actionType !== 'break_end';
        if (todayStats.lastAction === 'break_end') return actionType === 'clock_in' || actionType === 'break_end';
        return false;
    };

    const blockedReason = (actionType) => {
        if (actionType === 'clock_in') return 'Finish the current work session before clocking in again.';
        if (actionType === 'clock_out' && todayStats.lastAction === 'break_start') return 'End the break before clocking out.';
        if (actionType === 'break_end') return 'Start a break before ending it.';
        return 'This action is not available for your current status.';
    };

    const addEntry = async (actionType) => {
        if (isActionDisabled(actionType)) {
            showActionBlocked(actionType, blockedReason(actionType));
            return;
        }

        const loadingToast = showLoading('Recording time entry...');
        setLoading(true);

        try {
            const response = await axios.post('/time-entries', { action_type: actionType });
            const nextEntries = [response.data.entry, ...entries];
            setEntries(nextEntries);
            setTodayStats(calculateStats(nextEntries));
            const summaryResponse = await axios.get('/time-entries/today-summary', summaryParams());
            setEmployeesData(summaryResponse.data.employees || []);
            setTeamKpis(summaryResponse.data.team_kpis || null);
            setNeedsAttention(summaryResponse.data.needs_attention || []);
            setShiftBoard(summaryResponse.data.shift_board || null);
            setCanClockOutOthers(!!summaryResponse.data.can_clock_out_others);
            toast.dismiss(loadingToast);
            showTimeActionSuccess(actionType);
        } catch (error) {
            console.error('Time entry failed:', error);
            toast.dismiss(loadingToast);
            showError(error.response?.data?.message || 'Failed to record time entry.');
        } finally {
            setLoading(false);
        }
    };

    const downloadCSV = async () => {
        const loadingToast = showLoading('Preparing time report...');

        try {
            const response = await axios.get('/time-entries/export', { responseType: 'blob' });
            const url = window.URL.createObjectURL(new Blob([response.data], { type: 'text/csv' }));
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `sparking-asia-timesheet-${new Date().toISOString().split('T')[0]}.csv`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            window.URL.revokeObjectURL(url);
            toast.dismiss(loadingToast);
            showExportSuccess();
        } catch (error) {
            console.error('Export failed:', error);
            toast.dismiss(loadingToast);
            showError('Failed to export the timesheet.');
        }
    };

    const submitClockOut = async () => {
        if (!clockOut) return;
        setClockOut((c) => ({ ...c, submitting: true }));
        const loadingToast = showLoading('Clocking out…');
        try {
            const res = await axios.post('/employee-attendance/clock-out', {
                user_id: clockOut.user_id,
                time: clockOut.time || null,
                note: clockOut.note || null,
            });
            toast.dismiss(loadingToast);
            toast.success(res.data?.message || 'Clocked out.');
            setClockOut(null);
            await loadDashboard(false);
        } catch (error) {
            toast.dismiss(loadingToast);
            showError(error.response?.data?.message || error.response?.data?.errors?.user_id?.[0] || 'Could not clock out.');
            setClockOut((c) => (c ? { ...c, submitting: false } : c));
        }
    };

    // Leaderboard rows: "today" from the live summary already loaded; "week"
    // from the ranged endpoint. Normalised to { seconds } and sorted desc.
    const leaderboardRows = useMemo(() => {
        const source = lbRange === 'today'
            ? employeesData.map((e) => ({
                user_id: e.user_id, user_name: e.user_name, avatar: e.avatar,
                seconds: Math.round((Number(e.tracked_hours) || 0) * 3600),
                activity_percent: (e.is_live || (Number(e.tracked_hours) || 0) > 0) ? e.activity_percent : null,
            }))
            : lbWeekRows.map((e) => ({
                user_id: e.user_id, user_name: e.user_name, avatar: e.avatar,
                seconds: Number(e.tracked_seconds) || 0,
                activity_percent: (Number(e.tracked_seconds) || 0) > 0 ? e.activity_percent : null,
            }));
        return source
            .filter((r) => r.seconds > 0)
            .sort((a, b) => b.seconds - a.seconds)
            .map((r) => ({ ...r, low: r.activity_percent != null && Number(r.activity_percent) < 30 }));
    }, [lbRange, employeesData, lbWeekRows]);

    // Presence (clock in/out) vs actual work product (tracker + manual
    // entries) — two different clocks, labeled honestly.
    const myTracked = employeesData.find((e) => e.user_id === auth.user.id)?.tracked_hours;

    // Every card counts the SAME shift-aware work day (a night shift's day
    // doesn't reset at midnight), so the four numbers always tell one story.
    const metrics = [
        { label: 'In Office', sub: 'Clocked in · this work day', value: formatHours(todayStats.totalHours), icon: Timer, color: 'text-emerald-400', bg: 'bg-emerald-500/10', title: 'How long you have been clocked in this work day (clock-in to clock-out, minus breaks). Your work day follows your shift — it does not reset at midnight.' },
        { label: 'Tracked Work', sub: 'Tracker active · today', value: myTracked != null ? formatHours(myTracked) : '0m', icon: Activity, color: 'text-orange-400', bg: 'bg-orange-500/10', title: 'Work the desktop tracker recorded today (since midnight), plus manual work-diary hours — always matches your Timeline. Work after midnight counts on the next date, exactly like the Timeline.' },
        { label: 'Break Time', sub: 'On break · this work day', value: formatHours(todayStats.totalBreakTime), icon: Coffee, color: 'text-amber-400', bg: 'bg-amber-500/10', title: 'Total break time this work day. Breaks pause the tracker and are not counted as work.' },
        { label: 'Actions', sub: 'Clock punches · this work day', value: entries.length, icon: CalendarDays, color: 'text-violet-400', bg: 'bg-violet-500/10', title: 'Clock in / out / break punches this work day.' },
    ];

    // Tracked-only table order: people tracking right now first, then by most
    // tracked today, then name. (Clock status ordering lives on the Shifts tab.)
    const sortedEmployees = [...employeesData].sort((a, b) => {
        if (!!a.is_live !== !!b.is_live) return a.is_live ? -1 : 1;
        const ta = Number(a.tracked_hours) || 0;
        const tb = Number(b.tracked_hours) || 0;
        if (ta !== tb) return tb - ta;
        return (a.user_name || '').localeCompare(b.user_name || '');
    });

    const TEAM_TABS = [
        ['shifts', 'Shifts', Sunrise],
        ['live', 'Live', Radio],
        ['leaderboard', 'Leaderboard', Trophy],
        ['table', 'Table', Table],
    ];

    const teamLoading = (
        <div className="px-5 py-12 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-slate-500" />
            <p className="mt-3 text-sm text-slate-400">Loading team activity…</p>
        </div>
    );

    // The live "today" status table (also the whole panel for a non-team viewer).
    const todayStatusBody = !dashboardLoaded ? teamLoading : employeesData.length === 0 ? (
        <div className="px-5 py-12 text-center">
            <UserRound className="mx-auto h-10 w-10 text-slate-600" />
            <h3 className="mt-3 font-semibold text-white">No activity recorded today</h3>
            <p className="mt-1 text-sm text-slate-400">Time tracking activity will appear here.</p>
        </div>
    ) : (
        <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-800">
                <thead className="bg-slate-950">
                    <tr>
                        {[
                            ['Employee', null],
                            ['Status', 'Whether the desktop tracker is recording right now'],
                            ['Shift', 'Assigned shift (Morning/Evening/…)'],
                            ['Tracked today', 'Desktop-tracker work + manual diary hours, this calendar day — matches the Timeline exactly'],
                            ['Activity', 'Share of tracked time with keyboard/mouse input'],
                            ['Yesterday', 'Tracked yesterday (calendar day) — a night shift’s evening lands here after midnight'],
                            ['This week', 'Tracked since Monday. Early in a month this can exceed This month — the week may include last-month days.'],
                            ['This month', 'Tracked since the 1st'],
                        ].map(([heading, tip]) => (
                            <th key={heading} title={tip || undefined} className={`px-4 py-3 text-left text-xs font-bold uppercase text-slate-300 ${tip ? 'cursor-help underline decoration-dotted decoration-slate-600 underline-offset-4' : ''}`}>{heading}</th>
                        ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                    {sortedEmployees.map((employee) => (
                        <tr key={employee.user_id} className="hover:bg-white/5">
                            <td className="whitespace-nowrap px-4 py-3">
                                <div className="flex items-center gap-3">
                                    <EmployeeAvatar src={employee.avatar} name={employee.user_name} />
                                    <div>
                                        <div className="text-sm font-semibold text-slate-100">{employee.user_name}</div>
                                        <div className="text-xs text-slate-400">{employee.designation}</div>
                                    </div>
                                </div>
                            </td>
                            <td className="whitespace-nowrap px-4 py-3">
                                {employee.is_live ? (
                                    <span className="inline-flex items-center gap-2 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300">
                                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                                        Tracking
                                    </span>
                                ) : (Number(employee.tracked_hours) || 0) > 0 ? (
                                    <span className="inline-flex items-center gap-2 rounded-full bg-slate-700/40 px-2.5 py-1 text-xs font-semibold text-slate-300">
                                        Tracked earlier
                                    </span>
                                ) : (
                                    <span className="text-xs text-slate-500">—</span>
                                )}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-xs">
                                {employee.shift_name
                                    ? <span className="rounded-full bg-slate-800 px-2 py-0.5 font-medium text-slate-200">{employee.shift_name}</span>
                                    : <span className="text-slate-500">—</span>}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-sm font-semibold text-orange-300">{formatHours(employee.tracked_hours || 0)}</td>
                            <td className="whitespace-nowrap px-4 py-3">
                                {(() => {
                                    const hasData = employee.is_live || (Number(employee.tracked_hours) || 0) > 0;
                                    if (!hasData) return <span className="text-xs text-slate-400">—</span>;
                                    return activityPill(employee.activity_percent);
                                })()}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-300">{formatHours(employee.tracked_yesterday_hours || 0)}</td>
                            <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-300">{formatHours(employee.tracked_week_hours || 0)}</td>
                            <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-300">{formatHours(employee.tracked_month_hours || 0)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );

    // The historical (non-today) ranged table, used by the Table tab.
    const rangedBody = rangedLoading ? (
        <div className="px-5 py-12 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-slate-500" />
            <p className="mt-3 text-sm text-slate-400">Loading {tableRangeLabel}…</p>
        </div>
    ) : rangedRows.length === 0 ? (
        <div className="px-5 py-12 text-center">
            <UserRound className="mx-auto h-10 w-10 text-slate-600" />
            <h3 className="mt-3 font-semibold text-white">No activity in this range</h3>
            <p className="mt-1 text-sm text-slate-400">Nobody tracked time or clocked in for {tableRangeLabel}.</p>
        </div>
    ) : (
        <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-800">
                <thead className="bg-slate-950">
                    <tr>
                        {['Employee', 'In Office', 'Tracked', 'Activity', 'Days'].map((heading) => (
                            <th key={heading} className="px-4 py-3 text-left text-xs font-bold uppercase text-slate-300">{heading}</th>
                        ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                    {rangedRows.map((employee) => (
                        <tr key={employee.user_id} className="hover:bg-white/5">
                            <td className="whitespace-nowrap px-4 py-3">
                                <div className="flex items-center gap-3">
                                    <EmployeeAvatar src={employee.avatar} name={employee.user_name} />
                                    <div>
                                        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                                            {employee.user_name}
                                            {employee.is_live && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" title="Tracking right now" />}
                                        </div>
                                        <div className="text-xs text-slate-400">{employee.designation}</div>
                                    </div>
                                </div>
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-sm font-semibold text-slate-100">{fmtSecs(employee.in_office_seconds)}</td>
                            <td className="whitespace-nowrap px-4 py-3 text-sm font-semibold text-orange-300">{fmtSecs(employee.tracked_seconds)}</td>
                            <td className="whitespace-nowrap px-4 py-3">
                                {employee.tracked_seconds > 0 ? activityBadge(employee.activity_percent) : <span className="text-xs text-slate-400">—</span>}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-300">{employee.days_worked}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );

    return (
        <AuthenticatedLayout user={auth.user}>
            <Head title="Dashboard" />

            <div className="min-h-screen bg-slate-950">
                {/* On phones the clock buttons sit right under the greeting. */}
                <div className="mx-auto flex max-w-none flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
                    <section className="relative -order-2 overflow-hidden rounded-2xl lg:order-none border border-slate-800 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 px-6 py-6 shadow-xl shadow-slate-950/20">
                        <div className="pointer-events-none absolute -top-24 right-10 h-56 w-56 rounded-full bg-orange-500/15 blur-3xl" aria-hidden="true" />
                        <div className="pointer-events-none absolute -bottom-32 left-1/3 h-56 w-72 rounded-full bg-amber-500/10 blur-3xl" aria-hidden="true" />
                        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                            <div>
                                <p className="text-sm font-semibold text-orange-400">{getTimeBasedGreeting(tz)}</p>
                                <h1 className="mt-1 text-2xl font-bold text-white">{auth.user.name}</h1>
                                <p className="mt-1 text-sm text-slate-400">Track today&apos;s work and review current team activity.</p>
                            </div>

                            <div className="flex flex-wrap items-center gap-3">
                                <Link
                                    href={route('desktop-downloads.index')}
                                    className="hidden items-center sm:inline-flex gap-2 rounded-lg border border-orange-500/40 bg-orange-500/15 px-3 py-2 text-sm font-semibold text-orange-300 transition hover:bg-orange-500/25"
                                    title="Download the SA Track desktop app — installable on any PC without signing in"
                                >
                                    <Download className="h-4 w-4" />
                                    Get desktop app
                                </Link>
                                <div className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${currentStatus.className}`}>
                                    <span className={`h-2 w-2 rounded-full ${currentStatus.dot}`} />
                                    {currentStatus.label}
                                </div>
                                <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-right backdrop-blur">
                                    <div className="text-lg font-bold text-white">
                                        {formatTime(currentTime.toISOString())}
                                    </div>
                                    <div className="text-xs font-medium text-slate-400">{tz.replace(/_/g, ' ')}</div>
                                </div>
                            </div>
                        </div>
                    </section>

                    {canViewTeam && (
                        <section className="space-y-4">
                            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                                <MetricCard label="Present today" value={teamKpis ? `${teamKpis.present}/${teamKpis.team_size}` : '—'} icon={Users} />
                                <MetricCard label="Working now" value={teamKpis ? teamKpis.working : '—'} icon={UserCheck} tone="success" />
                                <MetricCard label="On break" value={teamKpis ? teamKpis.on_break : '—'} icon={Coffee} tone="warning" />
                                <MetricCard label="Avg activity" value={teamKpis?.avg_activity == null ? '—' : `${teamKpis.avg_activity}%`} icon={Activity} />
                                <MetricCard label="Tracked today" value={teamKpis ? `${teamKpis.total_tracked_hours}h` : '—'} icon={Timer} />
                                <MetricCard label="Needs attention" value={teamKpis ? teamKpis.needs_attention : '—'} icon={AlertTriangle} tone={teamKpis?.needs_attention ? 'danger' : 'default'} />
                            </div>

                            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                                <div className="lg:col-span-2">
                                    <SwitchableChartCard
                                        title="At a glance"
                                        subtitle="Team tracked hours"
                                        chartKey="dash_at_a_glance"
                                        allowedTypes={['bar', 'line']}
                                        defaultType="bar"
                                        loading={trendLoading && !trend}
                                        isEmpty={!hasTrend}
                                        height={260}
                                        actions={(
                                            <div className="flex rounded-lg border border-slate-700 bg-slate-800/60 p-0.5">
                                                {TREND_RANGES.map(([key, label]) => (
                                                    <button
                                                        key={key}
                                                        type="button"
                                                        onClick={() => setTrendRange(key)}
                                                        className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                                                            trendRange === key ? 'bg-orange-500/20 text-orange-300' : 'text-slate-400 hover:text-slate-200'
                                                        }`}
                                                    >
                                                        {label}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                        buildData={(type) => toTrendData(trendLabels, [{ label: 'Tracked', data: trend?.hours || [], color: '#f59e0b' }], type)}
                                        buildOptions={(type) => getChartOptions({ type, valueFormat: fmtH })}
                                    />
                                </div>
                                <SwitchableChartCard
                                    title="Status mix"
                                    subtitle="Where the team is right now"
                                    chartKey="dash_status_mix"
                                    allowedTypes={['doughnut', 'pie']}
                                    defaultType="doughnut"
                                    isEmpty={!hasStatusMix}
                                    height={260}
                                    buildData={() => toShareData(statusMix)}
                                    buildOptions={(type) => getChartOptions({ type, showLegend: true, valueFormat: (v) => `${v}` })}
                                />
                            </div>

                            <NeedsAttentionList items={needsAttention} canViewAnalytics={canViewAnalytics} />
                        </section>
                    )}

                    <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        {metrics.map((metric) => {
                            const Icon = metric.icon;
                            return (
                                <div key={metric.label} title={metric.title} className="rounded-lg border border-slate-800 bg-slate-900 p-4 shadow-sm">
                                    <div className="flex items-center gap-3">
                                        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${metric.bg}`}>
                                            <Icon className={`h-5 w-5 ${metric.color}`} />
                                        </span>
                                        <div className="min-w-0">
                                            <div className="text-xl font-bold text-white">{metric.value}</div>
                                            <div className="text-sm font-medium text-slate-200">{metric.label}</div>
                                            <div className="text-[11px] text-slate-400">{metric.sub}</div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </section>

                    <section className="-order-1 rounded-lg border border-slate-800 bg-slate-900 shadow-sm lg:order-none">
                        <div className="flex flex-col gap-3 border-b border-slate-800 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                                <h2 className="text-base font-bold text-white">Time Tracking</h2>
                                <p className="text-sm text-slate-400">Last action: {actionLabel(todayStats.lastAction)}</p>
                            </div>
                            <div className="hidden text-sm text-slate-400 sm:block">Available actions follow your current status.</div>
                        </div>

                        <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-4">
                            {ACTIONS.map((action) => {
                                const Icon = action.icon;
                                const disabled = isActionDisabled(action.type);
                                return (
                                    <button
                                        key={action.type}
                                        type="button"
                                        onClick={() => addEntry(action.type)}
                                        disabled={disabled}
                                        className={`flex min-h-20 items-center gap-3 rounded-lg px-4 py-3 text-left transition ${
                                            disabled
                                                ? 'cursor-not-allowed border border-slate-800 bg-slate-900/60 text-slate-600'
                                                : action.activeClass
                                        }`}
                                    >
                                        <Icon className="h-6 w-6 shrink-0" />
                                        <span>
                                            <span className="block text-sm font-bold">{action.label}</span>
                                            <span className={`block text-xs ${disabled ? 'text-slate-600' : 'opacity-80'}`}>{action.description}</span>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </section>

                    <section className="rounded-lg border border-slate-800 bg-slate-900 shadow-sm">
                        <div className="flex flex-col gap-3 border-b border-slate-800 px-5 py-4">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <h2 className="text-base font-bold text-white">
                                        {canViewTeam ? 'Team' : 'Your Activity Today'}
                                    </h2>
                                    <p className="text-sm text-slate-400">
                                        {!canViewTeam
                                            ? 'Work, break, and attendance status — right now.'
                                            : teamTab === 'shifts'
                                                ? 'Each shift at a glance — who’s in, late, or still clocked in.'
                                                : teamTab === 'live'
                                                    ? 'Who’s clocked in and working right now.'
                                                    : teamTab === 'leaderboard'
                                                        ? `Most tracked time · ${lbRange === 'week' ? 'this week' : 'today'}`
                                                        : (isTodayTable ? 'Work, break, and attendance status — right now.' : `Tracked, in-office and activity · ${tableRangeLabel}`)}
                                    </p>
                                </div>
                                <div className="flex items-center gap-2">
                                    {can('attendance.view') && (
                                        <Link
                                            href={route('employee-attendance.index')}
                                            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-300 transition hover:bg-slate-800 hover:text-white"
                                        >
                                            Open Attendance
                                        </Link>
                                    )}
                                    {((!canViewTeam) || (teamTab === 'table' && isTodayTable)) && employeesData.length > 0 && (
                                        <button
                                            type="button"
                                            onClick={downloadCSV}
                                            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-700"
                                        >
                                            <Download className="h-4 w-4" />
                                            Export
                                        </button>
                                    )}
                                </div>
                            </div>

                            {canViewTeam && (
                                <div className="flex flex-wrap items-center gap-2">
                                    <div className="flex rounded-lg border border-slate-700 bg-slate-800/60 p-0.5">
                                        {TEAM_TABS.map(([key, label, Icon]) => (
                                            <button
                                                key={key}
                                                type="button"
                                                onClick={() => setTeamTab(key)}
                                                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${
                                                    teamTab === key ? 'bg-orange-500/20 text-orange-300' : 'text-slate-400 hover:text-slate-200'
                                                }`}
                                            >
                                                <Icon className="h-3.5 w-3.5" />
                                                {label}
                                            </button>
                                        ))}
                                    </div>

                                    {shiftOptions.length > 0 && (
                                        <SearchableMultiSelect
                                            options={shiftFilterOptions}
                                            selectedValues={shiftIds}
                                            onChange={setShiftIds}
                                            placeholder="All shifts"
                                            searchPlaceholder="Search shift…"
                                        />
                                    )}

                                    {teamTab === 'leaderboard' && (
                                        <div className="flex rounded-lg border border-slate-700 bg-slate-800/60 p-0.5">
                                            {[['today', 'Today'], ['week', 'This week']].map(([key, label]) => (
                                                <button
                                                    key={key}
                                                    type="button"
                                                    onClick={() => setLbRange(key)}
                                                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                                                        lbRange === key ? 'bg-orange-500/20 text-orange-300' : 'text-slate-400 hover:text-slate-200'
                                                    }`}
                                                >
                                                    {label}
                                                </button>
                                            ))}
                                        </div>
                                    )}

                                    {teamTab === 'table' && (
                                        <div className="flex flex-wrap items-center gap-2">
                                            <div className="flex rounded-lg border border-slate-700 bg-slate-800/60 p-0.5">
                                                {TABLE_RANGES.map(([key, label]) => (
                                                    <button
                                                        key={key}
                                                        type="button"
                                                        onClick={() => setTableRange(key)}
                                                        className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                                                            tableRange === key ? 'bg-orange-500/20 text-orange-300' : 'text-slate-400 hover:text-slate-200'
                                                        }`}
                                                    >
                                                        {label}
                                                    </button>
                                                ))}
                                            </div>
                                            {tableRange === 'custom' && (
                                                <div className="flex items-center gap-1.5">
                                                    <input
                                                        type="date"
                                                        value={tableCustom.start}
                                                        max={tableCustom.end || undefined}
                                                        onChange={(e) => setTableCustom((c) => ({ ...c, start: e.target.value }))}
                                                        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
                                                    />
                                                    <span className="text-xs text-slate-500">→</span>
                                                    <input
                                                        type="date"
                                                        value={tableCustom.end}
                                                        min={tableCustom.start || undefined}
                                                        onChange={(e) => setTableCustom((c) => ({ ...c, end: e.target.value }))}
                                                        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {!canViewTeam ? (
                            todayStatusBody
                        ) : teamTab === 'shifts' ? (
                            !dashboardLoaded ? teamLoading : (
                                <ShiftBoardView
                                    board={shiftBoard}
                                    canManage={canClockOutOthers}
                                    onClockOut={(m) => setClockOut({ user_id: m.user_id, name: m.name, time: m.suggested_clock_out || '', note: '', submitting: false })}
                                />
                            )
                        ) : teamTab === 'live' ? (
                            !dashboardLoaded ? teamLoading : <LiveBoardView employees={employeesData} />
                        ) : teamTab === 'leaderboard' ? (
                            <LeaderboardView rows={leaderboardRows} loading={lbRange === 'week' && lbLoading} rangeLabel={lbRange === 'week' ? 'this week' : 'today'} />
                        ) : (
                            isTodayTable ? todayStatusBody : rangedBody
                        )}
                    </section>
                </div>
            </div>

            {clockOut && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
                    onClick={() => !clockOut.submitting && setClockOut(null)}
                >
                    <div className="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                        <div className="mb-4 flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-base font-bold text-white">Clock out {clockOut.name}</h3>
                                <p className="mt-0.5 text-xs text-slate-400">Records a clock-out on their behalf — this is logged.</p>
                            </div>
                            <button type="button" onClick={() => setClockOut(null)} disabled={clockOut.submitting} className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-800 hover:text-white">
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">Clock-out time</label>
                        <input
                            type="time"
                            value={clockOut.time}
                            onChange={(e) => setClockOut((c) => ({ ...c, time: e.target.value }))}
                            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                        />
                        <p className="mt-1 text-[11px] text-slate-500">Defaults to their shift end. Adjust if they left at a different time.</p>
                        <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-slate-400">Note (optional)</label>
                        <input
                            type="text"
                            value={clockOut.note}
                            maxLength={255}
                            placeholder="e.g. forgot to clock out"
                            onChange={(e) => setClockOut((c) => ({ ...c, note: e.target.value }))}
                            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
                        />
                        <div className="mt-5 flex justify-end gap-2">
                            <button type="button" onClick={() => setClockOut(null)} disabled={clockOut.submitting} className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-300 transition hover:bg-slate-800">Cancel</button>
                            <button type="button" onClick={submitClockOut} disabled={clockOut.submitting} className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-60">
                                {clockOut.submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                                Clock out
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </AuthenticatedLayout>
    );
}
