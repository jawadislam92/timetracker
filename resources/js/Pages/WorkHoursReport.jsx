import React, { Fragment, useState, useEffect, useMemo, useRef } from 'react';
import AuthenticatedLayout from '../Layouts/AuthenticatedLayout';
import { TraditionalPagination } from '../Components/Pagination';
import { Head, router } from '@inertiajs/react';
import { ListFilter, Settings2 } from 'lucide-react';
import { timeFormat } from '../helpers';
import { exportRowsToCsv } from '@/Utils/csvExport';
import SearchableMultiSelect from '../Components/Filters/SearchableMultiSelect';
import ActiveFilterChips from '../Components/Filters/ActiveFilterChips';
import PageHeader from '../Components/Layout/PageHeader';
import PageShell from '../Components/Layout/PageShell';
import DateRangeMenu, { presetSpans, prettyDate, prettySpan } from '../Components/Reporting/DateRangeMenu';
import Dialog, { DialogButtons, RadioGroup } from '../Components/Reporting/Dialog';
import ColumnChecklist from '../Components/Reporting/ColumnChecklist';

// Toast Notification Component
function Toast({ message, type = 'success', onClose }) {
    if (!message) return null;

    const bgClass = type === 'error'
        ? 'bg-gradient-to-r from-red-500 to-red-600'
        : 'bg-gradient-to-r from-emerald-500 to-teal-500';

    return (
        <div className={`fixed top-5 right-5 z-50 ${bgClass} text-white px-6 py-3 rounded-xl shadow-2xl flex items-center`}>
            <span className="font-medium">{message}</span>
            <button onClick={onClose} className="ml-4 text-white hover:text-gray-200 font-bold text-lg">&times;</button>
        </div>
    );
}

// Helper Functions
const formatDateLocal = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const formatWorkType = (workType) => {
    const types = {
        'tracker': 'Tracker',
        'manual': 'Manual Time',
        'test_task': 'Test Task',
        'upwork_bidding': 'Upwork Bidding',
        'fixed': 'Fixed Project',
        'office_work': 'Office Work',
        'outside_of_upwork': 'Outside of Upwork'
    };
    return types[workType] || workType;
};

const BILLABLE_TYPES = ['tracker', 'manual', 'outside_of_upwork', 'fixed'];
const TYPE_ORDER = ['tracker', 'manual', 'outside_of_upwork', 'fixed', 'office_work', 'upwork_bidding', 'test_task'];
const TYPE_DOT = { tracker: '#f97316', manual: '#fbbf24', outside_of_upwork: '#fb7185', fixed: '#f0abfc', office_work: '#38bdf8', upwork_bidding: '#818cf8', test_task: '#2dd4bf' };

// Old bookmarks used week/month; the menu now offers more presets.
const LEGACY_RANGE = { week: 'this_week', month: 'this_month' };
const RANGE_PRESETS = [
    ['all', 'All dates'],
    ['today', 'Today'],
    ['this_week', 'Current week'],
    ['last_week', 'Last week'],
    ['this_month', 'Current month'],
    ['last_month', 'Last month'],
    ['last_30_days', 'Last 30 days'],
];

const SHOW_OPTIONS = [
    ['entries', 'Entries', 'Every logged row, as in the Work Diary'],
    ['person', 'Person'],
    ['client', 'Client'],
    ['work_type', 'Work type'],
    ['tracker', 'Tracker (Upwork profile)'],
    ['department', 'Department'],
];
const GROUP_OPTIONS = [
    ['none', 'All time'],
    ['day', 'Day'],
    ['week', 'Week'],
    ['month', 'Month'],
];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function periodKeyOf(date, group) {
    if (group === 'day') return date;
    if (group === 'month') return date.slice(0, 7);
    if (group === 'week') {
        const [y, m, d] = date.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
        return formatDateLocal(dt);
    }
    return 'all';
}
function periodLabel(key, group) {
    if (group === 'day') {
        const [y, m, d] = key.split('-').map(Number);
        return `${DOW[new Date(y, m - 1, d).getDay()]}, ${prettyDate(key)}`;
    }
    if (group === 'week') {
        const [y, m, d] = key.split('-').map(Number);
        const end = new Date(y, m - 1, d + 6);
        return prettySpan(key, formatDateLocal(end));
    }
    if (group === 'month') return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
    return 'All time';
}

const SUMMARY_LABEL = { person: 'Person', client: 'Client', work_type: 'Work type', tracker: 'Tracker', department: 'Department' };

/** Column definitions per "Show" choice. `locked` columns can't be hidden. */
function columnsFor(show) {
    if (show === 'entries') {
        return [
            { id: 'date', label: 'Date', locked: true },
            { id: 'user', label: 'User' },
            { id: 'department', label: 'Department', defaultHidden: true },
            { id: 'client', label: 'Client' },
            { id: 'work_type', label: 'Work type' },
            { id: 'tracker', label: 'Tracker' },
            { id: 'source', label: 'Source' },
            { id: 'hours', label: 'Hours', locked: true },
            { id: 'description', label: 'Description' },
        ];
    }
    return [
        { id: 'label', label: SUMMARY_LABEL[show], locked: true },
        ...(show !== 'person' ? [{ id: 'people', label: 'People', group: 'Details' }] : []),
        ...(show !== 'client' ? [{ id: 'clients', label: 'Clients', group: 'Details', defaultHidden: true }] : []),
        { id: 'days', label: 'Days worked', group: 'Details' },
        { id: 'entries', label: 'Entries', group: 'Details', defaultHidden: true },
        ...TYPE_ORDER.map((t) => ({ id: `t_${t}`, label: formatWorkType(t), dot: TYPE_DOT[t], group: BILLABLE_TYPES.includes(t) ? 'Billable work types' : 'Internal work types', defaultHidden: show === 'work_type' })),
        { id: 'billable', label: 'Billable hours', group: 'Totals' },
        { id: 'internal', label: 'Internal hours', group: 'Totals' },
        { id: 'hours', label: 'Total hours', group: 'Totals', locked: true },
        { id: 'share', label: 'Billable %', group: 'Totals' },
    ];
}
const defaultHidden = (show) => columnsFor(show).filter((c) => c.defaultHidden).map((c) => c.id);

