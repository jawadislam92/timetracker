import React, { useState, useEffect, useMemo } from 'react';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import AuthenticatedLayout from '../Layouts/AuthenticatedLayout';
import { TraditionalPagination } from '../Components/Pagination';
import { Head, Link, router } from '@inertiajs/react';
import { timeFormat } from '../helpers';
import { exportRowsToCsv } from '@/Utils/csvExport';
import SearchableMultiSelect from '../Components/Filters/SearchableMultiSelect';
import ActiveFilterChips from '../Components/Filters/ActiveFilterChips';
import PageHeader from '../Components/Layout/PageHeader';
import PageShell from '../Components/Layout/PageShell';

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

const getDateRange = (filter) => {
    const today = new Date();
    let start;
    let end;

    if (filter === 'today') {
        start = end = formatDateLocal(today);
    } else if (filter === 'week') {
        const dayOfWeek = today.getDay();
        const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const monday = new Date(today);
        monday.setDate(monday.getDate() - daysFromMonday);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        start = formatDateLocal(monday);
        end = formatDateLocal(sunday);
    } else if (filter === 'month') {
        start = formatDateLocal(new Date(today.getFullYear(), today.getMonth(), 1));
        end = formatDateLocal(new Date(today.getFullYear(), today.getMonth() + 1, 0));
    }

    return { start, end };
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

export default function WorkHoursList({
    auth,
    workHours,
    flash,
    search = '',
    filteredTotalHours = 0,
    filter = 'all',
    startDate = null,
    endDate = null,
    selectedFilters = {},
    filterOptions = {},
}) {
    const [deleteId, setDeleteId] = useState(null);
    const [toast, setToast] = useState(flash?.success || flash?.error || '');
    const [toastType, setToastType] = useState(flash?.success ? 'success' : 'error');
    const [selectedEntries, setSelectedEntries] = useState(new Set());
    const [isExporting, setIsExporting] = useState(false);
    const [searchTerm, setSearchTerm] = useState(search);
    const [showFilters, setShowFilters] = useState(false);
    const [dateFilter, setDateFilter] = useState(filter);
    const [customStartDate, setCustomStartDate] = useState(startDate ? new Date(startDate) : null);
    const [customEndDate, setCustomEndDate] = useState(endDate ? new Date(endDate) : null);
    const [selectedWorkTypes, setSelectedWorkTypes] = useState(selectedFilters.workTypes || []);
    const [selectedTrackers, setSelectedTrackers] = useState(selectedFilters.trackers || []);
    const [selectedClients, setSelectedClients] = useState(selectedFilters.clients || []);

    useEffect(() => {
        if (flash?.success || flash?.error) {
            setToast(flash.success || flash.error);
            setToastType(flash.success ? 'success' : 'error');
        }
    }, [flash]);

    // Debounced server-side search. Only fires when the trimmed term differs
    // from what the server already rendered, so it won't loop on load or when
    // an Inertia visit brings back the matching `search` prop.
    useEffect(() => {
        const trimmed = searchTerm.trim();
        if (trimmed === (search || '')) return;

        const timeout = setTimeout(() => {
            router.get(route('work-hours.index'), buildFilterParams({ searchTerm: trimmed }), {
                preserveState: true,
                preserveScroll: true,
                replace: true,
            });
            clearSelection();
        }, 350);

        return () => clearTimeout(timeout);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchTerm]);

    const currentListUrl = () => (
        typeof window === 'undefined'
            ? route('work-hours.index')
            : `${window.location.pathname}${window.location.search}`
    );

    const handleDelete = (id) => setDeleteId(id);

    const confirmDelete = () => {
        if (!deleteId) return;
        router.delete(route('work-hours.destroy', deleteId), {
            data: { return_to: currentListUrl() },
            preserveState: true,
            preserveScroll: true,
            onSuccess: () => {
                setToast('Work entry deleted successfully');
                setToastType('success');
                setDeleteId(null);
            },
            onError: () => {
                setToast('Failed to delete work entry');
                setToastType('error');
                setDeleteId(null);
            },
        });
    };

    const toggleSelection = (id) => {
        const newSelected = new Set(selectedEntries);
        if (newSelected.has(id)) {
            newSelected.delete(id);
        } else {
            newSelected.add(id);
        }
        setSelectedEntries(newSelected);
    };

    const selectAllPage = () => {
        // Only the currently-rendered rows (= this server page, already filtered
        // by the active search) so bulk-delete can never touch hidden entries.
        const pageIds = (workHours?.data || []).map(entry => entry.id);
        setSelectedEntries(new Set(pageIds));
    };

    const clearSelection = () => setSelectedEntries(new Set());

    const workTypeOptions = (filterOptions.workTypes || []).map((type) => ({
        value: type,
        label: formatWorkType(type),
    }));

    const trackerOptions = (filterOptions.trackers || []).map((tracker) => ({
        value: tracker,
        label: tracker,
    }));

    // Client IDs, not names: names are not unique in this data, so a name-based
    // filter mixed different clients' hours. Duplicates get "Name (#id)" labels.
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

    const buildFilterParams = (overrides = {}) => {
        const nextDateFilter = overrides.dateFilter !== undefined ? overrides.dateFilter : dateFilter;
        const nextStartDate = overrides.customStartDate !== undefined ? overrides.customStartDate : customStartDate;
        const nextEndDate = overrides.customEndDate !== undefined ? overrides.customEndDate : customEndDate;
        const nextWorkTypes = overrides.selectedWorkTypes !== undefined ? overrides.selectedWorkTypes : selectedWorkTypes;
        const nextTrackers = overrides.selectedTrackers !== undefined ? overrides.selectedTrackers : selectedTrackers;
        const nextClients = overrides.selectedClients !== undefined ? overrides.selectedClients : selectedClients;
        const nextSearch = overrides.searchTerm !== undefined ? overrides.searchTerm : searchTerm;
        const params = {
            filter: nextDateFilter,
        };

        if (nextWorkTypes.length) params.workTypes = nextWorkTypes;
        if (nextTrackers.length) params.trackers = nextTrackers;
        if (nextClients.length) params.clients = nextClients;
        if (nextSearch) params.search = nextSearch;

        if (nextDateFilter === 'custom' && nextStartDate && nextEndDate) {
            params.startDate = formatDateLocal(nextStartDate);
            params.endDate = formatDateLocal(nextEndDate);
        } else if (nextDateFilter !== 'all' && nextDateFilter !== 'custom') {
            const range = getDateRange(nextDateFilter);
            params.startDate = range.start;
            params.endDate = range.end;
        }

        return params;
    };

    const applyFilters = (overrides = {}) => {
        router.get(route('work-hours.index'), buildFilterParams(overrides), {
            preserveState: true,
            preserveScroll: true,
        });
        clearSelection();
    };

    const clearFilters = () => {
        setDateFilter('all');
        setCustomStartDate(null);
        setCustomEndDate(null);
        setSelectedWorkTypes([]);
        setSelectedTrackers([]);
        setSelectedClients([]);
        setSearchTerm('');
        router.get(route('work-hours.index'));
        clearSelection();
    };

    const removeFilterValue = (type, value) => {
        if (type === 'workTypes') {
            const next = selectedWorkTypes.filter((item) => item !== value);
            setSelectedWorkTypes(next);
            applyFilters({ selectedWorkTypes: next });
        } else if (type === 'trackers') {
            const next = selectedTrackers.filter((item) => item !== value);
            setSelectedTrackers(next);
            applyFilters({ selectedTrackers: next });
        } else if (type === 'clients') {
            const next = selectedClients.filter((item) => item !== value);
            setSelectedClients(next);
            applyFilters({ selectedClients: next });
        } else if (type === 'date') {
            setDateFilter('all');
            setCustomStartDate(null);
            setCustomEndDate(null);
            applyFilters({ dateFilter: 'all', customStartDate: null, customEndDate: null });
        }
    };

    const activeFilterChips = [
        ...(dateFilter !== 'all'
            ? [{
                key: 'date',
                label: dateFilter === 'custom' && customStartDate && customEndDate
                    ? `Date: ${formatDateLocal(customStartDate)} to ${formatDateLocal(customEndDate)}`
                    : `Date: ${dateFilter === 'week' ? 'This Week' : dateFilter === 'month' ? 'This Month' : 'Today'}`,
                onRemove: () => removeFilterValue('date'),
            }]
            : []),
        ...selectedWorkTypes.map((value) => ({
            key: `workTypes-${value}`,
            label: `Type: ${formatWorkType(value)}`,
            onRemove: () => removeFilterValue('workTypes', value),
        })),
        ...selectedTrackers.map((value) => ({
            key: `trackers-${value}`,
            label: `Tracker: ${value}`,
            onRemove: () => removeFilterValue('trackers', value),
        })),
        ...selectedClients.map((value) => ({
            key: `clients-${value}`,
            label: `Client: ${clientLabel(value)}`,
            onRemove: () => removeFilterValue('clients', value),
        })),
    ];

    const handleBulkDelete = () => {
        if (selectedEntries.size === 0) return;
        
        const entryIds = Array.from(selectedEntries);
        router.post(route('work-hours.bulk-delete'), {
            ids: entryIds,
        }, {
            onSuccess: () => {
                setToast(`${entryIds.length} entries deleted successfully`);
                setToastType('success');
                clearSelection();
            },
            onError: () => {
                setToast('Failed to delete entries');
                setToastType('error');
            },
        });
    };

    const exportToCSV = async () => {
        setIsExporting(true);
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

            const response = await fetch(`${route('work-hours.export-personal')}?${query.toString()}`, {
                headers: {
                    Accept: 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                },
            });

            if (!response.ok) {
                throw new Error('Failed to fetch export data');
            }

            const result = await response.json();
            const data = result.data || [];
            const csvData = data.map(entry => ({
                'ID': entry.id,
                'Date': entry.date,
                'Client': entry.client?.name || 'No Client',
                'Work Type': formatWorkType(entry.work_type),
                'Tracker': entry.tracker,
                'Source': entry.source === 'tracker' ? 'Auto' : 'Logged',
                'Hours': timeFormat(entry.hours),
                'Description': entry.description || ''
            }));

            exportRowsToCsv(csvData, `work-hours-${new Date().toISOString().split('T')[0]}.csv`);
            
            setToast('Export successful!');
            setToastType('success');
        } catch (error) {
            setToast('Export failed');
            setToastType('error');
        } finally {
            setIsExporting(false);
        }
    };

    // Search is applied server-side (WorkHourController@index), so the rendered
    // rows are exactly this paginated page — no client-side filtering. This
    // keeps select-all / bulk-delete scoped to visible rows only.
    const filteredData = useMemo(() => workHours?.data || [], [workHours?.data]);

    // Grand total across every matching page, computed server-side.
    const totalHours = Number(filteredTotalHours || 0);

    // Surface a subtotal for any client logged more than once on the same day
    // (the confusing "same client, three rows" case) — without touching the
    // editable rows below, which stay individually editable/deletable.
    const dailyGroups = useMemo(() => {
        const map = new Map();
        for (const e of filteredData) {
            const key = `${e.date}|${e.client?.name || 'No Client'}`;
            if (!map.has(key)) {
                map.set(key, { key, date: e.date, client: e.client?.name || 'No Client', count: 0, total: 0 });
            }
            const g = map.get(key);
            g.count += 1;
            g.total += Number(e.hours || 0);
        }
        return [...map.values()].filter((g) => g.count > 1).sort((a, b) => (a.date < b.date ? 1 : -1));
    }, [filteredData]);

    return (
        <AuthenticatedLayout user={auth.user}>
            <Head title="Work Diary" />
            
            {toast && <Toast message={toast} type={toastType} onClose={() => setToast('')} />}
            
            <PageShell>
                    <PageHeader
                        title="Work Diary"
                        description="Review, filter, and manage your personal work entries."
                        actions={(
                            <Link
                                href={`${route('work-hours.create')}?return_to=${encodeURIComponent(currentListUrl())}`}
                                className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
                            >
                                <svg className="mr-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                </svg>
                                Add Manual Time
                            </Link>
                        )}
                    />

                    {/* Actions Card */}
                    <div className="rounded-lg border border-slate-800 bg-slate-900 p-3 shadow-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    onClick={() => setShowFilters((current) => !current)}
                                    className={`inline-flex items-center rounded-lg px-3 py-2 text-sm font-semibold transition ${
                                        showFilters
                                            ? 'bg-gradient-to-r from-orange-500 to-amber-500 text-white'
                                            : 'bg-white/10 text-slate-300 hover:bg-white/20'
                                    }`}
                                >
                                    <svg className="mr-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707L15 13v5a1 1 0 01-.553.894l-4 2A1 1 0 019 20v-7L3.293 7.293A1 1 0 013 6.586V4z" />
                                    </svg>
                                    {showFilters ? 'Hide Filters' : 'Filters'}
                                </button>

                                <button
                                    onClick={exportToCSV}
                                    disabled={isExporting}
                                    className="inline-flex items-center rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:bg-slate-900 disabled:text-slate-500"
                                >
                                    <svg className="mr-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                    </svg>
                                    {isExporting ? 'Exporting...' : 'Export CSV'}
                                </button>

                                {selectedEntries.size > 0 && (
                                    <>
                                        <button
                                            onClick={handleBulkDelete}
                                            className="inline-flex items-center px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-xl font-medium transition-all shadow-lg"
                                        >
                                            <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                            </svg>
                                            Delete ({selectedEntries.size})
                                        </button>
                                        <button
                                            onClick={clearSelection}
                                            className="inline-flex items-center px-4 py-2 bg-slate-500 hover:bg-slate-600 text-white rounded-xl font-medium transition-all"
                                        >
                                            Clear Selection
                                        </button>
                                    </>
                                )}
                            </div>

                            {/* Search */}
                            <div className="relative w-full sm:w-72 lg:w-80">
                                <input
                                    type="text"
                                    placeholder="Search entries..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    className="w-full pl-10 pr-4 py-2 border border-slate-700 bg-slate-900 rounded-lg text-slate-200 placeholder-slate-500 focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                                />
                                <svg className="w-5 h-5 text-slate-400 absolute left-3 top-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                </svg>
                            </div>
                        </div>

                        {showFilters && (
                            <div className="mt-3 border-t border-slate-800 pt-3">
                                <div>
                                    <label className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">Date Range</label>
                                    <div className="flex flex-wrap gap-2">
                                            {[
                                                ['all', 'All Dates'],
                                                ['today', 'Today'],
                                                ['week', 'This Week'],
                                                ['month', 'This Month'],
                                                ['custom', 'Custom'],
                                            ].map(([value, label]) => (
                                                <button
                                                    key={value}
                                                    type="button"
                                                    onClick={() => {
                                                        setDateFilter(value);
                                                        if (value !== 'custom') {
                                                            applyFilters({ dateFilter: value });
                                                        }
                                                    }}
                                                    className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                                                        dateFilter === value
                                                            ? 'bg-gradient-to-r from-orange-500 to-amber-500 text-white'
                                                            : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                                                    }`}
                                                >
                                                    {label}
                                                </button>
                                            ))}
                                    </div>
                                </div>

                                <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
                                    <SearchableMultiSelect
                                        label="Work Type"
                                        options={workTypeOptions}
                                        selectedValues={selectedWorkTypes}
                                        onChange={(values) => {
                                            setSelectedWorkTypes(values);
                                            applyFilters({ selectedWorkTypes: values });
                                        }}
                                        placeholder="All types"
                                    />

                                    <SearchableMultiSelect
                                        label="Tracker"
                                        options={trackerOptions}
                                        selectedValues={selectedTrackers}
                                        onChange={(values) => {
                                            setSelectedTrackers(values);
                                            applyFilters({ selectedTrackers: values });
                                        }}
                                        placeholder="All trackers"
                                    />

                                    <SearchableMultiSelect
                                        label="Client"
                                        options={clientOptions}
                                        selectedValues={selectedClients}
                                        onChange={(values) => {
                                            setSelectedClients(values);
                                            applyFilters({ selectedClients: values });
                                        }}
                                        placeholder="All clients"
                                    />
                                </div>

                                {dateFilter === 'custom' && (
                                    <div className="mt-4 flex flex-wrap items-end gap-4">
                                        <div>
                                            <label className="mb-1 block text-sm font-medium text-slate-400">Start Date</label>
                                            <DatePicker
                                                selected={customStartDate}
                                                onChange={(date) => setCustomStartDate(date)}
                                                maxDate={customEndDate || new Date()}
                                                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-2 focus:ring-orange-500"
                                                dateFormat="yyyy-MM-dd"
                                            />
                                        </div>
                                        <div>
                                            <label className="mb-1 block text-sm font-medium text-slate-400">End Date</label>
                                            <DatePicker
                                                selected={customEndDate}
                                                onChange={(date) => setCustomEndDate(date)}
                                                minDate={customStartDate}
                                                maxDate={new Date()}
                                                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-2 focus:ring-orange-500"
                                                dateFormat="yyyy-MM-dd"
                                            />
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => applyFilters()}
                                            className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-700"
                                        >
                                            Apply Dates
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Bulk Actions */}
                        {workHours?.data && workHours.data.length > 0 && (
                            <div className="mt-4 pt-4 border-t border-slate-800 flex flex-wrap gap-2">
                                <button
                                    onClick={selectAllPage}
                                    className="inline-flex items-center px-3 py-1.5 bg-emerald-500/15 text-emerald-300 rounded-lg text-sm font-medium hover:bg-emerald-500/25 transition-all"
                                >
                                    <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    Select Page ({workHours.data.length})
                                </button>
                            </div>
                        )}

                        <ActiveFilterChips chips={activeFilterChips} onClearAll={activeFilterChips.length ? clearFilters : null} />
                    </div>

                    {dailyGroups.length > 0 && (
                        <div className="mb-4 rounded-lg border border-slate-800 bg-slate-900 p-4 shadow-sm">
                            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                                Totals by client · day{' '}
                                <span className="font-normal normal-case text-slate-500">— clients you logged more than once on this page</span>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {dailyGroups.map((g) => (
                                    <span key={g.key} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs">
                                        <span className="text-slate-400">{g.date}</span>
                                        <span className="font-medium text-slate-200">{g.client}</span>
                                        <span className="font-bold text-emerald-300">{timeFormat(g.total)}</span>
                                        <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300">×{g.count}</span>
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Table Card */}
                    <div className="rounded-lg border border-slate-800 bg-slate-900 shadow-sm overflow-hidden">
                        <div className="divide-y divide-slate-800 md:hidden">
                            {filteredData.length === 0 ? (
                                <div className="px-4 py-10 text-center">
                                    <h3 className="text-base font-medium text-white">No work hours found</h3>
                                    <p className="mt-1 text-sm text-slate-400">Start tracking your work hours</p>
                                </div>
                            ) : filteredData.map((entry) => (
                                <div key={entry.id} className="space-y-2 px-4 py-3">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="text-sm font-medium text-slate-100">{entry.date}</div>
                                            <div className="truncate text-sm text-slate-300">{entry.client?.name || 'No Client'}</div>
                                        </div>
                                        <div className="shrink-0 text-base font-bold text-emerald-400">{timeFormat(entry.hours)}</div>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="rounded bg-purple-500/15 px-2 py-0.5 text-xs font-medium text-purple-300">{formatWorkType(entry.work_type)}</span>
                                        {entry.tracker && <span className="rounded bg-teal-500/15 px-2 py-0.5 text-xs font-medium text-teal-300">{entry.tracker}</span>}
                                    </div>
                                    {entry.description && <p className="line-clamp-2 text-sm text-slate-400">{entry.description}</p>}
                                    <div className="flex items-center gap-2 pt-1">
                                        <input
                                            type="checkbox"
                                            aria-label={`Select entry ${entry.id}`}
                                            checked={selectedEntries.has(entry.id)}
                                            onChange={() => toggleSelection(entry.id)}
                                            className="h-5 w-5 rounded border-slate-700 bg-slate-900 text-emerald-600 [color-scheme:dark]"
                                        />
                                        <Link
                                            href={`${route('work-hours.edit', entry.id)}?return_to=${encodeURIComponent(currentListUrl())}`}
                                            className="ml-auto rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white"
                                        >
                                            Edit
                                        </Link>
                                        <button type="button" onClick={() => handleDelete(entry.id)} className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white">
                                            Delete
                                        </button>
                                    </div>
                                </div>
                            ))}
                            {filteredData.length > 0 && (
                                <div className="flex items-center justify-between bg-slate-950 px-4 py-3">
                                    <span className="text-sm font-bold text-slate-100">Total (all pages)</span>
                                    <span className="text-lg font-bold text-emerald-400">{timeFormat(totalHours.toFixed(2))}</span>
                                </div>
                            )}
                        </div>
                        <div className="hidden overflow-x-auto md:block">
                            <table className="min-w-full divide-y divide-slate-800">
                                <thead className="bg-slate-900">
                                    <tr>
                                        <th className="w-12 px-4 py-3 text-left">
                                            <input
                                                type="checkbox"
                                                checked={selectedEntries.size === filteredData.length && filteredData.length > 0}
                                                onChange={selectAllPage}
                                                className="w-4 h-4 text-emerald-600 bg-slate-900 border-slate-700 rounded [color-scheme:dark] focus:ring-emerald-500"
                                            />
                                        </th>
                                        <th className="px-4 py-3 text-left text-xs font-bold text-white uppercase tracking-wider">ID</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold text-white uppercase tracking-wider">Date</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold text-white uppercase tracking-wider">Client</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold text-white uppercase tracking-wider">Work Type</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold text-white uppercase tracking-wider">Tracker</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold text-white uppercase tracking-wider">Source</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold text-white uppercase tracking-wider">Hours</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold text-white uppercase tracking-wider">Description</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold text-white uppercase tracking-wider">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800">
                                    {filteredData.length === 0 ? (
                                        <tr>
                                            <td colSpan="10" className="px-0 py-12 text-center">
                                                <div className="sticky left-0 flex w-[calc(100vw-4rem)] flex-col items-center px-4 sm:w-auto">
                                                    <svg className="w-12 h-12 text-slate-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                    </svg>
                                                    <h3 className="text-lg font-medium text-white mb-2">No work hours found</h3>
                                                    <p className="text-slate-400 mb-4">Start tracking your work hours</p>
                                                    <Link 
                                                        href={`${route('work-hours.create')}?return_to=${encodeURIComponent(currentListUrl())}`}
                                                        className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white shadow-sm hover:bg-blue-700"
                                                    >
                                                        <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                                        </svg>
                                                        Add Manual Time
                                                    </Link>
                                                </div>
                                            </td>
                                        </tr>
                                    ) : (
                                        filteredData.map((entry, index) => (
                                            <tr 
                                                key={entry.id} 
                                                className={`${index % 2 === 0 ? 'bg-slate-900' : 'bg-slate-950/50'} hover:bg-white/5 transition-colors ${selectedEntries.has(entry.id) ? 'ring-2 ring-emerald-400/60 bg-emerald-500/10' : ''}`}
                                            >
                                                <td className="px-4 py-3">
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedEntries.has(entry.id)}
                                                        onChange={() => toggleSelection(entry.id)}
                                                        className="w-4 h-4 text-emerald-600 bg-slate-900 border-slate-700 rounded [color-scheme:dark] focus:ring-emerald-500"
                                                    />
                                                </td>
                                                <td className="px-4 py-3 text-sm font-semibold text-slate-400">{entry.id}</td>
                                                <td className="px-4 py-3 text-sm text-slate-100 font-medium">{entry.date}</td>
                                                <td className="px-4 py-3 text-sm text-slate-300">{entry.client?.name || 'No Client'}</td>
                                                <td className="px-4 py-3 text-sm">
                                                    <span className="inline-flex px-2 py-1 text-xs font-medium bg-purple-500/15 text-purple-300 rounded-full border border-purple-500/20">
                                                        {formatWorkType(entry.work_type)}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3 text-sm">
                                                    {entry.tracker ? (
                                                        <span className="inline-flex px-2 py-1 text-xs font-medium bg-teal-500/15 text-teal-300 rounded-full border border-teal-500/20 capitalize">
                                                            {entry.tracker}
                                                        </span>
                                                    ) : (
                                                        <span className="text-slate-500">—</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 text-sm">
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
                                                <td className="px-4 py-3 text-sm font-bold text-emerald-400">{timeFormat(entry.hours)}</td>
                                                <td className="px-4 py-3 text-sm text-slate-300">
                                                    <div className="max-w-xs truncate" title={entry.description}>
                                                        {entry.description || '-'}
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 text-sm">
                                                    <div className="flex gap-2">
                                                        <Link 
                                                            href={`${route('work-hours.edit', entry.id)}?return_to=${encodeURIComponent(currentListUrl())}`}
                                                            className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-medium rounded-lg transition-all"
                                                        >
                                                            Edit
                                                        </Link>
                                                        <button 
                                                            onClick={() => handleDelete(entry.id)}
                                                            className="px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-xs font-medium rounded-lg transition-all"
                                                        >
                                                            Delete
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                                {filteredData.length > 0 && (
                                    <tfoot className="bg-slate-950">
                                        <tr>
                                            <td colSpan="6" className="px-4 py-3 text-right font-bold text-slate-100">Total (all pages):</td>
                                            <td className="px-4 py-3 font-bold text-emerald-400 text-lg">{timeFormat(totalHours.toFixed(2))}</td>
                                            <td colSpan="2"></td>
                                        </tr>
                                    </tfoot>
                                )}
                            </table>
                        </div>

                        {/* Pagination */}
                        {workHours?.data && workHours.data.length > 0 && (
                            <div className="p-6 border-t border-slate-800">
                                <div className="flex justify-between items-center mb-4">
                                    <div className="text-slate-400 text-sm font-medium">
                                        Showing {workHours.from || 0} to {workHours.to || 0} of {workHours.total || 0} entries
                                    </div>
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

            {/* Delete Modal */}
            {deleteId && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
                    <div className="bg-slate-900 border border-slate-800 rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
                        <h3 className="text-xl font-bold text-slate-100 mb-4">Confirm Delete</h3>
                        <p className="text-slate-300 mb-6">Are you sure you want to delete this work entry? This action cannot be undone.</p>
                        <div className="flex gap-3 justify-end">
                            <button
                                onClick={() => setDeleteId(null)}
                                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg font-medium transition-all"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmDelete}
                                className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg font-medium transition-all"
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </AuthenticatedLayout>
    );
}
