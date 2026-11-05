import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import AuthenticatedLayout from '@/Layouts/AuthenticatedLayout';
import { Head } from '@inertiajs/react';
import { useFormatters } from '@/lib/datetime';
import SearchableMultiSelect from '@/Components/Filters/SearchableMultiSelect';
import CompanyHolidaysDialog from '@/Components/Attendance/CompanyHolidaysDialog';
import {
    Activity,
    AlertTriangle,
    CalendarDays,
    CalendarOff,
    CalendarRange,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    Clock,
    Coffee,
    Download,
    History,
    List,
    PauseCircle,
    PlayCircle,
    RotateCcw,
    Search,
    Undo2,
    Send,
    Square,
    Timer,
    Users,
    X,
} from 'lucide-react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { showError, showExportSuccess, showLoading } from '@/Utils/notifications';
import { formatHours } from '@/Utils/timeUtils';

const TABS = [
    { id: 'monthly', label: 'Monthly Grid', icon: CalendarDays },
    { id: 'weekly', label: 'Week', icon: CalendarRange },
    { id: 'summary', label: 'Summary', icon: Activity },
    { id: 'detailed', label: 'Activity', icon: List },
    { id: 'timeline', label: 'Timeline', icon: Timer },
];

const STATUS_OPTIONS = ['all', 'Working', 'On Break', 'Clocked Out', 'Not Started'];

const attendanceSlackFieldOptions = [
    { value: 'present', label: 'Present' },
    { value: 'absent', label: 'Absent' },
    { value: 'leave', label: 'Leave' },
    { value: 'half_day', label: 'Half day' },
    { value: 'work_from_home', label: 'WFH' },
    { value: 'late_coming', label: 'Late coming' },
    { value: 'late_joining', label: 'Late joining' },
    { value: 'holidays', label: 'Holidays' },
    { value: 'public_holiday', label: 'Public holiday' },
    { value: 'total_work_hours', label: 'Hours' },
];

const calendarStatusOptions = [
    { value: 'L', label: 'Leave' },
    { value: 'H', label: 'Holiday' },
    { value: 'PH', label: 'Public holiday' },
    { value: 'WFH', label: 'Work from home' },
    { value: 'HD', label: 'Half day' },
];

const statusStyle = (status) => {
    if (status === 'Working') return 'bg-emerald-500/15 text-emerald-300';
    if (status === 'On Break') return 'bg-amber-500/15 text-amber-300';
    if (status === 'Clocked Out') return 'bg-rose-500/15 text-rose-300';
    return 'bg-slate-700/40 text-slate-300';
};

const gridStatusStyles = {
    P: 'bg-emerald-600 text-white border-emerald-700',
    A: 'bg-fuchsia-500/20 text-fuchsia-200 border-fuchsia-500/40',
    H: 'bg-sky-500/20 text-sky-200 border-sky-500/40',
    L: 'bg-amber-500/20 text-amber-200 border-amber-500/40',
    HD: 'bg-yellow-500/20 text-yellow-200 border-yellow-500/40',
    WFH: 'bg-indigo-500/20 text-indigo-200 border-indigo-500/40',
    LC: 'bg-orange-500/20 text-orange-200 border-orange-500/40',
    LI: 'bg-slate-500/20 text-slate-200 border-slate-500/40',
    PH: 'bg-purple-500/20 text-purple-200 border-purple-500/40',
    empty: 'bg-slate-800/40 text-slate-600 border-slate-800',
};

// Code → meaning for the monthly-grid legend (so the colored codes are readable).
const gridLegend = [
    ['P', 'Present'],
    ['A', 'Absent'],
    ['LC', 'Late coming'],
    ['LI', 'Before joining'],
    ['L', 'Leave'],
    ['H', 'Holiday'],
    ['PH', 'Public holiday'],
    ['WFH', 'Work from home'],
    ['HD', 'Half day'],
];