const slackFieldOptions = [
    { value: 'client', label: 'Client', description: 'Group entries by client.' },
    { value: 'work_type', label: 'Work type', description: 'Show tracker, manual, fixed, and other work types.' },
    { value: 'tracker', label: 'Tracker', description: 'Group entries by tracker or profile name.' },
    { value: 'hours', label: 'Hours', description: 'Include summed hours for each group.' },
    { value: 'user_total', label: 'User total', description: 'Show each person\'s total hours for the selected period.' },
];

export default function WorkHoursReport({
    auth,
    workHours,
    users = [],
    flash,
    filter = 'all',
    startDate = null,
    endDate = null,
    userId = 'all',
    workType = 'all',
    client = 'all',
    selectedFilters = {},
    filterOptions = {},
    slackConfigured = false,
    slackWeeklyEnabled = false,
    search = '',
    perPage = 15,
    show = 'entries',
    group = 'none',
    totals = { hours: 0, billable: 0, entries: 0 },
    summary = null,
    periodTotals = null,
    reportLayout = {},
    today = formatDateLocal(new Date()),
    userDepartments = {},
}) {
    const canExport = auth.user?.is_super_admin || auth.user?.permissions?.includes('reports.export');
    const canSendSlack = auth.user?.is_super_admin || auth.user?.permissions?.includes('reports.send_slack');
    const [toast, setToast] = useState(flash?.success || flash?.error || '');
    const [toastType, setToastType] = useState(flash?.success ? 'success' : 'error');
    const dateFilter = LEGACY_RANGE[filter] ?? filter;
    const [selectedUsers, setSelectedUsers] = useState(selectedFilters.userIds || (userId !== 'all' ? [String(userId)] : []));
    const [selectedWorkTypes, setSelectedWorkTypes] = useState(selectedFilters.workTypes || (workType !== 'all' ? [workType] : []));
    const [selectedClients, setSelectedClients] = useState(selectedFilters.clients || (client !== 'all' ? [client] : []));
    const [selectedTrackers, setSelectedTrackers] = useState(selectedFilters.trackers || []);
    const [selectedDesignations, setSelectedDesignations] = useState(selectedFilters.designations || []);
    const [selectedDepartments, setSelectedDepartments] = useState(selectedFilters.departments || []);
    const [searchTerm, setSearchTerm] = useState(search);
    const searchTimeoutRef = useRef(null);
    const [rowsPerPage, setRowsPerPage] = useState(String(perPage));
    const [isExporting, setIsExporting] = useState(false);
    const [showFilterDialog, setShowFilterDialog] = useState(false);
    const [showDisplayDialog, setShowDisplayDialog] = useState(false);
    const [layout, setLayout] = useState(() => (reportLayout && typeof reportLayout === 'object' && !Array.isArray(reportLayout) ? reportLayout : {}));
    const [showSlackDialog, setShowSlackDialog] = useState(false);
    const [isSendingSlack, setIsSendingSlack] = useState(false);
    const [slackUserIds, setSlackUserIds] = useState([]);
    const [slackFields, setSlackFields] = useState(slackFieldOptions.map((field) => field.value));
    const [slackStartDate, setSlackStartDate] = useState(() => {
        const date = new Date();
        date.setDate(date.getDate() - 6);
        return startDate || formatDateLocal(date);
    });
    const [slackEndDate, setSlackEndDate] = useState(endDate || formatDateLocal(new Date()));

    useEffect(() => {
        if (flash?.success || flash?.error) {
            setToast(flash.success || flash.error);
            setToastType(flash.success ? 'success' : 'error');
        }
    }, [flash]);

    const hiddenCols = layout.hidden?.[show] ?? defaultHidden(show);
    const isVisible = (id) => !hiddenCols.includes(id);
    const dense = !!layout.dense;
    const saveLayout = (next) => {
        setLayout(next);
        window.axios.put(route('summary.layout'), { section: 'report', layout: next }).catch(() => {
            setToast('Could not save your display settings.');
            setToastType('error');
        });
    };

    const spans = useMemo(() => presetSpans(today), [today]);
    const rangePresets = RANGE_PRESETS.map(([id, label]) => ({ id, label, start: id === 'all' ? null : spans[id][0], end: id === 'all' ? null : spans[id][1] }));

    const userOptions = (filterOptions.users || users || []).map((user) => ({
        value: String(user.id),
        label: user.name,
        includedByDefault: user.include_in_slack_reports ?? true,
    }));

    const workTypeOptions = (filterOptions.workTypes || []).map((type) => ({
        value: type,
        label: formatWorkType(type),
    }));

    // Options carry the client ID (names are NOT unique in this data — several
    // clients share a name), with duplicates labelled "Name (#id)" so two
    // clients called Brad Pugh are tellable apart in the dropdown.
    const clientNameCounts = (filterOptions.clients || []).reduce((acc, c) => {
        acc[c.name] = (acc[c.name] || 0) + 1;
        return acc;
    }, {});
    const clientOptions = (filterOptions.clients || []).map((c) => ({
        value: String(c.id),
        label: clientNameCounts[c.name] > 1 ? `${c.name} (#${c.id})` : c.name,
    }));
    const clientLabel = (value) =>
        clientOptions.find((o) => o.value === String(value))?.label ?? value;

    const trackerOptions = (filterOptions.trackers || []).map((tracker) => ({
        value: tracker,
        label: tracker,
    }));

    const designationOptions = (filterOptions.designations || []).map((designation) => ({
        value: designation,
        label: designation,
    }));

    const departmentOptions = (filterOptions.departments || []).map((d) => ({ value: d, label: d }));

    const buildFilterParams = (overrides = {}) => {
        const pick = (key, fallback) => (overrides[key] !== undefined ? overrides[key] : fallback);
        const currentRange = pick('range', dateFilter);
        const currentUsers = pick('selectedUsers', selectedUsers);
        const currentWorkTypes = pick('selectedWorkTypes', selectedWorkTypes);
        const currentClients = pick('selectedClients', selectedClients);
        const currentTrackers = pick('selectedTrackers', selectedTrackers);
        const currentDesignations = pick('selectedDesignations', selectedDesignations);
        const currentDepartments = pick('selectedDepartments', selectedDepartments);
        const currentSearch = pick('searchTerm', searchTerm);
        const currentPerPage = pick('rowsPerPage', rowsPerPage);

        const params = { filter: currentRange, show: pick('show', show), group: pick('group', group) };

        if (currentSearch && currentSearch.trim() !== '') params.search = currentSearch.trim();
        // Carry the page size across filter changes (omit the default to keep URLs clean).
        if (currentPerPage && String(currentPerPage) !== '15') params.perPage = currentPerPage;

        if (currentUsers.length) params.userIds = currentUsers;
        if (currentWorkTypes.length) params.workTypes = currentWorkTypes;
        if (currentClients.length) params.clients = currentClients;
        if (currentTrackers.length) params.trackers = currentTrackers;
        if (currentDesignations.length) params.designations = currentDesignations;
        if (currentDepartments.length) params.departments = currentDepartments;

        if (currentRange === 'custom') {
            const s = pick('start', startDate);
            const e = pick('end', endDate);
            if (s && e) {
                params.startDate = s;
                params.endDate = e;
            }
        } else if (currentRange !== 'all' && spans[currentRange]) {
            [params.startDate, params.endDate] = spans[currentRange];
        }

        return params;
    };

    // Apply filters with optional parameter overrides
    const applyFilters = (overrides = {}) => {
        router.get(route('work-hours.report'), buildFilterParams(overrides), {
            preserveState: true,
            preserveScroll: true,
        });
    };

    // Change rows-per-page: reload (back to page 1) with the new size + current filters.
    const changeRowsPerPage = (value) => {
        setRowsPerPage(value);
        applyFilters({ rowsPerPage: value });
    };

    const clearFilters = () => {
        setSelectedUsers([]);
        setSelectedWorkTypes([]);
        setSelectedClients([]);
        setSelectedTrackers([]);
        setSelectedDesignations([]);
        setSelectedDepartments([]);
        setSearchTerm('');

        router.get(route('work-hours.report'), { show, group });
    };

    const removeFilterValue = (type, value) => {
        const setters = {
            users: [selectedUsers, setSelectedUsers, 'selectedUsers'],
            workTypes: [selectedWorkTypes, setSelectedWorkTypes, 'selectedWorkTypes'],
            clients: [selectedClients, setSelectedClients, 'selectedClients'],
            trackers: [selectedTrackers, setSelectedTrackers, 'selectedTrackers'],
            designations: [selectedDesignations, setSelectedDesignations, 'selectedDesignations'],
            departments: [selectedDepartments, setSelectedDepartments, 'selectedDepartments'],
        };
        if (type === 'date') {
            applyFilters({ range: 'all' });
            return;
        }
        const [list, set, key] = setters[type];
        const next = list.filter((item) => item !== value);
        set(next);
        applyFilters({ [key]: next });
    };

    const labelForValue = (options, value) => options.find((option) => String(option.value) === String(value))?.label || value;

    const activeFilterChips = [
        ...selectedUsers.map((value) => ({
            key: `users-${value}`,
            label: `User: ${labelForValue(userOptions, value)}`,
            onRemove: () => removeFilterValue('users', value),
        })),
        ...selectedDepartments.map((value) => ({
            key: `departments-${value}`,
            label: `Department: ${value}`,
            onRemove: () => removeFilterValue('departments', value),
        })),
        ...selectedWorkTypes.map((value) => ({
            key: `workTypes-${value}`,
            label: `Type: ${formatWorkType(value)}`,
            onRemove: () => removeFilterValue('workTypes', value),
        })),
        ...selectedClients.map((value) => ({
            key: `clients-${value}`,
            // Values are client IDs now — show the human name on the chip.
            label: `Client: ${clientLabel(value)}`,
            onRemove: () => removeFilterValue('clients', value),
        })),
        ...selectedTrackers.map((value) => ({
            key: `trackers-${value}`,
            label: `Tracker: ${value}`,
            onRemove: () => removeFilterValue('trackers', value),
        })),
        ...selectedDesignations.map((value) => ({
            key: `designations-${value}`,
            label: `Designation: ${value}`,
            onRemove: () => removeFilterValue('designations', value),
        })),
    ];

    const exportToCSV = async () => {
        if (summary) {
            const cols = columnsFor(show).filter((c) => c.locked || isVisible(c.id));
            const data = summary.rows.map((r) => {
                const out = group !== 'none' ? { Period: periodLabel(r.period, group) } : {};
                cols.forEach((c) => (out[c.label] = summaryCell(r, c.id, true)));
                return out;
            });
            exportRowsToCsv(data, `work-hours-by-${show}${group !== 'none' ? `-per-${group}` : ''}-${today}.csv`);
            setToast(`Exported ${data.length} rows to CSV`);
            setToastType('success');
            return;
        }

        setIsExporting(true);
        setToast('Preparing export data...');
        setToastType('success');

        try {
            const params = buildFilterParams();
            const query = new URLSearchParams();

            Object.entries(params).forEach(([key, value]) => {
                if (Array.isArray(value)) {
                    value.forEach((item) => query.append(`${key}[]`, item));
                } else if (value !== undefined && value !== null && value !== '') {
                    query.append(key, value);
                }
            });

            const queryString = query.toString();
            const url = queryString
                ? `${route('work-hours.export')}?${queryString}`
                : route('work-hours.export');

            // Fetch all data from backend
            const response = await fetch(url, {
                headers: {
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest'
                }
            });

            if (!response.ok) {
                throw new Error('Failed to fetch export data');
            }

            const result = await response.json();
            const allData = result.data;

            // Apply client-side search filter if needed
            const exportData = allData
                .filter(entry => {
                    if (!searchTerm) return true;
                    const search = searchTerm.toLowerCase();
                    return (
                        entry.user?.name?.toLowerCase().includes(search) ||
                        entry.client?.name?.toLowerCase().includes(search) ||
                        entry.description?.toLowerCase().includes(search) ||
                        entry.tracker?.toLowerCase().includes(search)
                    );
                })
                .map(entry => ({
                    'Date': entry.date,
                    'User': entry.user?.name || 'N/A',
                    'Client': entry.client?.name || 'No Client',
                    'Work Type': formatWorkType(entry.work_type),
                    'Tracker': entry.tracker,
                    'Source': entry.source === 'tracker' ? 'Auto' : 'Logged',
                    'Hours': timeFormat(entry.hours),
                    'Description': entry.description || ''
                }));

            exportRowsToCsv(exportData, `work-hours-report-${new Date().toISOString().split('T')[0]}.csv`);

            setToast(`Successfully exported ${exportData.length} entries to CSV`);
            setToastType('success');
        } catch (error) {
            console.error('Export error:', error);
            setToast('Export failed. Please try again.');
            setToastType('error');
        } finally {
            setIsExporting(false);
        }
    };

    const openSlackDialog = () => {
        if (startDate && endDate) {
            setSlackStartDate(startDate);
            setSlackEndDate(endDate);
        }

        setSlackUserIds(
            selectedUsers.length
                ? selectedUsers
                : userOptions.filter((option) => option.includedByDefault).map((option) => option.value)
        );
        setShowSlackDialog(true);
    };

    const toggleSlackField = (field) => {
        setSlackFields((current) => (
            current.includes(field)
                ? current.filter((item) => item !== field)
                : [...current, field]
        ));
    };

    const sendToSlack = () => {
        setIsSendingSlack(true);

        router.post(route('work-hours.slack'), {
            start_date: slackStartDate,
            end_date: slackEndDate,
            user_ids: slackUserIds,
            include_fields: slackFields,
        }, {
            preserveScroll: true,
            onSuccess: () => {
                setShowSlackDialog(false);
                setToast('Report sent to Slack.');
                setToastType('success');
            },
            onError: (errors) => {
                setToast(
                    errors.slack
                    || errors.end_date
                    || errors.user_ids
                    || errors.include_fields
                    || 'Unable to send the Slack report.'
                );
                setToastType('error');
            },
            onFinish: () => setIsSendingSlack(false),
        });
    };

    const entries = workHours?.data || [];
    const filterCount = activeFilterChips.length;
    const pad = dense ? 'py-1.5' : 'py-3';
    const th = 'whitespace-nowrap px-4 py-3 text-left text-xs font-bold uppercase text-white';
    const fmtH = (n) => timeFormat(Number(n || 0).toFixed(2));
    const share = (b, t) => (t > 0 ? Math.round((b / t) * 100) : 0);

    function summaryCell(r, id, plain = false) {
        switch (id) {
            case 'label':
                return show === 'work_type' ? formatWorkType(r.label) : r.label;
            case 'people':
                return r.people;
            case 'clients':
                return r.clients;
            case 'days':
                return r.days;
            case 'entries':
                return r.entries;
            case 'billable':
                return fmtH(r.billable);
            case 'internal':
                return fmtH(r.hours - r.billable);
            case 'hours':
                return fmtH(r.hours);
            case 'share':
                return plain ? share(r.billable, r.hours) : `${share(r.billable, r.hours)}%`;
            default:
                if (id.startsWith('t_')) {
                    const v = r.by_type?.[id.slice(2)] || 0;
                    return plain || v ? fmtH(v) : '–';
                }
                return '';
        }
    }

    const summaryCols = summary ? columnsFor(show).filter((c) => c.locked || isVisible(c.id)) : [];
    const sumRows = (rows, fn) => rows.reduce((s, r) => s + (fn(r) || 0), 0);
    const summaryFooter = (rows, id) => {
        const tot = sumRows(rows, (r) => r.hours);
        const bill = sumRows(rows, (r) => r.billable);
        if (id === 'billable') return fmtH(bill);
        if (id === 'internal') return fmtH(tot - bill);
        if (id === 'hours') return fmtH(tot);
        if (id === 'share') return `${share(bill, tot)}%`;
        if (id === 'entries') return sumRows(rows, (r) => r.entries);
        if (id.startsWith('t_')) {
            const v = sumRows(rows, (r) => r.by_type?.[id.slice(2)]);
            return v ? fmtH(v) : '–';
        }
        return '';
    };
    const summaryBlocks = useMemo(() => {
        if (!summary) return [];
        if (group === 'none') return [{ key: 'all', rows: summary.rows }];
        const map = new Map();
        summary.rows.forEach((r) => {
            if (!map.has(r.period)) map.set(r.period, []);
            map.get(r.period).push(r);
        });
        return [...map.entries()].map(([key, rows]) => ({ key, rows }));
    }, [summary, group]);

    const entryCols = columnsFor('entries').filter((c) => c.locked || isVisible(c.id));
    const renderEntryCell = (entry, id) => {
        switch (id) {
            case 'date':
                return <td key={id} className={`sticky left-0 z-[1] whitespace-nowrap bg-inherit px-4 ${pad} text-sm font-medium text-slate-100`}>{entry.date}</td>;
            case 'user':
                return <td key={id} className={`px-4 ${pad} text-sm text-slate-100`}>{entry.user?.name || 'N/A'}</td>;
            case 'department':
                return <td key={id} className={`px-4 ${pad} text-sm text-slate-400`}>{userDepartments[entry.user?.id] ?? '—'}</td>;
            case 'client':
                return <td key={id} className={`px-4 ${pad} text-sm text-slate-300`}>{entry.client?.name || 'No Client'}</td>;
            case 'work_type':
                return (
                    <td key={id} className={`px-4 ${pad} text-sm`}>
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 px-2 py-1 text-xs font-medium text-slate-200">
                            <span className="h-1.5 w-1.5 rounded-full" style={{ background: TYPE_DOT[entry.work_type] ?? '#94a3b8' }} />
                            {formatWorkType(entry.work_type)}
                        </span>
                    </td>
                );
            case 'tracker':
                return (
                    <td key={id} className={`px-4 ${pad} text-sm`}>
                        {entry.tracker ? <span className="inline-flex rounded-full bg-teal-500/15 px-2 py-1 text-xs font-medium capitalize text-teal-300">{entry.tracker}</span> : <span className="text-slate-500">—</span>}
                    </td>
                );
            case 'source':
                return (
                    <td key={id} className={`px-4 ${pad} text-sm`}>
                        {entry.source === 'tracker' ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-300" title="Auto-captured from the desktop tracker">
                                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                Auto
                            </span>
                        ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-200" title="Logged by hand in the web app (Add Manual Time)">
                                Logged
                            </span>
                        )}
                    </td>
                );
            case 'hours':
                return (
                    <td key={id} className={`px-4 ${pad} text-sm font-bold text-emerald-400`}>
                        {timeFormat(entry.hours)}
                        {entry.entry_count > 1 && (
                            <span className="ml-1.5 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-semibold text-slate-200" title={`${entry.entry_count} entries merged into this row`}>
                                ×{entry.entry_count}
                            </span>
                        )}
                    </td>
                );
            default:
                return (
                    <td key={id} className={`px-4 ${pad} text-sm text-slate-300`}>
                        <div className="max-w-xs truncate" title={entry.description}>
                            {entry.description || '-'}
                        </div>
                    </td>
                );
        }
    };
    const hoursIndex = entryCols.findIndex((c) => c.id === 'hours');

    // Entry rows with a heading before each day/week/month and its full total after.
    const entryRows = [];
    entries.forEach((entry, index) => {
        const key = group !== 'none' ? periodKeyOf(entry.date, group) : null;
        const prevKey = index > 0 && group !== 'none' ? periodKeyOf(entries[index - 1].date, group) : null;
        if (key && key !== prevKey) {
            entryRows.push(
                <tr key={`h-${key}`} className="bg-slate-950">
                    <td colSpan={entryCols.length} className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-orange-200/90">
                        <span className="sticky left-4">{periodLabel(key, group)}</span>
                    </td>
                </tr>,
            );
        }
        entryRows.push(
            <tr key={entry.id} className={`${index % 2 === 0 ? 'bg-slate-900' : 'bg-slate-950/50'} hover:bg-slate-800 transition-colors`}>
                {entryCols.map((c) => renderEntryCell(entry, c.id))}
            </tr>,
        );
        const nextKey = index < entries.length - 1 && group !== 'none' ? periodKeyOf(entries[index + 1].date, group) : null;
        if (key && key !== nextKey) {
            entryRows.push(
                <tr key={`t-${key}`} className="border-t border-slate-700 bg-slate-800/50">
                    <td colSpan={Math.max(1, hoursIndex)} className="px-4 py-2 text-right text-sm font-medium text-slate-200">
                        Total for {periodLabel(key, group)}
                    </td>
                    <td className="px-4 py-2 text-sm font-bold text-emerald-300">{fmtH(periodTotals?.[key])}</td>
                    {entryCols.length - hoursIndex - 1 > 0 && <td colSpan={entryCols.length - hoursIndex - 1} />}
                </tr>,
            );
        }
    });

    return (
        <AuthenticatedLayout user={auth.user}>
            <Head title="Work Hours Report" />

            {toast && <Toast message={toast} type={toastType} onClose={() => setToast('')} />}

            <PageShell>
                    <PageHeader
                        title="Work Hours Report"
                        description="Review and export team work hours."
                        actions={(
                            <>
                                {canSendSlack && (
                                    <button
                                        type="button"
                                        onClick={openSlackDialog}
                                        className="inline-flex items-center rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-slate-200 shadow-sm hover:bg-slate-800"
                                    >
                                        <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                            <path d="M6.5 14.5a2 2 0 11-2-2h2v2zm1 0a2 2 0 114 0v5a2 2 0 11-4 0v-5zm2-8a2 2 0 112-2v2h-2zm0 1a2 2 0 110 4h-5a2 2 0 110-4h5zm8 2a2 2 0 112 2h-2v-2zm-1 0a2 2 0 11-4 0v-5a2 2 0 114 0v5zm-2 8a2 2 0 11-2 2v-2h2zm0-1a2 2 0 110-4h5a2 2 0 110 4h-5z" />
                                        </svg>
                                        Send to Slack
                                    </button>
                                )}
                                {canExport && (
                                    <button
                                        onClick={exportToCSV}
                                        disabled={isExporting}
                                        className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:bg-slate-400"
                                    >
                                        <svg className="mr-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                        </svg>
                                        {isExporting ? 'Exporting...' : 'Export CSV'}
                                    </button>
                                )}
                            </>
                        )}
                    />

                    {/* Toolbar: date range · filters · display settings · search */}
                    <div className="rounded-lg border border-slate-800 bg-slate-900 p-3 shadow-sm">
                        <div className="flex flex-wrap items-end gap-2">
                            <div>
                                <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Date range</div>
                                <DateRangeMenu
                                    range={dateFilter}
                                    start={startDate}
                                    end={endDate}
                                    presets={rangePresets}
                                    maxDate={today}
                                    onChange={({ range, start, end }) => applyFilters({ range, start, end })}
                                />
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowFilterDialog(true)}
                                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition ${filterCount ? 'border-orange-500/60 bg-orange-500/10 text-orange-100' : 'border-slate-700 text-slate-200 hover:bg-slate-800'}`}
                            >
                                <ListFilter className="h-4 w-4" /> Filters
                                {filterCount > 0 && <span className="rounded-full bg-orange-500 px-1.5 text-[11px] font-bold tabular-nums text-slate-950">{filterCount}</span>}
                            </button>
                            <button
                                type="button"
                                onClick={() => setShowDisplayDialog(true)}
                                className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                            >
                                <Settings2 className="h-4 w-4 text-orange-300" /> Display settings
                            </button>

                            {/* Search */}
                            <div className="relative ml-auto w-full sm:w-72 lg:w-80">
                                <input
                                    type="text"
                                    placeholder="Search report..."
                                    value={searchTerm}
                                    onChange={(e) => {
                                        const value = e.target.value;
                                        setSearchTerm(value);
                                        // Debounced server-side search so matches on
                                        // other pages are found, not just this page.
                                        clearTimeout(searchTimeoutRef.current);
                                        searchTimeoutRef.current = setTimeout(() => {
                                            applyFilters({ searchTerm: value });
                                        }, 400);
                                    }}
                                    className="w-full pl-10 pr-4 py-2 border border-slate-700 bg-slate-900 rounded-lg text-slate-200 placeholder-slate-500 focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                                />
                                <svg className="w-5 h-5 text-slate-400 absolute left-3 top-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                </svg>
                            </div>
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-slate-400">
                            <span>
                                Showing <span className="font-medium text-slate-200">{SHOW_OPTIONS.find(([v]) => v === show)?.[1].toLowerCase()}</span>
                                {group !== 'none' && <> grouped by <span className="font-medium text-slate-200">{group}</span></>}
                            </span>
                            <span>
                                <span className="font-semibold tabular-nums text-emerald-400">{fmtH(totals.hours)}</span> total
                            </span>
                            <span>
                                <span className="font-semibold tabular-nums text-orange-300">{fmtH(totals.billable)}</span> billable ({share(totals.billable, totals.hours)}%)
                            </span>
                            <span className="tabular-nums">{totals.entries.toLocaleString()} entries</span>
                        </div>

                        <ActiveFilterChips chips={activeFilterChips} onClearAll={activeFilterChips.length ? clearFilters : null} />
                    </div>

                    {/* Data Table */}
                    <div className="rounded-lg border border-slate-800 bg-slate-900 shadow-sm overflow-hidden">
                        <div className="overflow-x-auto">
                            {summary ? (
                                <table className="min-w-full divide-y divide-slate-800">
                                    <thead className="bg-slate-950">
                                        <tr>
                                            {summaryCols.map((c, i) => (
                                                <th key={c.id} className={`${th} ${i === 0 ? 'sticky left-0 z-10 bg-slate-950' : 'text-right'}`}>
                                                    <span className={`inline-flex items-center gap-1.5 ${i === 0 ? '' : 'justify-end'}`}>
                                                        {c.dot && <span className="h-2 w-2 rounded-full" style={{ background: c.dot }} />}
                                                        {c.label}
                                                    </span>
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-800">
                                        {summary.rows.length === 0 && (
                                            <tr>
                                                <td colSpan={summaryCols.length} className="px-4 py-12 text-center text-slate-400">No hours match these filters.</td>
                                            </tr>
                                        )}
                                        {summaryBlocks.map((b) => (
                                            <Fragment key={b.key}>
                                                {group !== 'none' && (
                                                    <tr className="bg-slate-950">
                                                        <td colSpan={summaryCols.length} className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-orange-200/90">
                                                            <span className="sticky left-4">{periodLabel(b.key, group)}</span>
                                                        </td>
                                                    </tr>
                                                )}
                                                {b.rows.map((r, idx) => (
                                                    <tr key={`${r.period}|${r.key}`} className={`${idx % 2 === 0 ? 'bg-slate-900' : 'bg-slate-950/50'} hover:bg-slate-800`}>
                                                        {summaryCols.map((c, i) => (
                                                            <td key={c.id} className={`whitespace-nowrap px-4 ${pad} text-sm ${i === 0 ? 'sticky left-0 z-[1] bg-inherit font-medium text-slate-100' : `text-right tabular-nums ${c.id === 'hours' ? 'font-bold text-emerald-400' : c.id === 'billable' ? 'text-orange-200' : c.id === 'internal' ? 'text-sky-200' : 'text-slate-300'}`}`}>
                                                                {summaryCell(r, c.id)}
                                                            </td>
                                                        ))}
                                                    </tr>
                                                ))}
                                                {group !== 'none' && (
                                                    <tr className="border-t border-slate-700 bg-slate-800/50">
                                                        {summaryCols.map((c, i) => (
                                                            <td key={c.id} className={`whitespace-nowrap px-4 py-2 text-sm font-medium ${i === 0 ? 'sticky left-0 z-[1] bg-slate-800 text-slate-200' : 'text-right tabular-nums text-slate-100'}`}>
                                                                {i === 0 ? `Total for ${periodLabel(b.key, group)}` : summaryFooter(b.rows, c.id)}
                                                            </td>
                                                        ))}
                                                    </tr>
                                                )}
                                            </Fragment>
                                        ))}
                                    </tbody>
                                    {summary.rows.length > 0 && (
                                        <tfoot className="border-t-2 border-slate-700 bg-slate-950">
                                            <tr>
                                                {summaryCols.map((c, i) => (
                                                    <td key={c.id} className={`whitespace-nowrap px-4 py-3 font-bold ${i === 0 ? 'sticky left-0 z-[1] bg-slate-950 text-slate-100' : `text-right tabular-nums ${c.id === 'hours' ? 'text-lg text-emerald-400' : 'text-slate-100'}`}`}>
                                                        {i === 0 ? (group !== 'none' ? 'Grand total' : 'Total') : summaryFooter(summary.rows, c.id)}
                                                    </td>
                                                ))}
                                            </tr>
                                        </tfoot>
                                    )}
                                </table>
                            ) : (
                                <table className="min-w-full divide-y divide-slate-800">
                                    <thead className="bg-slate-950">
                                        <tr>
                                            {entryCols.map((c, i) => (
                                                <th key={c.id} className={`${th} ${i === 0 ? 'sticky left-0 z-10 bg-slate-950' : ''}`}>{c.label}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-800">
                                        {entries.length === 0 ? (
                                            <tr>
                                                <td colSpan={entryCols.length} className="px-0 py-12 text-center">
                                                    <div className="sticky left-0 flex w-[calc(100vw-4rem)] flex-col items-center px-4 sm:w-auto">
                                                        <svg className="w-12 h-12 text-slate-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                                                        </svg>
                                                        <h3 className="text-lg font-medium text-white mb-2">No data found</h3>
                                                        <p className="text-slate-400">Try adjusting your filters</p>
                                                    </div>
                                                </td>
                                            </tr>
                                        ) : (
                                            entryRows
                                        )}
                                    </tbody>
                                    {entries.length > 0 && (
                                        <tfoot className="bg-slate-950">
                                            <tr>
                                                <td colSpan={Math.max(1, hoursIndex)} className="px-4 py-3 text-right font-bold text-slate-100">
                                                    Total{workHours?.last_page > 1 ? ` (all ${workHours.total.toLocaleString()} rows, every page)` : ''}:
                                                </td>
                                                <td className="px-4 py-3 font-bold text-emerald-400 text-lg">{fmtH(totals.hours)}</td>
                                                {entryCols.length - hoursIndex - 1 > 0 && <td colSpan={entryCols.length - hoursIndex - 1} />}
                                            </tr>
                                        </tfoot>
                                    )}
                                </table>
                            )}
                        </div>

                        {summary?.truncated && (
                            <div className="border-t border-slate-800 px-6 py-3 text-sm text-amber-300">Only the first 5,000 rows are shown. Narrow the date range or filters to see everything.</div>
                        )}

                        {/* Pagination */}
                        {!summary && entries.length > 0 && (
                            <div className="p-6 border-t border-slate-800">
                                <div className="flex justify-between items-center mb-4">
                                    <div className="text-slate-300 text-sm font-medium">
                                        Showing {workHours.from || 0} to {workHours.to || 0} of {workHours.total || 0} entries
                                    </div>
                                    <label className="flex items-center gap-2 text-sm text-slate-300">
                                        <span>Rows per page</span>
                                        <select
                                            value={rowsPerPage}
                                            onChange={(e) => changeRowsPerPage(e.target.value)}
                                            className="rounded-md border-slate-700 bg-slate-900 text-sm text-slate-100 focus:border-orange-500 focus:ring-orange-500"
                                        >
                                            {['10', '15', '20', '30', '40', '50', '100'].map((n) => (
                                                <option key={n} value={n}>{n}</option>
                                            ))}
                                            <option value="all">All</option>
                                        </select>
                                    </label>
                                </div>
                                <TraditionalPagination
                                    pagination={workHours}
                                    preserveState={true}
                                    preserveScroll={false}
                                    dark
                                />
                            </div>
                        )}
                    </div>
            </PageShell>

            {showFilterDialog && (
                <ReportFilterDialog
                    initial={{ users: selectedUsers, departments: selectedDepartments, designations: selectedDesignations, workTypes: selectedWorkTypes, clients: selectedClients, trackers: selectedTrackers }}
                    options={{ users: userOptions, departments: departmentOptions, designations: designationOptions, workTypes: workTypeOptions, clients: clientOptions, trackers: trackerOptions }}
                    onClose={() => setShowFilterDialog(false)}
                    onApply={(f) => {
                        setSelectedUsers(f.users);
                        setSelectedDepartments(f.departments);
                        setSelectedDesignations(f.designations);
                        setSelectedWorkTypes(f.workTypes);
                        setSelectedClients(f.clients);
                        setSelectedTrackers(f.trackers);
                        setShowFilterDialog(false);
                        applyFilters({ selectedUsers: f.users, selectedDepartments: f.departments, selectedDesignations: f.designations, selectedWorkTypes: f.workTypes, selectedClients: f.clients, selectedTrackers: f.trackers });
                    }}
                />
            )}

            {showDisplayDialog && (
                <ReportDisplayDialog
                    show={show}
                    group={group}
                    layout={layout}
                    onClose={() => setShowDisplayDialog(false)}
                    onApply={(st) => {
                        const next = { ...layout, show: st.show, group: st.group, dense: st.dense, hidden: { ...(layout.hidden || {}), [st.show]: st.hidden } };
                        saveLayout(next);
                        setShowDisplayDialog(false);
                        if (st.show !== show || st.group !== group) applyFilters({ show: st.show, group: st.group });
                    }}
                />
            )}

            {showSlackDialog && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
                    <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg border border-slate-800 bg-slate-900 shadow-xl">
                        <div className="flex items-start justify-between border-b border-slate-800 px-5 py-4">
                            <div>
                                <h2 className="text-lg font-bold text-white">Send report to Slack</h2>
                                <p className="mt-1 text-sm text-slate-400">Choose the people and details included in this report.</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowSlackDialog(false)}
                                className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                                title="Close"
                            >
                                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>

                        <div className="space-y-5 overflow-y-auto px-5 py-4">
                            <div className={`rounded-lg border px-3 py-2 text-sm ${
                                slackConfigured
                                    ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                                    : 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                            }`}>
                                {slackConfigured ? 'Slack webhook connected.' : 'Slack webhook is not configured.'}
                                {slackWeeklyEnabled && ' Automatic reports run Sundays at 10:00 AM Pakistan time.'}
                            </div>

                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <div>
                                    <label htmlFor="slack-start-date" className="mb-1.5 block text-sm font-semibold text-slate-300">Start date</label>
                                    <input
                                        id="slack-start-date"
                                        type="date"
                                        value={slackStartDate}
                                        max={slackEndDate}
                                        onChange={(event) => setSlackStartDate(event.target.value)}
                                        className="w-full rounded-lg border-slate-700 bg-slate-900 text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500"
                                    />
                                </div>
                                <div>
                                    <label htmlFor="slack-end-date" className="mb-1.5 block text-sm font-semibold text-slate-300">End date</label>
                                    <input
                                        id="slack-end-date"
                                        type="date"
                                        value={slackEndDate}
                                        min={slackStartDate}
                                        onChange={(event) => setSlackEndDate(event.target.value)}
                                        className="w-full rounded-lg border-slate-700 bg-slate-900 text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500"
                                    />
                                </div>
                            </div>

                            <SearchableMultiSelect
                                label="Users to include"
                                options={userOptions}
                                selectedValues={slackUserIds}
                                onChange={setSlackUserIds}
                                placeholder="Select users"
                                searchPlaceholder="Search users..."
                            />

                            <fieldset>
                                <legend className="text-sm font-semibold text-slate-100">Data to include</legend>
                                <p className="mt-1 text-sm text-slate-400">
                                    User names are always shown. Select at least one additional field.
                                </p>
                                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                    {slackFieldOptions.map((field) => {
                                        const checked = slackFields.includes(field.value);

                                        return (
                                            <label
                                                key={field.value}
                                                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${
                                                    checked
                                                        ? 'border-orange-500/40 bg-orange-500/15'
                                                        : 'border-slate-800 bg-slate-900 hover:border-slate-700'
                                                }`}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={() => toggleSlackField(field.value)}
                                                    className="mt-0.5 rounded border-slate-700 bg-slate-900 [color-scheme:dark] text-orange-600 focus:ring-orange-500"
                                                />
                                                <span>
                                                    <span className="block text-sm font-semibold text-slate-100">{field.label}</span>
                                                    <span className="mt-0.5 block text-xs leading-5 text-slate-400">{field.description}</span>
                                                </span>
                                            </label>
                                        );
                                    })}
                                </div>
                            </fieldset>

                            <p className="rounded-lg bg-slate-800/40 px-3 py-2 text-xs leading-5 text-slate-400">
                                Slack will send these choices as table columns. They are independent from the filters on the report page.
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
                                onClick={sendToSlack}
                                disabled={
                                    !slackConfigured
                                    || isSendingSlack
                                    || !slackStartDate
                                    || !slackEndDate
                                    || slackUserIds.length === 0
                                    || slackFields.length === 0
                                }
                                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
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

