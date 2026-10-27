// Data shaping for the Summary page. The server sends one row per
// person · day · work type · client; everything here is pure and runs in the
// browser so switching company / department / person is instant.

export const TYPES = {
    tracker: { label: 'Upwork tracker', short: 'Tracker', billable: true, color: '#f97316' },
    manual: { label: 'Upwork manual', short: 'Manual', billable: true, color: '#fbbf24' },
    outside_of_upwork: { label: 'Outside Upwork', short: 'Outside', billable: true, color: '#fb7185' },
    fixed: { label: 'Fixed price', short: 'Fixed', billable: true, color: '#f0abfc' },
    office_work: { label: 'Office work', short: 'Office', billable: false, color: '#38bdf8' },
    upwork_bidding: { label: 'Bidding', short: 'Bidding', billable: false, color: '#818cf8' },
    test_task: { label: 'Test tasks', short: 'Tests', billable: false, color: '#2dd4bf' },
};
export const TYPE_KEYS = Object.keys(TYPES);
export const BILLABLE = '#f97316';
export const INTERNAL = '#38bdf8';

export const RANGES = [
    ['this_week', 'This week'],
    ['last_week', 'Last week'],
    ['last_4_weeks', 'Last 4 weeks'],
    ['this_month', 'This month'],
    ['last_month', 'Last month'],
];

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const parseDay = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
};
export const dayKey = (d) => d.toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
export const weekday = (s) => (parseDay(s).getUTCDay() + 6) % 7; // 0 = Monday
export const isWeekend = (s) => weekday(s) >= 5;
export const shortDate = (s) => {
    const d = parseDay(s);
    return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
};
export const dayName = (s) => DOW[weekday(s)];
export const longDate = (s) => `${dayName(s)}, ${shortDate(s)}`;

export function daysBetween(start, end) {
    const out = [];
    for (let d = parseDay(start); dayKey(d) <= end; d = addDays(d, 1)) out.push(dayKey(d));
    return out;
}

/** Monday of each week touched by the range. */
export function weeksBetween(start, end) {
    const out = [];
    let d = parseDay(start);
    d = addDays(d, -((d.getUTCDay() + 6) % 7));
    for (; dayKey(d) <= end; d = addDays(d, 7)) out.push(dayKey(d));
    return out;
}
export const weekOf = (s) => {
    const d = parseDay(s);
    return dayKey(addDays(d, -((d.getUTCDay() + 6) % 7)));
};

export const fmtHours = (n) => {
    if (!n) return '0';
    if (Math.abs(n) >= 100) return Math.round(n).toLocaleString();
    return (Math.round(n * 10) / 10).toLocaleString();
};
export const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);
export const fmtPct = (n) => `${Math.round(n)}%`;

/** One pass over the rows; every widget reads from this. */
export function aggregate(rows, users) {
    const byUser = new Map();
    const byDay = new Map();
    const byClient = new Map();
    const byType = Object.fromEntries(TYPE_KEYS.map((k) => [k, 0]));
    const byDept = new Map();
    let total = 0;
    let billable = 0;

    for (const r of rows) {
        const [uid, d, t, cid, h] = r;
        const bill = TYPES[t]?.billable ?? false;
        total += h;
        if (bill) billable += h;
        byType[t] = (byType[t] || 0) + h;

        let u = byUser.get(uid);
        if (!u) {
            u = { total: 0, billable: 0, days: new Set(), byType: {}, byDay: {} };
            byUser.set(uid, u);
        }
        u.total += h;
        if (bill) u.billable += h;
        u.days.add(d);
        u.byType[t] = (u.byType[t] || 0) + h;
        u.byDay[d] = (u.byDay[d] || 0) + h;

        let day = byDay.get(d);
        if (!day) {
            day = { billable: 0, internal: 0, byType: {} };
            byDay.set(d, day);
        }
        if (bill) day.billable += h;
        else day.internal += h;
        day.byType[t] = (day.byType[t] || 0) + h;

        if (bill && cid) {
            let c = byClient.get(cid);
            if (!c) {
                c = { total: 0, people: new Set(), byType: {}, byDay: {} };
                byClient.set(cid, c);
            }
            c.total += h;
            c.people.add(uid);
            c.byType[t] = (c.byType[t] || 0) + h;
            c.byDay[d] = (c.byDay[d] || 0) + h;
        }

        const dept = users.get(uid)?.department ?? 'Unassigned';
        let dp = byDept.get(dept);
        if (!dp) {
            dp = { total: 0, billable: 0, people: new Set(), byType: {}, byDay: {} };
            byDept.set(dept, dp);
        }
        dp.total += h;
        if (bill) dp.billable += h;
        dp.people.add(uid);
        dp.byType[t] = (dp.byType[t] || 0) + h;
        dp.byDay[d] = (dp.byDay[d] || 0) + h;
    }

    return { total, billable, internal: total - billable, byUser, byDay, byClient, byType, byDept };
}

export function initials(name = '') {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function downloadCsv(filename, header, lines) {
    const cell = (v) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [header, ...lines].map((row) => row.map(cell).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