const actionMeta = (actionType) => {
    if (actionType === 'clock_in') return { label: 'Clocked In', icon: PlayCircle, className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' };
    if (actionType === 'clock_out') return { label: 'Clocked Out', icon: Square, className: 'bg-rose-500/15 text-rose-300 border-rose-500/30' };
    if (actionType === 'break_start') return { label: 'Break Started', icon: PauseCircle, className: 'bg-amber-500/15 text-amber-300 border-amber-500/30' };
    if (actionType === 'break_end') return { label: 'Break Ended', icon: RotateCcw, className: 'bg-blue-500/15 text-blue-300 border-blue-500/30' };
    return { label: actionType, icon: Clock, className: 'bg-slate-700/40 text-slate-300 border-slate-700' };
};

const shiftIsoDate = (iso, days) => {
    const date = new Date(`${iso}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
};

const EmployeeIdentity = ({ employee, size = 'small' }) => {
    const [imageFailed, setImageFailed] = useState(false);
    const avatarSize = size === 'large' ? 'h-11 w-11' : 'h-9 w-9';

    useEffect(() => {
        setImageFailed(false);
    }, [employee.avatar]);

    return (
        <div className="flex min-w-0 items-center gap-3">
            {employee.avatar && !imageFailed ? (
                <img
                    src={employee.avatar}
                    alt=""
                    className={`${avatarSize} shrink-0 rounded-full object-cover`}
                    onError={() => setImageFailed(true)}
                />
            ) : (
                <span className={`flex ${avatarSize} shrink-0 items-center justify-center rounded-full bg-slate-700 text-sm font-bold text-slate-200`}>
                    {employee.user_name.charAt(0).toUpperCase()}
                </span>
            )}
            <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-100">{employee.user_name}</div>
                <div className="truncate text-xs text-slate-400">{employee.designation || 'Member'}</div>
            </div>
        </div>
    );
};

export default function EmployeeAttendance({ auth, serverDate, shiftOptions = [], canManuallyMarkAttendance = false, canEditClockTimes = false, canSendAttendanceSlack = false, slackConfigured = false }) {
    const { formatTime } = useFormatters();
    const canExport = auth.user?.is_super_admin || auth.user?.permissions?.includes('attendance.export');
    const canSendSlack = canSendAttendanceSlack || auth.user?.is_super_admin || auth.user?.permissions?.includes('reports.send_slack');
    const [activeTab, setActiveTab] = useState('monthly');
    const [employeesData, setEmployeesData] = useState([]);
    const [detailedActivityData, setDetailedActivityData] = useState([]);
    const [timelineData, setTimelineData] = useState([]);
    const [monthlyGridData, setMonthlyGridData] = useState({ days: [], employees: [], statusOptions: [], canManualMark: false });
    const [loading, setLoading] = useState(false);
    const [markingCell, setMarkingCell] = useState(null);
    const [showSlackDialog, setShowSlackDialog] = useState(false);
    const [isSendingSlack, setIsSendingSlack] = useState(false);
    const [slackUserIds, setSlackUserIds] = useState([]);
    const [slackFields, setSlackFields] = useState(attendanceSlackFieldOptions.map((field) => field.value));
    const [showHistoryDialog, setShowHistoryDialog] = useState(false);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [manualHistory, setManualHistory] = useState([]);
    const [bulkActions, setBulkActions] = useState([]);
    const [undoingBulkId, setUndoingBulkId] = useState(null);
    const [showHolidaysDialog, setShowHolidaysDialog] = useState(false);
    const [calendarReview, setCalendarReview] = useState(null);
    const [isReviewingCalendar, setIsReviewingCalendar] = useState(false);
    const [selectedDate, setSelectedDate] = useState(serverDate || new Date().toISOString().split('T')[0]);
    const [selectedMonth, setSelectedMonth] = useState((serverDate || new Date().toISOString().split('T')[0]).slice(0, 7));
    const [showCalendarDialog, setShowCalendarDialog] = useState(false);
    const [isUpdatingCalendar, setIsUpdatingCalendar] = useState(false);
    const [calendarOperation, setCalendarOperation] = useState('apply');
    const [calendarScope, setCalendarScope] = useState('company');
    const [calendarUserIds, setCalendarUserIds] = useState([]);
    const [calendarStartDate, setCalendarStartDate] = useState(`${selectedMonth}-01`);
    const [calendarEndDate, setCalendarEndDate] = useState(`${selectedMonth}-01`);
    const [calendarStatus, setCalendarStatus] = useState('L');
    const [calendarNote, setCalendarNote] = useState('');
    const [showClockDialog, setShowClockDialog] = useState(false);
    const [clockEmployee, setClockEmployee] = useState(null);
    const [clockForm, setClockForm] = useState({ clock_in: '', clock_out: '', break_start: '', break_end: '', reason: '' });
    const [clockTzLabel, setClockTzLabel] = useState('');
    const [clockLoading, setClockLoading] = useState(false);
    const [isSavingClock, setIsSavingClock] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterStatus, setFilterStatus] = useState('all');
    const [shiftIds, setShiftIds] = useState([]);
    const shiftFilterOptions = (shiftOptions || []).map((s) => ({ value: String(s.id), label: s.name }))
        .concat([{ value: 'no_shift', label: 'No shift' }]);
    const [expandedEmployees, setExpandedEmployees] = useState({});
    const [lastRefreshTime, setLastRefreshTime] = useState(null);
    const canManualMark = canManuallyMarkAttendance || monthlyGridData.canManualMark;
    const isGridTab = activeTab === 'monthly' || activeTab === 'weekly';
    const historyMonth = activeTab === 'weekly' ? selectedDate.slice(0, 7) : selectedMonth;

    const fetchAttendanceData = async () => {
        setLoading(true);

        try {
            if (isGridTab) {
                const period = activeTab === 'weekly' ? { week: selectedDate } : { month: selectedMonth };
                const response = await axios.get('/employee-attendance/monthly', { params: { ...period, ...(shiftIds.length ? { shift_ids: shiftIds } : {}) } });
                setMonthlyGridData({
                    days: response.data.days || [],
                    employees: response.data.employees || [],
                    statusOptions: response.data.statusOptions || [],
                    canManualMark: Boolean(response.data.canManualMark),
                });
                setLastRefreshTime(new Date());
                return;
            }

            const endpoint = activeTab === 'summary'
                ? '/employee-attendance/summary'
                : activeTab === 'detailed'
                    ? '/employee-attendance/detailed'
                    : '/employee-attendance/timeline';
            const response = await axios.get(endpoint, { params: { date: selectedDate, ...(shiftIds.length ? { shift_ids: shiftIds } : {}) } });

            if (activeTab === 'summary') setEmployeesData(response.data.employees || []);
            if (activeTab === 'detailed') setDetailedActivityData(response.data.activities || []);
            if (activeTab === 'timeline') setTimelineData(response.data.timelines || []);
            setLastRefreshTime(new Date());
        } catch (error) {
            console.error('Attendance load failed:', error);
            showError('Unable to load attendance data.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchAttendanceData();
    }, [selectedDate, selectedMonth, activeTab, shiftIds]);

    const updateManualStatus = async (userId, date, statusCode) => {
        const cellKey = `${userId}-${date}`;
        setMarkingCell(cellKey);

        try {
            await axios.patch('/employee-attendance/manual-status', {
                user_id: userId,
                date,
                status_code: statusCode || null,
            });
            toast.success(statusCode ? 'Attendance status updated.' : 'Manual status cleared.');
            await fetchAttendanceData();
            if (showHistoryDialog) await fetchManualHistory();
        } catch (error) {
            console.error('Manual attendance update failed:', error);
            showError('Unable to update attendance status.');
        } finally {
            setMarkingCell(null);
        }
    };

    const openClockDialog = async (employee) => {
        setClockEmployee(employee);
        setClockForm({ clock_in: '', clock_out: '', break_start: '', break_end: '', reason: '' });
        setShowClockDialog(true);
        setClockLoading(true);
        try {
            const response = await axios.get('/employee-attendance/day-entries', {
                params: { user_id: employee.user_id, date: selectedDate },
            });
            setClockForm({
                clock_in: response.data.clock_in || '',
                clock_out: response.data.clock_out || '',
                break_start: response.data.break_start || '',
                break_end: response.data.break_end || '',
                reason: '',
            });
            setClockTzLabel(response.data.timezone_label || '');
        } catch (error) {
            console.error('Failed to load clock times:', error);
            showError('Unable to load this employee\'s clock times.');
        } finally {
            setClockLoading(false);
        }
    };

    const saveClockTimes = async () => {
        if (!clockEmployee) return;
        if (!clockForm.clock_in) {
            showError('Enter at least a clock-in time.');
            return;
        }
        if (!clockForm.reason.trim()) {
            showError('Please add a reason for this change.');
            return;
        }
        setIsSavingClock(true);
        try {
            const response = await axios.post('/employee-attendance/clock-times', {
                user_id: clockEmployee.user_id,
                date: selectedDate,
                clock_in: clockForm.clock_in || null,
                clock_out: clockForm.clock_out || null,
                break_start: clockForm.break_start || null,
                break_end: clockForm.break_end || null,
                reason: clockForm.reason,
            });
            toast.success(response.data?.message || 'Clock times updated.');
            setShowClockDialog(false);
            setClockEmployee(null);
            await fetchAttendanceData();
        } catch (error) {
            const message = error?.response?.data?.message
                || Object.values(error?.response?.data?.errors || {})[0]?.[0]
                || 'Unable to update clock times.';
            showError(message);
        } finally {
            setIsSavingClock(false);
        }
    };

    const openCalendarDialog = () => {
        const defaultDate = activeTab === 'weekly' || selectedMonth === selectedDate.slice(0, 7)
            ? selectedDate
            : `${selectedMonth}-01`;
        setCalendarReview(null);
        setCalendarOperation('apply');
        setCalendarScope('company');
        setCalendarUserIds(monthlyGridData.employees.map((employee) => String(employee.user_id)));
        setCalendarStartDate(defaultDate);
        setCalendarEndDate(defaultDate);
        setCalendarStatus('L');
        setCalendarNote('');
        setShowCalendarDialog(true);
    };

    const toggleCalendarUser = (userId) => {
        const value = String(userId);
        setCalendarUserIds((current) => (
            current.includes(value)
                ? current.filter((item) => item !== value)
                : [...current, value]
        ));
    };

    const calendarPreview = useMemo(() => {
        const start = Date.parse(`${calendarStartDate}T00:00:00Z`);
        const end = Date.parse(`${calendarEndDate}T00:00:00Z`);
        const days = Number.isFinite(start) && Number.isFinite(end) && end >= start
            ? Math.floor((end - start) / 86400000) + 1
            : 0;
        const users = calendarScope === 'company'
            ? monthlyGridData.employees.length
            : calendarUserIds.length;

        return {
            days,
            users,
            personDays: days * users,
        };
    }, [
        calendarEndDate,
        calendarScope,
        calendarStartDate,
        calendarUserIds.length,
        monthlyGridData.employees.length,
    ]);

    const calendarPayload = () => ({
        operation: calendarOperation,
        scope: calendarScope,
        user_ids: calendarScope === 'selected' ? calendarUserIds : [],
        start_date: calendarStartDate,
        end_date: calendarEndDate,
        status_code: calendarOperation === 'apply' ? calendarStatus : null,
        note: calendarOperation === 'apply' ? calendarNote : null,
    });

    const reviewAttendanceCalendar = async () => {
        setIsReviewingCalendar(true);

        try {
            const response = await axios.post('/employee-attendance/calendar/preview', calendarPayload());
            setCalendarReview(response.data);
        } catch (error) {
            console.error('Attendance calendar preview failed:', error);
            const errors = error.response?.data?.errors || {};
            showError(errors.user_ids?.[0] || errors.start_date?.[0] || errors.end_date?.[0] || errors.status_code?.[0] || 'Unable to review this change.');
        } finally {
            setIsReviewingCalendar(false);
        }
    };

    const updateAttendanceCalendar = async () => {
        setIsUpdatingCalendar(true);

        try {
            const response = await axios.post('/employee-attendance/calendar', calendarPayload());

            toast.success(response.data?.message || 'Attendance calendar updated.');
            setShowCalendarDialog(false);
            setCalendarReview(null);
            await fetchAttendanceData();
            if (showHistoryDialog) await fetchManualHistory();
        } catch (error) {
            console.error('Attendance calendar update failed:', error);
            const errors = error.response?.data?.errors || {};
            showError(
                errors.user_ids?.[0]
                || errors.start_date?.[0]
                || errors.end_date?.[0]
                || errors.status_code?.[0]
                || 'Unable to update the attendance calendar.'
            );
        } finally {
            setIsUpdatingCalendar(false);
        }
    };

    const fetchManualHistory = async () => {
        setHistoryLoading(true);

        try {
            const response = await axios.get('/employee-attendance/manual-history', {
                params: { month: historyMonth },
            });
            setManualHistory(response.data.history || []);
            setBulkActions(response.data.bulk_actions || []);
        } catch (error) {
            console.error('Manual attendance history load failed:', error);
            showError('Unable to load attendance history.');
        } finally {
            setHistoryLoading(false);
        }
    };

    const openHistoryDialog = () => {
        setShowHistoryDialog(true);
        fetchManualHistory();
    };

    useEffect(() => {
        if (showHistoryDialog) fetchManualHistory();
    }, [historyMonth]);

    const undoBulkAction = async (action) => {
        setUndoingBulkId(action.id);

        try {
            const response = await axios.post(`/employee-attendance/bulk-actions/${action.id}/undo`);
            toast.success(response.data?.message || 'Change undone.');
            await Promise.all([fetchAttendanceData(), fetchManualHistory()]);
        } catch (error) {
            console.error('Attendance undo failed:', error);
            showError(error.response?.data?.errors?.bulk_action?.[0] || 'Unable to undo this change.');
        } finally {
            setUndoingBulkId(null);
        }
    };

    const openSlackDialog = () => {
        setSlackUserIds(monthlyGridData.employees.map((employee) => String(employee.user_id)));
        setShowSlackDialog(true);
    };

    const toggleSlackUser = (userId) => {
        const value = String(userId);
        setSlackUserIds((current) => (
            current.includes(value)
                ? current.filter((item) => item !== value)
                : [...current, value]
        ));
    };

    const toggleSlackField = (field) => {
        setSlackFields((current) => (
            current.includes(field)
                ? current.filter((item) => item !== field)
                : [...current, field]
        ));
    };

    const sendAttendanceToSlack = async () => {
        setIsSendingSlack(true);

        try {
            const response = await axios.post('/employee-attendance/slack', {
                month: selectedMonth,
                user_ids: slackUserIds,
                include_fields: slackFields,
            });

            toast.success(response.data?.message || 'Attendance report sent to Slack.');
            setShowSlackDialog(false);
        } catch (error) {
            console.error('Attendance Slack send failed:', error);
            const errors = error.response?.data?.errors || {};
            showError(
                errors.slack?.[0]
                || errors.user_ids?.[0]
                || errors.include_fields?.[0]
                || 'Unable to send attendance report to Slack.'
            );
        } finally {
            setIsSendingSlack(false);
        }
    };

    const downloadCSV = async () => {
        const loadingToast = showLoading('Preparing attendance report...');

        try {
            const response = await axios.get('/employee-attendance/export', {
                params: { date: selectedDate },
                responseType: 'blob',
            });
            const url = window.URL.createObjectURL(new Blob([response.data], { type: 'text/csv' }));
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `employee-attendance-${selectedDate}.csv`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            window.URL.revokeObjectURL(url);
            toast.dismiss(loadingToast);
            showExportSuccess();
        } catch (error) {
            console.error('Attendance export failed:', error);
            toast.dismiss(loadingToast);
            showError('Failed to export attendance report.');
        }
    };

    const normalizedSearch = searchQuery.trim().toLowerCase();
    const matchesSearch = (item) => {
        if (!normalizedSearch) return true;
        return item.user_name?.toLowerCase().includes(normalizedSearch)
            || item.designation?.toLowerCase().includes(normalizedSearch);
    };

    const filteredEmployees = employeesData.filter((employee) =>
        matchesSearch(employee) && (filterStatus === 'all' || employee.current_status === filterStatus)
    );
    const filteredActivities = detailedActivityData.filter(matchesSearch);
    const filteredTimelines = timelineData.filter(matchesSearch);
    const filteredMonthlyEmployees = monthlyGridData.employees.filter(matchesSearch);

    const summaryMetrics = useMemo(() => {
        if (isGridTab) {
            const totals = monthlyGridData.employees.reduce((carry, employee) => {
                carry.present += employee.summary?.present || 0;
                carry.absent += employee.summary?.absent || 0;
                carry.leave += employee.summary?.leave || 0;
                carry.hours += Number(employee.summary?.total_work_hours || 0);
                return carry;
            }, { present: 0, absent: 0, leave: 0, hours: 0 });

            return [
                { label: 'Present Days', value: totals.present, icon: PlayCircle, color: 'text-emerald-300', bg: 'bg-emerald-500/15' },
                { label: 'Absent Days', value: totals.absent, icon: Square, color: 'text-rose-300', bg: 'bg-rose-500/15' },
                { label: 'Leave Days', value: totals.leave, icon: Coffee, color: 'text-amber-300', bg: 'bg-amber-500/15' },
                { label: activeTab === 'weekly' ? 'Week Hours' : 'Month Hours', value: formatHours(totals.hours), icon: Timer, color: 'text-blue-300', bg: 'bg-blue-500/15' },
            ];
        }

        const working = employeesData.filter((employee) => employee.current_status === 'Working').length;
        const onBreak = employeesData.filter((employee) => employee.current_status === 'On Break').length;
        const clockedOut = employeesData.filter((employee) => employee.current_status === 'Clocked Out').length;
        const workHours = employeesData.reduce((sum, employee) => sum + Number(employee.total_work_hours || 0), 0);
        return [
            { label: 'Active', value: working, icon: PlayCircle, color: 'text-emerald-300', bg: 'bg-emerald-500/15' },
            { label: 'On Break', value: onBreak, icon: Coffee, color: 'text-amber-300', bg: 'bg-amber-500/15' },
            { label: 'Clocked Out', value: clockedOut, icon: Square, color: 'text-rose-300', bg: 'bg-rose-500/15' },
            { label: 'Team Hours', value: formatHours(workHours), icon: Timer, color: 'text-blue-300', bg: 'bg-blue-500/15' },
        ];
    }, [activeTab, employeesData, monthlyGridData.employees]);

    const toggleEmployee = (employeeId) => {
        setExpandedEmployees((current) => ({ ...current, [employeeId]: !current[employeeId] }));
    };

    const setAllExpanded = (items, expanded) => {
        if (!expanded) {
            setExpandedEmployees({});
            return;
        }

        setExpandedEmployees(Object.fromEntries(items.map((item) => [item.user_id, true])));
    };

    const renderEmpty = (title, description) => (
        <div className="px-5 py-14 text-center">
            <Users className="mx-auto h-10 w-10 text-slate-600" />
            <h3 className="mt-3 font-semibold text-slate-100">{title}</h3>
            <p className="mt-1 text-sm text-slate-500">{description}</p>
        </div>
    );

    return (
        <AuthenticatedLayout user={auth.user}>
            <Head title="Attendance" />

            <div className="min-h-screen bg-slate-950">
                <div className="mx-auto max-w-none space-y-6 px-4 py-6 sm:px-6 lg:px-8">
                    <section className="flex flex-col gap-4 border-b border-slate-800 pb-5 lg:flex-row lg:items-end lg:justify-between">
                        <div>
                            <p className="text-sm font-semibold text-orange-400">Team operations</p>
                            <h1 className="mt-1 text-2xl font-bold text-white">Attendance</h1>
                            <p className="mt-1 text-sm text-slate-400">Monitor current status, work time, breaks, and daily activity.</p>
                            {lastRefreshTime && (
                                <p className="mt-1 text-xs text-slate-400">Updated {formatTime(lastRefreshTime.toISOString())}</p>
                            )}
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                            {activeTab === 'weekly' && monthlyGridData.days.length > 0 && (
                                <div className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        onClick={() => setSelectedDate(shiftIsoDate(selectedDate, -7))}
                                        aria-label="Previous week"
                                        className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 hover:bg-slate-800"
                                    >
                                        <ChevronLeft className="h-4 w-4" />
                                    </button>
                                    <span className="min-w-36 text-center text-sm font-semibold text-slate-200">
                                        {monthlyGridData.days[0].day} {monthlyGridData.days[0].month_label} to {monthlyGridData.days[monthlyGridData.days.length - 1].day} {monthlyGridData.days[monthlyGridData.days.length - 1].month_label}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setSelectedDate(shiftIsoDate(selectedDate, 7))}
                                        aria-label="Next week"
                                        className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 hover:bg-slate-800"
                                    >
                                        <ChevronRight className="h-4 w-4" />
                                    </button>
                                </div>
                            )}
                            <label className="relative">
                                <CalendarDays className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                                {activeTab === 'monthly' ? (
                                    <input
                                        type="month"
                                        value={selectedMonth}
                                        onChange={(event) => setSelectedMonth(event.target.value)}
                                        className="rounded-lg border border-slate-700 bg-slate-900 py-2 pl-9 pr-3 text-sm text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-2 focus:ring-orange-500"
                                    />
                                ) : (
                                    <input
                                        type="date"
                                        value={selectedDate}
                                        onChange={(event) => setSelectedDate(event.target.value)}
                                        className="rounded-lg border border-slate-700 bg-slate-900 py-2 pl-9 pr-3 text-sm text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-2 focus:ring-orange-500"
                                    />
                                )}
                            </label>
                            {canManualMark && isGridTab && (
                                <>
                                    <button
                                        type="button"
                                        onClick={() => setShowHolidaysDialog(true)}
                                        className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                                    >
                                        <CalendarOff className="h-4 w-4" />
                                        Company holidays
                                    </button>
                                    <button
                                        type="button"
                                        onClick={openCalendarDialog}
                                        className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                                    >
                                        <CalendarRange className="h-4 w-4" />
                                        Attendance calendar
                                    </button>
                                    <button
                                        type="button"
                                        onClick={openHistoryDialog}
                                        className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                                    >
                                        <History className="h-4 w-4" />
                                        Audit history
                                    </button>
                                </>
                            )}
                            {canSendSlack && activeTab === 'monthly' && (
                                <button
                                    type="button"
                                    onClick={openSlackDialog}
                                    className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                                >
                                    <Send className="h-4 w-4" />
                                    Send to Slack
                                </button>
                            )}
                            {canExport && !isGridTab && (
                                <button
                                    type="button"
                                    onClick={downloadCSV}
                                    className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
                                >
                                    <Download className="h-4 w-4" />
                                    Export CSV
                                </button>
                            )}
                        </div>
                    </section>

                    <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        {summaryMetrics.map((metric) => {
                            const Icon = metric.icon;
                            return (
                                <div key={metric.label} className="rounded-lg border border-slate-800 bg-slate-900 p-4 shadow-sm">
                                    <div className="flex items-center gap-3">
                                        <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${metric.bg}`}>
                                            <Icon className={`h-5 w-5 ${metric.color}`} />
                                        </span>
                                        <div>
                                            <div className="text-xl font-bold text-slate-100">{metric.value}</div>
                                            <div className="text-sm text-slate-400">{metric.label}</div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </section>

                    <section className="rounded-lg border border-slate-800 bg-slate-900 shadow-sm">
                        <div className="flex flex-col gap-4 border-b border-slate-800 p-4 lg:flex-row lg:items-center lg:justify-between">
                            <div className="grid w-full grid-cols-2 gap-1 rounded-lg bg-slate-950/60 p-1 sm:grid-cols-5 lg:inline-flex lg:w-auto">
                                {TABS.map((tab) => {
                                    const Icon = tab.icon;
                                    return (
                                        <button
                                            key={tab.id}
                                            type="button"
                                            onClick={() => setActiveTab(tab.id)}
                                            className={`inline-flex min-w-0 items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-semibold transition lg:flex-none lg:px-4 ${
                                                activeTab === tab.id
                                                    ? 'bg-slate-800 text-white shadow-sm'
                                                    : 'text-slate-400 hover:text-white'
                                            }`}
                                        >
                                            <Icon className="h-4 w-4" />
                                            {tab.label}
                                        </button>
                                    );
                                })}
                            </div>

                            <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
                                <label className="relative min-w-64 flex-1">
                                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                                    <input
                                        type="search"
                                        value={searchQuery}
                                        onChange={(event) => setSearchQuery(event.target.value)}
                                        placeholder="Search employee or designation"
                                        className="w-full rounded-lg border border-slate-700 bg-slate-900 py-2 pl-9 pr-3 text-sm text-slate-200 placeholder-slate-500 focus:border-orange-500 focus:ring-2 focus:ring-orange-500"
                                    />
                                </label>

                                {activeTab === 'summary' && (
                                    <select
                                        value={filterStatus}
                                        onChange={(event) => setFilterStatus(event.target.value)}
                                        className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-2 focus:ring-orange-500"
                                    >
                                        {STATUS_OPTIONS.map((status) => (
                                            <option key={status} value={status}>
                                                {status === 'all' ? 'All statuses' : status}
                                            </option>
                                        ))}
                                    </select>
                                )}
                                {shiftOptions.length > 0 && (
                                    <SearchableMultiSelect
                                        options={shiftFilterOptions}
                                        selectedValues={shiftIds}
                                        onChange={setShiftIds}
                                        placeholder="All shifts"
                                        searchPlaceholder="Search shift…"
                                    />
                                )}
                            </div>
                        </div>

                        {loading ? (
                            <div className="flex items-center justify-center gap-3 px-5 py-16 text-sm font-medium text-slate-400">
                                <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-orange-500" />
                                Loading attendance data...
                            </div>
                        ) : (
                            <>
                                {isGridTab && (
                                    filteredMonthlyEmployees.length === 0
                                        ? renderEmpty('No attendance records', `No employees match the selected ${activeTab === 'weekly' ? 'week' : 'month'} and search.`)
                                        : (
                                            <MonthlyAttendanceGrid
                                                days={monthlyGridData.days}
                                                employees={filteredMonthlyEmployees}
                                                statusOptions={monthlyGridData.statusOptions}
                                                canManualMark={canManualMark}
                                                showHours={activeTab === 'weekly'}
                                                markingCell={markingCell}
                                                onStatusChange={updateManualStatus}
                                            />
                                        )
                                )}

                                {activeTab === 'summary' && (
                                    filteredEmployees.length === 0
                                        ? renderEmpty('No attendance records', 'No employees match the selected date and filters.')
                                        : (
                                            <div className="overflow-x-auto">
                                                <table className="min-w-full divide-y divide-slate-800">
                                                    <thead className="bg-slate-950/40">
                                                        <tr>
                                                            {['Employee', 'Status', 'Shift', 'Work Hours', 'Break', 'First In', 'Last Activity', 'Actions'].map((heading) => (
                                                                <th key={heading} className="whitespace-nowrap px-4 py-3 text-left text-xs font-bold uppercase text-slate-500">{heading}</th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody className="divide-y divide-slate-800">
                                                        {filteredEmployees.map((employee) => (
                                                            <tr key={employee.user_id} className="transition hover:bg-slate-800/40">
                                                                <td className="px-4 py-3"><EmployeeIdentity employee={employee} /></td>
                                                                <td className="whitespace-nowrap px-4 py-3">
                                                                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyle(employee.current_status)}`}>
                                                                        {employee.current_status}
                                                                    </span>
                                                                </td>
                                                                <td className="whitespace-nowrap px-4 py-3 text-xs">
                                                                    {employee.shift_name
                                                                        ? <span className="rounded-full bg-slate-800 px-2 py-0.5 font-medium text-slate-200">{employee.shift_name}</span>
                                                                        : <span className="text-slate-500">—</span>}
                                                                </td>
                                                                <td className="whitespace-nowrap px-4 py-3 text-sm font-semibold text-slate-100">{formatHours(employee.total_work_hours)}</td>
                                                                <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-300">{formatHours(employee.total_break_hours)}</td>
                                                                <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-300">{employee.first_clock_in || '-'}</td>
                                                                <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-300">{employee.last_action_time || '-'}</td>
                                                                <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-300">
                                                                    <div className="flex items-center gap-3">
                                                                        <span>{employee.total_entries}</span>
                                                                        {canEditClockTimes && (
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => openClockDialog(employee)}
                                                                                className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs font-semibold text-slate-200 transition hover:border-blue-500 hover:bg-blue-500/10 hover:text-blue-300"
                                                                                title="Set or correct this employee's clock-in/out times for this day"
                                                                            >
                                                                                Edit times
                                                                            </button>
                                                                        )}
                                                                    </div>
                                                                </td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        )
                                )}

                                {activeTab === 'detailed' && (
                                    filteredActivities.length === 0
                                        ? renderEmpty('No activity records', 'No activity matches the selected date and search.')
                                        : (
                                            <AccordionList
                                                items={filteredActivities}
                                                expandedEmployees={expandedEmployees}
                                                toggleEmployee={toggleEmployee}
                                                setAllExpanded={setAllExpanded}
                                                renderContent={(activity) => (
                                                    <div className="space-y-2">
                                                        {activity.entries.map((entry) => {
                                                            const meta = actionMeta(entry.action_type);
                                                            const Icon = meta.icon;
                                                            return (
                                                                <div key={entry.id} className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900 p-3">
                                                                    <span className={`flex h-9 w-9 items-center justify-center rounded-lg border ${meta.className}`}>
                                                                        <Icon className="h-4 w-4" />
                                                                    </span>
                                                                    <div className="flex-1">
                                                                        <div className="text-sm font-semibold text-slate-100">{meta.label}</div>
                                                                        <div className="text-xs text-slate-500">{entry.action_iso ? formatTime(entry.action_iso) : entry.formatted_time}</div>
                                                                    </div>
                                                                    {entry.notes && <div className="text-sm text-slate-300">{entry.notes}</div>}
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                )}
                                            />
                                        )
                                )}

                                {activeTab === 'timeline' && (
                                    filteredTimelines.length === 0
                                        ? renderEmpty('No timeline records', 'No sessions match the selected date and search.')
                                        : (
                                            <AccordionList
                                                items={filteredTimelines}
                                                expandedEmployees={expandedEmployees}
                                                toggleEmployee={toggleEmployee}
                                                setAllExpanded={setAllExpanded}
                                                renderContent={(timeline) => (
                                                    <div className="space-y-2">
                                                        {timeline.sessions.map((session, index) => (
                                                            <div key={`${timeline.user_id}-${index}`} className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900 p-3 sm:flex-row sm:items-center sm:justify-between">
                                                                <div className="flex items-center gap-3">
                                                                    <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                                                                        session.type === 'work' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
                                                                    }`}>
                                                                        {session.type === 'work' ? <Timer className="h-4 w-4" /> : <Coffee className="h-4 w-4" />}
                                                                    </span>
                                                                    <div>
                                                                        <div className="text-sm font-semibold text-slate-100">
                                                                            {session.type === 'work' ? 'Work Session' : 'Break'}
                                                                        </div>
                                                                        <div className="text-xs text-slate-500">
                                                                            {session.start_time} to {session.end_time || 'Ongoing'}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                                <div className="text-sm font-bold text-slate-100">{session.duration}</div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            />
                                        )
                                )}
                            </>
                        )}
                    </section>
                </div>
            </div>

            {showClockDialog && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
                    <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
                        <div className="mb-4 flex items-start justify-between">
                            <div>
                                <h3 className="text-lg font-bold text-slate-100">Edit clock times</h3>
                                <p className="mt-1 text-sm text-slate-400">
                                    {clockEmployee?.user_name ? `${clockEmployee.user_name} · ` : ''}{selectedDate}
                                </p>
                                {clockTzLabel && (
                                    <p className="mt-1 text-xs font-medium text-orange-400">
                                        Times shown in {clockTzLabel} (this person&apos;s timezone)
                                    </p>
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowClockDialog(false)}
                                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        <p className="mb-4 rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-slate-300">
                            Set the employee&apos;s real clock-in and clock-out (and any break). This creates the in-office
                            window so they can then log their own manual time. Break is optional; leave a field blank to omit
                            it. Every change is audited.
                        </p>

                        {clockLoading ? (
                            <p className="py-6 text-center text-sm text-slate-400">Loading current times…</p>
                        ) : (
                            <div className="space-y-4">
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Clock in <span className="text-red-400">*</span></label>
                                        <input
                                            type="time"
                                            value={clockForm.clock_in}
                                            onChange={(e) => setClockForm((f) => ({ ...f, clock_in: e.target.value }))}
                                            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                                        />
                                    </div>
                                    <div>
                                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Clock out</label>
                                        <input
                                            type="time"
                                            value={clockForm.clock_out}
                                            onChange={(e) => setClockForm((f) => ({ ...f, clock_out: e.target.value }))}
                                            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                                        />
                                    </div>
                                    <div>
                                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Break start</label>
                                        <input
                                            type="time"
                                            value={clockForm.break_start}
                                            onChange={(e) => setClockForm((f) => ({ ...f, break_start: e.target.value }))}
                                            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                                        />
                                    </div>
                                    <div>
                                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Break end</label>
                                        <input
                                            type="time"
                                            value={clockForm.break_end}
                                            onChange={(e) => setClockForm((f) => ({ ...f, break_end: e.target.value }))}
                                            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                                        />
                                    </div>
                                </div>
                                <div>
                                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Reason <span className="text-red-400">*</span></label>
                                    <input
                                        type="text"
                                        value={clockForm.reason}
                                        maxLength={255}
                                        placeholder="e.g. Forgot to clock in; arrived 9:00, confirmed with manager"
                                        onChange={(e) => setClockForm((f) => ({ ...f, reason: e.target.value }))}
                                        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-600"
                                    />
                                </div>
                            </div>
                        )}

                        <div className="mt-6 flex items-center justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setShowClockDialog(false)}
                                className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={saveClockTimes}
                                disabled={isSavingClock || clockLoading}
                                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                            >
                                {isSavingClock ? 'Saving…' : 'Save clock times'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showCalendarDialog && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
                    <div className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-lg border border-slate-800 bg-slate-900 shadow-xl">
                        <div className="flex items-start justify-between border-b border-slate-800 px-5 py-4">
                            <div>
                                <h2 className="text-lg font-bold text-white">Attendance calendar</h2>
                                <p className="mt-1 text-sm text-slate-400">Schedule or remove attendance statuses for a date range.</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowCalendarDialog(false)}
                                className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                                title="Close"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        {calendarReview ? (
                            <CalendarReview review={calendarReview} />
                        ) : (
                        <div className="space-y-5 overflow-y-auto px-5 py-4">
                            <fieldset>
                                <legend className="text-sm font-semibold text-slate-300">Action</legend>
                                <div className="mt-2 grid grid-cols-2 gap-2">
                                    {[
                                        ['apply', 'Apply or replace'],
                                        ['clear', 'Remove scheduled marks'],
                                    ].map(([value, label]) => (
                                        <button
                                            key={value}
                                            type="button"
                                            onClick={() => setCalendarOperation(value)}
                                            className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                                                calendarOperation === value
                                                    ? 'border-orange-500 bg-orange-500/10 text-orange-300'
                                                    : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600'
                                            }`}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </div>
                            </fieldset>

                            <div className="grid gap-4 sm:grid-cols-2">
                                <label>
                                    <span className="mb-1.5 block text-sm font-semibold text-slate-300">Start date</span>
                                    <input
                                        type="date"
                                        value={calendarStartDate}
                                        onChange={(event) => {
                                            // The end date follows, so picking one day means one day.
                                            setCalendarStartDate(event.target.value);
                                            setCalendarEndDate(event.target.value);
                                        }}
                                        className="w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500"
                                    />
                                </label>
                                <label>
                                    <span className="mb-1.5 block text-sm font-semibold text-slate-300">End date</span>
                                    <input
                                        type="date"
                                        min={calendarStartDate}
                                        value={calendarEndDate}
                                        onChange={(event) => setCalendarEndDate(event.target.value)}
                                        className="w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500"
                                    />
                                </label>
                            </div>

                            <fieldset>
                                <legend className="text-sm font-semibold text-slate-300">People</legend>
                                <div className="mt-2 grid grid-cols-2 gap-2">
                                    {[
                                        ['company', 'Whole company'],
                                        ['selected', 'Selected people'],
                                    ].map(([value, label]) => (
                                        <button
                                            key={value}
                                            type="button"
                                            onClick={() => setCalendarScope(value)}
                                            className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                                                calendarScope === value
                                                    ? 'border-orange-500 bg-orange-500/10 text-orange-300'
                                                    : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600'
                                            }`}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </div>
                            </fieldset>

                            {calendarScope === 'selected' && (
                                <div>
                                    <div className="mb-2 flex items-center justify-between">
                                        <span className="text-sm font-semibold text-slate-300">Select people</span>
                                        <div className="flex gap-3">
                                            <button
                                                type="button"
                                                onClick={() => setCalendarUserIds(monthlyGridData.employees.map((employee) => String(employee.user_id)))}
                                                className="text-xs font-semibold text-orange-400 hover:text-orange-300"
                                            >
                                                Select all
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setCalendarUserIds([])}
                                                className="text-xs font-semibold text-slate-400 hover:text-slate-200"
                                            >
                                                Clear
                                            </button>
                                        </div>
                                    </div>
                                    <div className="grid max-h-48 grid-cols-1 gap-1 overflow-y-auto rounded-lg border border-slate-800 p-2 sm:grid-cols-2">
                                        {monthlyGridData.employees.map((employee) => (
                                            <label key={employee.user_id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-800">
                                                <input
                                                    type="checkbox"
                                                    checked={calendarUserIds.includes(String(employee.user_id))}
                                                    onChange={() => toggleCalendarUser(employee.user_id)}
                                                    className="rounded border-slate-700 bg-slate-900 text-orange-500 focus:ring-orange-500"
                                                />
                                                <span className="text-sm font-medium text-slate-200">{employee.user_name}</span>
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {calendarOperation === 'apply' && (
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <label>
                                        <span className="mb-1.5 block text-sm font-semibold text-slate-300">Status</span>
                                        <select
                                            value={calendarStatus}
                                            onChange={(event) => setCalendarStatus(event.target.value)}
                                            className="w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500"
                                        >
                                            {calendarStatusOptions.map((status) => (
                                                <option key={status.value} value={status.value}>{status.label}</option>
                                            ))}
                                        </select>
                                    </label>
                                    <label>
                                        <span className="mb-1.5 block text-sm font-semibold text-slate-300">Note</span>
                                        <input
                                            value={calendarNote}
                                            maxLength={255}
                                            onChange={(event) => setCalendarNote(event.target.value)}
                                            placeholder="Optional reason"
                                            className="w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 placeholder-slate-500 focus:border-orange-500 focus:ring-orange-500"
                                        />
                                    </label>
                                </div>
                            )}

                            <div className={`rounded-lg border px-4 py-3 ${
                                calendarOperation === 'clear'
                                    ? 'border-rose-500/30 bg-rose-500/10'
                                    : 'border-blue-500/30 bg-blue-500/10'
                            }`}>
                                <div className="text-sm font-bold text-white">
                                    Preview: {calendarPreview.users} people x {calendarPreview.days} {calendarPreview.days === 1 ? 'day' : 'days'} = {calendarPreview.personDays} person-days
                                </div>
                                <p className="mt-1 text-xs leading-5 text-slate-400">
                                    {calendarOperation === 'clear'
                                        ? 'This removes all manual attendance marks in the selected range. Automatic attendance will appear again.'
                                        : 'Existing manual marks in the selected range will be replaced with this status.'}
                                </p>
                            </div>
                            {calendarOperation === 'apply' && calendarScope === 'company' && ['H', 'PH'].includes(calendarStatus) && (
                                <p className="text-xs leading-5 text-slate-400">
                                    Giving everyone a day off?{' '}
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowCalendarDialog(false);
                                            setShowHolidaysDialog(true);
                                        }}
                                        className="font-semibold text-orange-400 hover:text-orange-300"
                                    >
                                        Use Company holidays
                                    </button>
                                    {' '}instead. It covers new joiners and never hides a real clock-in.
                                </p>
                            )}
                        </div>
                        )}

                        <div className="flex flex-col-reverse gap-2 border-t border-slate-800 px-5 py-4 sm:flex-row sm:justify-end">
                            <button
                                type="button"
                                onClick={() => (calendarReview ? setCalendarReview(null) : setShowCalendarDialog(false))}
                                className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800"
                            >
                                {calendarReview ? 'Back' : 'Cancel'}
                            </button>
                            <button
                                type="button"
                                onClick={calendarReview ? updateAttendanceCalendar : reviewAttendanceCalendar}
                                disabled={
                                    isUpdatingCalendar
                                    || isReviewingCalendar
                                    || (calendarReview && calendarReview.cells === 0)
                                    || calendarPreview.personDays === 0
                                    || (calendarScope === 'selected' && calendarUserIds.length === 0)
                                }
                                className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-700 ${
                                    calendarOperation === 'clear'
                                        ? 'bg-rose-600 hover:bg-rose-700'
                                        : 'bg-blue-600 hover:bg-blue-700'
                                }`}
                            >
                                {isUpdatingCalendar
                                    ? 'Updating...'
                                    : isReviewingCalendar
                                        ? 'Checking...'
                                        : !calendarReview
                                            ? 'Review change'
                                            : calendarOperation === 'clear'
                                                ? 'Confirm and remove'
                                                : 'Confirm and apply'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showHistoryDialog && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
                    <div className="flex max-h-[90vh] w-full max-w-5xl flex-col rounded-lg border border-slate-800 bg-slate-900 shadow-xl">
                        <div className="flex items-start justify-between border-b border-slate-800 px-5 py-4">
                            <div>
                                <h2 className="text-lg font-bold text-white">Manual attendance audit</h2>
                                <p className="mt-1 text-sm text-slate-400">Latest manual changes for {selectedMonth}.</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowHistoryDialog(false)}
                                className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                                title="Close"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        <div className="overflow-y-auto px-5 py-4">
                            {historyLoading ? (
                                <div className="flex items-center justify-center gap-3 py-12 text-sm font-medium text-slate-400">
                                    <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-orange-500" />
                                    Loading audit history...
                                </div>
                            ) : manualHistory.length === 0 && bulkActions.length === 0 ? (
                                <div className="py-12 text-center">
                                    <History className="mx-auto h-10 w-10 text-slate-500" />
                                    <h3 className="mt-3 font-semibold text-slate-100">No manual changes</h3>
                                    <p className="mt-1 text-sm text-slate-400">No manual attendance edits were recorded for this month.</p>
                                </div>
                            ) : (
                                <div className="space-y-5">
                                {bulkActions.length > 0 && (
                                    <section>
                                        <h3 className="mb-2 text-sm font-semibold text-slate-300">Bulk changes</h3>
                                        <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
                                            {bulkActions.map((action) => (
                                                <li key={action.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                                                    <div className="min-w-0">
                                                        <div className="text-sm font-semibold text-slate-100">
                                                            {action.status_label} · {action.people} {action.people === 1 ? 'person' : 'people'} × {action.days} {action.days === 1 ? 'day' : 'days'}
                                                        </div>
                                                        <div className="text-xs text-slate-400">
                                                            {action.range} · {action.cells} {action.cells === 1 ? 'cell' : 'cells'} changed · {action.changed_by}, {action.changed_at}
                                                        </div>
                                                    </div>
                                                    {action.undone ? (
                                                        <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-400">Undone</span>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            disabled={undoingBulkId !== null}
                                                            onClick={() => undoBulkAction(action)}
                                                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-orange-500 hover:bg-orange-500/10 hover:text-orange-300 disabled:opacity-50"
                                                        >
                                                            <Undo2 className="h-3.5 w-3.5" />
                                                            {undoingBulkId === action.id ? 'Undoing...' : 'Undo'}
                                                        </button>
                                                    )}
                                                </li>
                                            ))}
                                        </ul>
                                    </section>
                                )}
                                {manualHistory.length > 0 && (
                                <div className="overflow-x-auto rounded-lg border border-slate-800">
                                    <table className="min-w-full divide-y divide-slate-800 text-sm">
                                        <thead className="bg-slate-950">
                                            <tr>
                                                {['Date', 'Employee', 'Change', 'Changed by', 'Changed at', 'Reason'].map((heading) => (
                                                    <th key={heading} className="whitespace-nowrap px-4 py-3 text-left text-xs font-bold uppercase text-slate-300">
                                                        {heading}
                                                    </th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-800 bg-slate-900">
                                            {manualHistory.map((entry) => (
                                                <tr key={entry.id} className="hover:bg-slate-800/40">
                                                    <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-100">{entry.attendance_date}</td>
                                                    <td className="px-4 py-3">
                                                        <div className="font-semibold text-slate-100">{entry.employee_name}</div>
                                                        <div className="text-xs text-slate-400">{entry.employee_designation || 'Member'}</div>
                                                    </td>
                                                    <td className="whitespace-nowrap px-4 py-3">
                                                        <div className="flex items-center gap-2">
                                                            <AuditStatusChip code={entry.old_status_code} label={entry.old_status_label} />
                                                            <span className="text-slate-400">to</span>
                                                            <AuditStatusChip code={entry.new_status_code} label={entry.new_status_label} />
                                                        </div>
                                                    </td>
                                                    <td className="whitespace-nowrap px-4 py-3 text-slate-300">{entry.changed_by}</td>
                                                    <td className="whitespace-nowrap px-4 py-3 text-slate-300">{entry.changed_at || '-'}</td>
                                                    <td className="min-w-48 px-4 py-3 text-slate-300">{entry.reason || '-'}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                                )}
                                </div>
                            )}
                        </div>

                        <div className="flex justify-end border-t border-slate-800 px-5 py-4">
                            <button
                                type="button"
                                onClick={() => setShowHistoryDialog(false)}
                                className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showHolidaysDialog && (
                <CompanyHolidaysDialog
                    initialDate={selectedDate}
                    onClose={() => setShowHolidaysDialog(false)}
                    onChanged={fetchAttendanceData}
                />
            )}

            {showSlackDialog && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
                    <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg border border-slate-800 bg-slate-900 shadow-xl">
                        <div className="flex items-start justify-between border-b border-slate-800 px-5 py-4">
                            <div>
                                <h2 className="text-lg font-bold text-white">Send attendance to Slack</h2>
                                <p className="mt-1 text-sm text-slate-400">Choose users and summary columns for {selectedMonth}.</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowSlackDialog(false)}
                                className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                                title="Close"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        <div className="space-y-5 overflow-y-auto px-5 py-4">
                            <div className={`rounded-lg border px-3 py-2 text-sm ${
                                slackConfigured
                                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                                    : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                            }`}>
                                {slackConfigured ? 'Slack webhook connected.' : 'Slack webhook is not configured.'}
                            </div>

                            <div>
                                <div className="mb-2 flex items-center justify-between">
                                    <h3 className="text-sm font-semibold text-slate-300">Users to include</h3>
                                    <div className="flex gap-2">
                                        <button
                                            type="button"
                                            onClick={() => setSlackUserIds(monthlyGridData.employees.map((employee) => String(employee.user_id)))}
                                            className="text-xs font-semibold text-orange-400 hover:text-orange-300"
                                        >
                                            Select all
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setSlackUserIds([])}
                                            className="text-xs font-semibold text-slate-400 hover:text-slate-200"
                                        >
                                            Clear
                                        </button>
                                    </div>
                                </div>
                                <div className="grid max-h-48 grid-cols-1 gap-2 overflow-y-auto rounded-lg border border-slate-800 p-2 sm:grid-cols-2">
                                    {monthlyGridData.employees.map((employee) => (
                                        <label key={employee.user_id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-800">
                                            <input
                                                type="checkbox"
                                                checked={slackUserIds.includes(String(employee.user_id))}
                                                onChange={() => toggleSlackUser(employee.user_id)}
                                                className="rounded border-slate-700 bg-slate-900 text-orange-500 focus:ring-orange-500"
                                            />
                                            <span className="text-sm font-medium text-slate-200">{employee.user_name}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>

                            <fieldset>
                                <legend className="text-sm font-semibold text-slate-300">Data to include</legend>
                                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                                    {attendanceSlackFieldOptions.map((field) => {
                                        const checked = slackFields.includes(field.value);

                                        return (
                                            <label
                                                key={field.value}
                                                className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm font-semibold transition ${
                                                    checked
                                                        ? 'border-orange-500/40 bg-orange-500/10 text-orange-300'
                                                        : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600'
                                                }`}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={() => toggleSlackField(field.value)}
                                                    className="rounded border-slate-700 bg-slate-900 text-orange-500 focus:ring-orange-500"
                                                />
                                                {field.label}
                                            </label>
                                        );
                                    })}
                                </div>
                            </fieldset>

                            <p className="rounded-lg bg-slate-950/60 px-3 py-2 text-xs leading-5 text-slate-400">
                                Late coming is calculated from each person's shift start time and grace period, and counts in both Present and Late coming totals. Late joining is for days before the employee's joining date.
                            </p>
                        </div>

                        <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-4">
                            <button
                                type="button"
                                onClick={() => setShowSlackDialog(false)}
                                className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={sendAttendanceToSlack}
                                disabled={!slackConfigured || isSendingSlack || slackUserIds.length === 0 || slackFields.length === 0}
                                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-700"
                            >
                                {isSendingSlack ? 'Sending...' : 'Send report'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </AuthenticatedLayout>
    );
}

function AuditStatusChip({ code, label }) {
    const statusClass = gridStatusStyles[code] || gridStatusStyles.empty;

    return (
        <span
            className={`inline-flex min-w-14 items-center justify-center rounded border px-2 py-1 text-xs font-bold ${statusClass}`}
            title={label}
        >
            {code || 'Auto'}
        </span>
    );
}

function AccordionList({ items, expandedEmployees, toggleEmployee, setAllExpanded, renderContent }) {
    return (
        <div>
            <div className="flex justify-end gap-2 border-b border-slate-800 px-4 py-3">
                <button
                    type="button"
                    onClick={() => setAllExpanded(items, true)}
                    className="rounded-lg px-3 py-2 text-sm font-semibold text-orange-400 transition hover:bg-orange-500/10"
                >
                    Expand all
                </button>
                <button
                    type="button"
                    onClick={() => setAllExpanded(items, false)}
                    className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-400 transition hover:bg-slate-800"
                >
                    Collapse all
                </button>
            </div>

            <div className="divide-y divide-slate-800">
                {items.map((item) => {
                    const expanded = Boolean(expandedEmployees[item.user_id]);
                    return (
                        <div key={item.user_id}>
                            <button
                                type="button"
                                onClick={() => toggleEmployee(item.user_id)}
                                className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left transition hover:bg-slate-800/40"
                            >
                                <EmployeeIdentity employee={item} size="large" />
                                <div className="flex items-center gap-3">
                                    {item.entries && <span className="text-sm font-semibold text-slate-400">{item.entries.length} actions</span>}
                                    {item.sessions && (
                                        <span className="hidden text-sm text-slate-400 sm:inline">
                                            {formatHours(item.total_work_hours)} work, {formatHours(item.total_break_hours)} break
                                        </span>
                                    )}
                                    {expanded ? <ChevronUp className="h-5 w-5 text-slate-500" /> : <ChevronDown className="h-5 w-5 text-slate-500" />}
                                </div>
                            </button>
                            {expanded && <div className="border-t border-slate-800 bg-slate-950/40 p-4">{renderContent(item)}</div>}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

const MAX_NAMED_DAYS = 14;

function CalendarReview({ review }) {
    const clear = review.operation === 'clear';
    const named = review.days.slice(0, MAX_NAMED_DAYS).map((day) => day.label).join(', ');
    const extra = review.days.length - MAX_NAMED_DAYS;
    const dayList = extra > 0 ? `${named} and ${extra} more` : named;
    const peopleLabel = `${review.people} ${review.people === 1 ? 'person' : 'people'}`;
    const clockIns = review.days.filter((day) => day.clocked_in > 0);

    return (
        <div className="space-y-4 overflow-y-auto px-5 py-4">
            <div className={`rounded-lg border px-4 py-3 ${clear ? 'border-rose-500/30 bg-rose-500/10' : 'border-blue-500/30 bg-blue-500/10'}`}>
                <p className="text-base font-bold leading-7 text-white">
                    {clear
                        ? `Remove ${review.cells} manual ${review.cells === 1 ? 'mark' : 'marks'} on ${dayList} for ${peopleLabel}`
                        : `${review.status_label} on ${dayList} for ${peopleLabel}`}
                </p>
                <p className="mt-1 text-xs text-slate-300">
                    {review.days.length} {review.days.length === 1 ? 'day' : 'days'} · {review.cells} {review.cells === 1 ? 'cell' : 'cells'}
                </p>
            </div>

            {review.cells === 0 && (
                <p className="text-sm text-slate-300">There is nothing to remove in this range.</p>
            )}

            {!clear && clockIns.length > 0 && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
                    <div className="flex items-center gap-2 text-sm font-bold text-amber-200">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        This hides real attendance
                    </div>
                    <ul className="mt-2 space-y-1 text-sm text-amber-100">
                        {clockIns.slice(0, MAX_NAMED_DAYS).map((day) => (
                            <li key={day.date}>
                                {day.clocked_in} {day.clocked_in === 1 ? 'person' : 'people'} already clocked in on {day.label}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {!clear && review.replaced > 0 && (
                <p className="text-sm text-slate-300">
                    {review.replaced} existing manual {review.replaced === 1 ? 'mark' : 'marks'} will be replaced.
                </p>
            )}

            {review.cells > 0 && <p className="text-xs text-slate-400">You can undo this afterwards from Audit history.</p>}
        </div>
    );
}

function MonthlyAttendanceGrid({ days, employees, statusOptions, canManualMark, showHours = false, markingCell, onStatusChange }) {
    const [openCell, setOpenCell] = useState(null);
    const [menuPosition, setMenuPosition] = useState(null);
    const summaryColumns = [
        { key: 'holidays', label: 'Holidays' },
        { key: 'public_holiday', label: 'Public H.' },
        { key: 'present', label: 'Present' },
        { key: 'absent', label: 'Absent' },
        { key: 'leave', label: 'Leave' },
        { key: 'half_day', label: 'Half day' },
        { key: 'work_from_home', label: 'WFH' },
        { key: 'late_coming', label: 'Late coming' },
        { key: 'late_joining', label: 'Late joining' },
        { key: 'total_work_hours', label: 'Hours', format: (value) => formatHours(value) },
    ];

    useEffect(() => {
        if (!openCell) return undefined;

        const closeMenu = (event) => {
            if (
                event?.target?.closest?.('[data-attendance-menu]')
                || event?.target?.closest?.('[data-attendance-trigger]')
            ) {
                return;
            }

            setOpenCell(null);
            setMenuPosition(null);
        };
        const closeOnEscape = (event) => {
            if (event.key === 'Escape') closeMenu();
        };

        document.addEventListener('pointerdown', closeMenu);
        document.addEventListener('scroll', closeMenu, true);
        window.addEventListener('resize', closeMenu);
        document.addEventListener('keydown', closeOnEscape);

        return () => {
            document.removeEventListener('pointerdown', closeMenu);
            document.removeEventListener('scroll', closeMenu, true);
            window.removeEventListener('resize', closeMenu);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [openCell]);

    const toggleCellMenu = (event, cellKey) => {
        if (openCell === cellKey) {
            setOpenCell(null);
            setMenuPosition(null);
            return;
        }

        const rect = event.currentTarget.getBoundingClientRect();
        const menuWidth = 192;
        const estimatedMenuHeight = 380;
        const viewportPadding = 8;
        const left = Math.min(
            Math.max(rect.left, viewportPadding),
            window.innerWidth - menuWidth - viewportPadding
        );
        const openAbove = (
            window.innerHeight - rect.bottom < estimatedMenuHeight
            && rect.top > window.innerHeight - rect.bottom
        );

        setMenuPosition(openAbove
            ? { left, bottom: window.innerHeight - rect.top + 6 }
            : { left, top: rect.bottom + 6 });
        setOpenCell(cellKey);
    };

    return (
        <div>
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-300">
                <span className="font-semibold uppercase tracking-wide text-slate-400">Legend:</span>
                {gridLegend.map(([code, label]) => (
                    <span key={code} className="inline-flex items-center gap-1.5">
                        <span className={`inline-flex h-5 min-w-7 items-center justify-center rounded border px-1 text-[10px] font-bold ${gridStatusStyles[code]}`}>{code}</span>
                        {label}
                    </span>
                ))}
            </div>
            <div className="overflow-x-auto">
            <table className="min-w-max border-separate border-spacing-0 text-sm">
                <thead>
                    <tr>
                        <th className="sticky left-0 z-20 min-w-56 border-b border-r border-slate-800 bg-slate-950 px-4 py-3 text-left text-xs font-bold uppercase text-slate-300">
                            Employee
                        </th>
                        {days.map((day) => (
                            <th
                                key={day.date}
                                title={day.holiday || undefined}
                                className={`${showHours ? 'min-w-24' : 'min-w-11'} border-b border-r border-slate-800 px-2 py-2 text-center text-xs font-bold uppercase ${
                                    day.holiday
                                        ? 'bg-violet-500/15 text-violet-300'
                                        : day.is_weekend ? 'bg-sky-500/15 text-sky-300' : 'bg-slate-950 text-slate-300'
                                }`}
                            >
                                <div>{day.weekday}</div>
                                <div className="mt-1 text-sm">{day.day}{showHours ? ` ${day.month_label}` : ''}</div>
                                {showHours && day.holiday && <div className="mx-auto mt-1 max-w-24 truncate text-[10px] font-medium normal-case">{day.holiday}</div>}
                            </th>
                        ))}
                        {summaryColumns.map((column) => (
                            <th key={column.key} className="min-w-20 border-b border-r border-slate-800 bg-slate-950 px-3 py-3 text-center text-xs font-bold uppercase text-slate-300">
                                {column.label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {employees.map((employee) => (
                        <tr key={employee.user_id} className="group">
                            <td className="sticky left-0 z-10 border-b border-r border-slate-800 bg-slate-900 px-4 py-2 group-hover:bg-slate-800/60">
                                <EmployeeIdentity employee={employee} />
                            </td>
                            {employee.days.map((cell) => {
                                const cellKey = `${employee.user_id}-${cell.date}`;
                                const statusCode = cell.status_code || '';
                                const statusClass = gridStatusStyles[statusCode] || gridStatusStyles.empty;
                                const isManual = cell.source === 'manual';
                                const loading = markingCell === cellKey;
                                const open = openCell === cellKey;
                                const titleParts = [
                                    cell.status_label,
                                    cell.work_hours ? `${formatHours(cell.work_hours)} worked` : null,
                                    cell.first_clock_in ? `First in ${cell.first_clock_in}` : null,
                                    isManual ? 'Manual mark' : null,
                                ].filter(Boolean);

                                return (
                                    <td key={cell.date} className="relative border-b border-r border-slate-800 p-1 text-center">
                                        <div className={`relative flex ${showHours ? 'h-12 min-w-20' : 'h-9 min-w-10'} items-center justify-center rounded border text-xs font-bold ${statusClass}`} title={titleParts.join(' | ')}>
                                            {canManualMark ? (
                                                <button
                                                    type="button"
                                                    disabled={loading}
                                                    onClick={(event) => toggleCellMenu(event, cellKey)}
                                                    className="h-full w-full rounded px-1 text-xs font-bold text-inherit outline-none focus:ring-2 focus:ring-orange-500 disabled:cursor-wait disabled:opacity-60"
                                                    aria-label={`Attendance for ${employee.user_name} on ${cell.date}`}
                                                    aria-expanded={open}
                                                    aria-haspopup="menu"
                                                    data-attendance-trigger
                                                >
                                                    {loading ? '...' : statusCode || '-'}
                                                    {showHours && cell.work_hours > 0 && <span className="block text-[10px] font-medium opacity-80">{formatHours(cell.work_hours)}</span>}
                                                </button>
                                            ) : (
                                                <span>
                                                    {statusCode || '-'}
                                                    {showHours && cell.work_hours > 0 && <span className="block text-[10px] font-medium opacity-80">{formatHours(cell.work_hours)}</span>}
                                                </span>
                                            )}
                                            {isManual && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-white ring-1 ring-slate-500" />}
                                        </div>
                                        {canManualMark && open && menuPosition && typeof document !== 'undefined' && createPortal(
                                            <div
                                                className="fixed z-[100] max-h-[calc(100vh-1rem)] w-48 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-2 text-left shadow-xl"
                                                style={menuPosition}
                                                role="menu"
                                                data-attendance-menu
                                            >
                                                <div className="mb-1 px-2 text-xs font-semibold text-slate-500">{cell.date}</div>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        onStatusChange(employee.user_id, cell.date, '');
                                                        setOpenCell(null);
                                                        setMenuPosition(null);
                                                    }}
                                                    className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm font-semibold text-slate-200 hover:bg-slate-800"
                                                    role="menuitem"
                                                >
                                                    <span>Auto</span>
                                                    <span>{statusCode || '-'}</span>
                                                </button>
                                                <div className="my-1 border-t border-slate-800" />
                                                {statusOptions.map((option) => (
                                                    <button
                                                        key={option.code}
                                                        type="button"
                                                        onClick={() => {
                                                            onStatusChange(employee.user_id, cell.date, option.code);
                                                            setOpenCell(null);
                                                            setMenuPosition(null);
                                                        }}
                                                        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm text-slate-300 hover:bg-orange-500/10 hover:text-orange-300"
                                                        role="menuitem"
                                                    >
                                                        <span>{option.label}</span>
                                                        <span className="font-bold">{option.code}</span>
                                                    </button>
                                                ))}
                                            </div>,
                                            document.body
                                        )}
                                    </td>
                                );
                            })}
                            {summaryColumns.map((column) => (
                                <td key={column.key} className="border-b border-r border-slate-800 bg-slate-900 px-3 py-2 text-center font-semibold text-slate-100">
                                    {column.format
                                        ? column.format(employee.summary?.[column.key] || 0)
                                        : employee.summary?.[column.key] || 0}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
            </div>
        </div>
    );
}