const EMPTY_FILTERS = { users: [], departments: [], designations: [], workTypes: [], clients: [], trackers: [] };

function ReportFilterDialog({ initial, options, onClose, onApply }) {
    const [f, setF] = useState(initial);
    const changed = JSON.stringify(f) !== JSON.stringify(initial);
    const any = Object.values(f).some((v) => v.length);
    const field = (key, label, placeholder) =>
        (options[key].length > 0 || f[key].length > 0) && (
            <SearchableMultiSelect label={label} options={options[key]} selectedValues={f[key]} onChange={(v) => setF({ ...f, [key]: v })} placeholder={placeholder} searchPlaceholder={`Search ${label.toLowerCase()}…`} />
        );

    return (
        <Dialog title="Filter by" scroll={false} onClose={onClose} footer={<DialogButtons onCancel={onClose} onReset={() => setF(EMPTY_FILTERS)} resettable={any} onApply={() => onApply(f)} applyLabel="Apply filters" dirty={changed} />}>
            <div className="space-y-5 pb-2">
                {field('users', 'People', 'All people')}
                {field('departments', 'Departments', 'All departments')}
                {field('clients', 'Clients', 'All clients')}
                {field('workTypes', 'Work type', 'All work types')}
                {field('trackers', 'Tracker (Upwork profile)', 'All trackers')}
                {field('designations', 'Designation', 'All designations')}
            </div>
        </Dialog>
    );
}

