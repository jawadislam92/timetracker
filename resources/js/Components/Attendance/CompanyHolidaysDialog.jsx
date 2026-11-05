import { useEffect, useState } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { CalendarOff, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import Dialog from '@/Components/Reporting/Dialog';
import { showError } from '@/Utils/notifications';

const TYPES = [
    ['H', 'Holiday'],
    ['PH', 'Public holiday'],
];

const fieldClass = 'rounded-lg border-slate-700 bg-slate-950 text-sm text-slate-100 placeholder-slate-500 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500';

/** One line per day off. It applies to everyone, including people who join later. */
export default function CompanyHolidaysDialog({ initialDate, onClose, onChanged }) {
    const [year, setYear] = useState(Number(initialDate.slice(0, 4)));
    const [holidays, setHolidays] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [confirmingId, setConfirmingId] = useState(null);
    const [form, setForm] = useState({ date: initialDate, name: '', status_code: 'PH' });

    const load = async () => {
        setLoading(true);
        try {
            const { data } = await axios.get('/employee-attendance/company-holidays', { params: { year } });
            setHolidays(data.holidays || []);
        } catch {
            showError('Unable to load company holidays.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, [year]);

    const add = async (event) => {
        event.preventDefault();
        setSaving(true);
        try {
            const { data } = await axios.post('/employee-attendance/company-holidays', form);
            toast.success(data.message);
            setForm((current) => ({ ...current, name: '' }));
            const addedYear = Number(form.date.slice(0, 4));
            if (addedYear === year) await load();
            else setYear(addedYear);
            onChanged();
        } catch (error) {
            const errors = error.response?.data?.errors || {};
            showError(errors.date?.[0] || errors.name?.[0] || 'Unable to add the holiday.');
        } finally {
            setSaving(false);
        }
    };

    const remove = async (holiday) => {
        setConfirmingId(null);
        try {
            const { data } = await axios.delete(`/employee-attendance/company-holidays/${holiday.id}`);
            toast.success(data.message);
            await load();
            onChanged();
        } catch {
            showError('Unable to remove the holiday.');
        }
    };

    return (
        <Dialog title="Company holidays" onClose={onClose}>
            <p className="text-sm leading-6 text-slate-400">
                Add a day once and it applies to everyone, including new joiners. Anyone who clocks in that day stays Present, and a mark set on one person still wins.
            </p>

            <form onSubmit={add} className="mt-4 grid gap-2 sm:grid-cols-[auto_1fr_auto_auto]">
                <input
                    type="date"
                    required
                    aria-label="Holiday date"
                    value={form.date}
                    onChange={(event) => setForm({ ...form, date: event.target.value })}
                    className={fieldClass}
                />
                <input
                    required
                    maxLength={120}
                    aria-label="Holiday name"
                    placeholder="Name, e.g. Eid ul Fitr"
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    className={fieldClass}
                />
                <select
                    aria-label="Holiday type"
                    value={form.status_code}
                    onChange={(event) => setForm({ ...form, status_code: event.target.value })}
                    className={fieldClass}
                >
                    {TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <button
                    type="submit"
                    disabled={saving}
                    className="rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:brightness-110 disabled:opacity-50"
                >
                    {saving ? 'Adding...' : 'Add'}
                </button>
            </form>

            <div className="mt-5 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-300">{year}</h3>
                <div className="flex gap-1">
                    <button type="button" onClick={() => setYear(year - 1)} aria-label="Previous year" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white">
                        <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => setYear(year + 1)} aria-label="Next year" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white">
                        <ChevronRight className="h-4 w-4" />
                    </button>
                </div>
            </div>

            {loading ? (
                <p className="py-8 text-center text-sm text-slate-400">Loading holidays...</p>
            ) : holidays.length === 0 ? (
                <div className="py-8 text-center">
                    <CalendarOff className="mx-auto h-8 w-8 text-slate-600" />
                    <p className="mt-2 text-sm text-slate-400">No company holidays in {year}.</p>
                </div>
            ) : (
                <ul className="mt-2 divide-y divide-slate-800 rounded-lg border border-slate-800">
                    {holidays.map((holiday) => (
                        <li key={holiday.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                            <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-slate-100">{holiday.name}</div>
                                <div className="text-xs text-slate-400">{holiday.label} · {holiday.status_label}</div>
                            </div>
                            {confirmingId === holiday.id ? (
                                <div className="flex shrink-0 items-center gap-2">
                                    <button type="button" onClick={() => setConfirmingId(null)} className="rounded-lg px-2 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-800">Keep</button>
                                    <button type="button" onClick={() => remove(holiday)} className="rounded-lg bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-rose-700">Remove</button>
                                </div>
                            ) : (
                                <button type="button" onClick={() => setConfirmingId(holiday.id)} aria-label={`Remove ${holiday.name}`} className="shrink-0 rounded-lg p-1.5 text-slate-500 hover:bg-slate-800 hover:text-rose-300">
                                    <Trash2 className="h-4 w-4" />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </Dialog>
    );
}