function ReportDisplayDialog({ show, group, layout, onClose, onApply }) {
    const hiddenFor = (s) => layout.hidden?.[s] ?? defaultHidden(s);
    const [st, setSt] = useState({ show, group, dense: !!layout.dense, hidden: hiddenFor(show) });
    const initial = { show: 'entries', group: 'none', dense: false, hidden: defaultHidden('entries') };

    return (
        <Dialog
            title="Display settings"
            onClose={onClose}
            width="max-w-2xl"
            footer={<DialogButtons onCancel={onClose} onReset={() => setSt(initial)} onApply={() => onApply(st)} />}
        >
            <div className="grid gap-6 sm:grid-cols-2">
                <RadioGroup label="Show" name="report-show" value={st.show} onChange={(s) => setSt({ ...st, show: s, hidden: hiddenFor(s) })} options={SHOW_OPTIONS} />
                <RadioGroup label="Grouped by" name="report-group" value={st.group} onChange={(g) => setSt({ ...st, group: g })} options={GROUP_OPTIONS} />
            </div>
            <div className="mt-6 space-y-4">
                <ColumnChecklist columns={columnsFor(st.show)} hidden={st.hidden} onChange={(hidden) => setSt({ ...st, hidden })} />
                <label className="inline-flex items-center gap-2 text-sm text-slate-300">
                    <input type="checkbox" checked={st.dense} onChange={(e) => setSt({ ...st, dense: e.target.checked })} className="rounded border-slate-600 bg-slate-800 text-orange-500 focus:ring-orange-500/40" />
                    Compact rows
                </label>
                <p className="text-xs text-slate-500">Saved to your account. “Entries” lists every logged row with paging; the other choices add the hours up for the whole period.</p>
            </div>
        </Dialog>
    );
}
