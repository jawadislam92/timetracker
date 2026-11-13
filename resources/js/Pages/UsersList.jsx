import { useEffect, useMemo, useState } from 'react';
import { Head, Link, router } from '@inertiajs/react';
import axios from 'axios';
import { Pencil, Plus, Search, ShieldCheck, Trash2, UserCheck, Users, UserX } from 'lucide-react';

import AuthenticatedLayout from '@/Layouts/AuthenticatedLayout';
import Avatar from '@/Components/Avatar';
import ActiveFilterChips from '@/Components/Filters/ActiveFilterChips';
import SearchableMultiSelect from '@/Components/Filters/SearchableMultiSelect';
import { TraditionalPagination } from '@/Components/Pagination';
import { WORK_TIMEZONES } from '@/constants/workTimezones';

const roleStyles = {
    owner: 'bg-amber-500/15 text-amber-300',
    super_admin: 'bg-violet-500/15 text-violet-300',
    admin: 'bg-blue-500/15 text-blue-300',
    member: 'bg-emerald-500/15 text-emerald-300',
};

const noDesignationValue = 'no_designation';

export default function UsersList({ auth, users, filters = {}, filterOptions = {}, managedDesignations = [], managedShifts = [], permissionGroups = {} }) {
    const can = (permission) => auth.user?.is_super_admin || auth.user?.permissions?.includes(permission);
    // Super Admins are protected from non-Super-Admins; Owners from everyone but Owners.
    const isLocked = (u) => (u.role === 'super_admin' && !auth.user.is_super_admin) || (u.role === 'owner' && !auth.user.is_owner);
    const [search, setSearch] = useState(filters.search || '');
    const [roles, setRoles] = useState((filters.roles || []).map(String));
    const [designations, setDesignations] = useState((filters.designations || []).map(String));
    const [perPage, setPerPage] = useState(users?.per_page || 10);
    const [statusFilter, setStatusFilter] = useState(filters.status || 'all');
    const [deleteUser, setDeleteUser] = useState(null);
    const [showDesignationDialog, setShowDesignationDialog] = useState(false);
    const [newDesignation, setNewDesignation] = useState('');
    const [showShiftDialog, setShowShiftDialog] = useState(false);
    const [newShift, setNewShift] = useState('');

    // Bulk edit: only the sections the admin enables get applied.
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [selectAllMatching, setSelectAllMatching] = useState(false);
    const [showBulkModal, setShowBulkModal] = useState(false);
    const [bulkSaving, setBulkSaving] = useState(false);
    const bulkDefaults = {
        setShift: false, shiftTime: '', shiftGrace: 15,
        setShiftId: false, shiftId: '',
        setShiftHours: false, shiftHours: '',
        setClockout: false, clockout: '',
        setDesignation: false, designation: '',
        setWorkTz: false, workTz: 'Asia/Karachi',
        setRole: false, role: '',
        setTracksTime: false, tracksTime: 'yes',
        setDevices: false, allowDevices: 'no',
        permsAdd: [], permsRemove: [],
        slackMode: '',
    };
    const [bulk, setBulk] = useState(bulkDefaults);

    const permissionOptions = useMemo(() => (
        Object.entries(permissionGroups).flatMap(([group, perms]) =>
            Object.entries(perms).map(([key, def]) => ({
                value: key,
                label: `${group} — ${typeof def === 'string' ? def : def.label}`,
            }))
        )
    ), [permissionGroups]);

    const toggleSelected = (id) => {
        setSelectAllMatching(false);
        setSelectedIds((prev) => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    const submitBulk = async () => {
        setBulkSaving(true);
        try {
            const res = await axios.post(route('users.bulk-update'), {
                user_ids: [...selectedIds],
                set_shift: bulk.setShift,
                shift_start_time: bulk.setShift ? (bulk.shiftTime || null) : null,
                shift_grace_minutes: bulk.setShift ? (bulk.shiftGrace === '' ? null : Number(bulk.shiftGrace)) : null,
                set_shift_id: bulk.setShiftId,
                shift_id: bulk.setShiftId ? (bulk.shiftId === '' ? null : Number(bulk.shiftId)) : null,
                set_shift_hours: bulk.setShiftHours,
                shift_hours: bulk.setShiftHours ? (bulk.shiftHours === '' ? null : Number(bulk.shiftHours)) : null,
                set_clockout_reminder: bulk.setClockout,
                clockout_reminder_minutes: bulk.setClockout ? (bulk.clockout === '' ? null : Number(bulk.clockout)) : null,
                set_designation: bulk.setDesignation,
                designation: bulk.setDesignation ? bulk.designation : null,
                set_work_timezone: bulk.setWorkTz,
                work_timezone: bulk.setWorkTz ? bulk.workTz : null,
                set_role: bulk.setRole,
                role: bulk.setRole ? (bulk.role || null) : null,
                set_tracks_time: bulk.setTracksTime,
                tracks_time: bulk.setTracksTime ? bulk.tracksTime === 'yes' : null,
                set_allow_multiple_devices: bulk.setDevices,
                allow_multiple_devices: bulk.setDevices ? bulk.allowDevices === 'yes' : null,
                permissions_add: bulk.permsAdd,
                permissions_remove: bulk.permsRemove,
                slack_reports: bulk.slackMode || null,
            });
            setShowBulkModal(false);
            setSelectedIds(new Set());
            setBulk(bulkDefaults);
            router.reload({ preserveScroll: true });
            window.alert(res.data.message);
        } catch (err) {
            window.alert(err.response?.data?.message || 'Bulk update failed.');
        } finally {
            setBulkSaving(false);
        }
    };

    const roleOptions = useMemo(() => filterOptions.roles || [], [filterOptions.roles]);
    const designationOptions = useMemo(() => [
        { value: noDesignationValue, label: 'No designation' },
        ...(filterOptions.designations || []).map((designation) => ({
            value: String(designation),
            label: String(designation),
        })),
    ], [filterOptions.designations]);

    const applyFilters = (changes = {}) => {
        const next = {
            search: changes.search ?? search,
            roles: changes.roles ?? roles,
            designations: changes.designations ?? designations,
            perPage: changes.perPage ?? perPage,
            status: changes.status ?? statusFilter,
            sort: changes.sort ?? (filters.sort || 'name'),
            dir: changes.dir ?? (filters.dir || 'asc'),
        };

        router.get(route('users.index'), next, {
            preserveState: true,
            preserveScroll: true,
            replace: true,
        });
    };

    const sortBy = (column) => {
        const dir = (filters.sort || 'name') === column && (filters.dir || 'asc') === 'asc' ? 'desc' : 'asc';
        applyFilters({ sort: column, dir });
    };

    useEffect(() => {
        const timer = window.setTimeout(() => {
            if (search !== (filters.search || '')) applyFilters({ search });
        }, 400);

        return () => window.clearTimeout(timer);
    }, [search]);

    const chips = useMemo(() => {
        const items = [];
        const roleLabels = new Map(roleOptions.map((option) => [String(option.value), option.label]));
        const designationLabels = new Map(designationOptions.map((option) => [String(option.value), option.label]));

        roles.forEach((role) => items.push({
            key: `role-${role}`,
            label: `Role: ${roleLabels.get(role) || role}`,
            onRemove: () => {
                const next = roles.filter((item) => item !== role);
                setRoles(next);
                applyFilters({ roles: next });
            },
        }));
        designations.forEach((designation) => items.push({
            key: `designation-${designation}`,
            label: `Designation: ${designationLabels.get(designation) || designation}`,
            onRemove: () => {
                const next = designations.filter((item) => item !== designation);
                setDesignations(next);
                applyFilters({ designations: next });
            },
        }));

        return items;
    }, [roles, designations, roleOptions, designationOptions]);

    const clearFilters = () => {
        setRoles([]);
        setDesignations([]);
        setSearch('');
        router.get(route('users.index'), { perPage }, { preserveState: true, replace: true });
    };

    const currentListUrl = () => (
        typeof window === 'undefined'
            ? route('users.index')
            : `${window.location.pathname}${window.location.search}`
    );

    const editUserHref = (userId) => {
        const returnTo = currentListUrl();
        return `${route('users.edit', userId)}?return_to=${encodeURIComponent(returnTo)}`;
    };

    const confirmDelete = () => {
        if (!deleteUser) return;
        router.delete(route('users.destroy', deleteUser.id), {
            data: { return_to: currentListUrl() },
            preserveState: true,
            preserveScroll: true,
            onFinish: () => setDeleteUser(null),
        });
    };

    const addDesignation = (event) => {
        event.preventDefault();
        const name = newDesignation.trim();

        if (!name) return;

        router.post(route('users.designations.store'), {
            name,
            return_to: currentListUrl(),
        }, {
            preserveScroll: true,
            onSuccess: () => setNewDesignation(''),
        });
    };

    const removeDesignation = (designation) => {
        router.delete(route('users.designations.destroy', designation.id), {
            data: { return_to: currentListUrl() },
            preserveScroll: true,
        });
    };

    const addShift = (event) => {
        event.preventDefault();
        const name = newShift.trim();
        if (!name) return;

        router.post(route('users.shifts.store'), {
            name,
            return_to: currentListUrl(),
        }, {
            preserveScroll: true,
            onSuccess: () => setNewShift(''),
        });
    };

    const removeShift = (shift) => {
        router.delete(route('users.shifts.destroy', shift.id), {
            data: { return_to: currentListUrl() },
            preserveScroll: true,
        });
    };

    // Deactivate someone who left (or reactivate). Their history is kept; a
    // deactivated user can't log in or track, and drops out of active views.
    const setStatus = (user) => {
        const isActive = !user.is_active;
        if (!isActive && !window.confirm(`Deactivate ${user.name}? They can no longer sign in or track time. History is kept; you can reactivate anytime.`)) return;
        router.patch(route('users.set-status', user.id), { is_active: isActive, return_to: currentListUrl() }, { preserveScroll: true });
    };

    // Bulk activate/deactivate: either the explicit ticked set, or — for the
    // first cleanup — everyone matching the current filters ("select all N").
    const bulkStatus = (isActive) => {
        const count = selectAllMatching ? users.total : selectedIds.size;
        if (!count) return;
        const verb = isActive ? 'Reactivate' : 'Deactivate';
        if (!window.confirm(`${verb} ${count} user${count === 1 ? '' : 's'}? History is kept; this is reversible.`)) return;
        const payload = selectAllMatching
            ? { is_active: isActive, all_matching: true, search, roles, designations, status: statusFilter, return_to: currentListUrl() }
            : { is_active: isActive, ids: [...selectedIds], return_to: currentListUrl() };
        router.post(route('users.bulk-status'), payload, {
            preserveScroll: true,
            onFinish: () => { setSelectedIds(new Set()); setSelectAllMatching(false); },
        });
    };

    return (
        <AuthenticatedLayout user={auth.user}>
            <Head title="Users" />
            <div className="min-h-screen bg-slate-950">
                <div className="mx-auto max-w-none space-y-5 px-4 py-6 sm:px-6 lg:px-8">
                    <section className="flex flex-col gap-4 border-b border-slate-800 pb-5 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                            <p className="text-sm font-semibold text-orange-400">Team management</p>
                            <h1 className="mt-1 text-2xl font-bold text-white">Users</h1>
                            <p className="mt-1 text-sm text-slate-400">Manage accounts, roles, designations, and selected access.</p>
                        </div>
                        {can('users.manage') && (
                            <div className="flex flex-col gap-2 sm:flex-row">
                                <button
                                    type="button"
                                    onClick={() => setShowDesignationDialog(true)}
                                    className="inline-flex items-center justify-center rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-bold text-slate-200 shadow-sm hover:bg-slate-800"
                                >
                                    Manage designations
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setShowShiftDialog(true)}
                                    className="inline-flex items-center justify-center rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-bold text-slate-200 shadow-sm hover:bg-slate-800"
                                >
                                    Manage shifts
                                </button>
                                <Link
                                    href={route('users.create')}
                                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-blue-700"
                                >
                                    <Plus className="h-4 w-4" />
                                    Add user
                                </Link>
                            </div>
                        )}
                    </section>

                    <section className="rounded-lg border border-slate-800 bg-slate-900 shadow-sm">
                        <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-[minmax(240px,1fr)_210px_210px_150px_120px]">
                            <label className="block">
                                <span className="mb-2 block text-sm font-semibold text-slate-300">Search</span>
                                <span className="relative block">
                                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                                    <input
                                        type="search"
                                        value={search}
                                        onChange={(event) => setSearch(event.target.value)}
                                        placeholder="Name or email"
                                        className="w-full rounded-lg border-slate-700 bg-slate-900 py-2 pl-9 pr-3 text-sm text-slate-200 placeholder-slate-500 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500"
                                    />
                                </span>
                            </label>
                            <SearchableMultiSelect
                                label="Roles"
                                options={roleOptions}
                                selectedValues={roles}
                                onChange={(next) => {
                                    setRoles(next);
                                    applyFilters({ roles: next });
                                }}
                                placeholder="All roles"
                            />
                            <SearchableMultiSelect
                                label="Designations"
                                options={designationOptions}
                                selectedValues={designations}
                                onChange={(next) => {
                                    setDesignations(next);
                                    applyFilters({ designations: next });
                                }}
                                placeholder="All designations"
                            />
                            <label className="block">
                                <span className="mb-2 block text-sm font-semibold text-slate-300">Status</span>
                                <select
                                    value={statusFilter}
                                    onChange={(event) => {
                                        const next = event.target.value;
                                        setStatusFilter(next);
                                        setSelectedIds(new Set());
                                        setSelectAllMatching(false);
                                        applyFilters({ status: next });
                                    }}
                                    className="w-full rounded-lg border-slate-700 bg-slate-900 py-2 text-sm text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500"
                                >
                                    <option value="all">All</option>
                                    <option value="active">Active</option>
                                    <option value="archived">Deactivated</option>
                                </select>
                            </label>
                            <label className="block">
                                <span className="mb-2 block text-sm font-semibold text-slate-300">Rows</span>
                                <select
                                    value={perPage}
                                    onChange={(event) => {
                                        const next = Number(event.target.value);
                                        setPerPage(next);
                                        applyFilters({ perPage: next });
                                    }}
                                    className="w-full rounded-lg border-slate-700 bg-slate-900 py-2 text-sm text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500"
                                >
                                    {[10, 25, 50, 100].map((value) => <option key={value} value={value}>{value}</option>)}
                                </select>
                            </label>
                        </div>
                        <div className="px-4 pb-4">
                            <ActiveFilterChips chips={chips} onClearAll={clearFilters} />
                        </div>
                    </section>

                    <section className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900 shadow-sm">
                        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
                            <div className="flex items-center gap-3">
                                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-500/10 text-orange-400">
                                    <Users className="h-5 w-5" />
                                </span>
                                <div>
                                    <h2 className="font-bold text-slate-100">Team directory</h2>
                                    <p className="text-sm text-slate-400">{users.total} account{users.total === 1 ? '' : 's'}</p>
                                </div>
                            </div>
                            {selectedIds.size > 0 && (
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-semibold text-orange-400">
                                        {selectAllMatching ? `All ${users.total} matching selected` : `${selectedIds.size} selected`}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setShowBulkModal(true)}
                                        disabled={selectAllMatching}
                                        title={selectAllMatching ? 'Bulk edit works on an explicit selection' : undefined}
                                        className="rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:from-orange-600 hover:to-amber-600 disabled:opacity-50"
                                    >
                                        Bulk edit
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => bulkStatus(false)}
                                        className="rounded-lg border border-rose-500/40 px-3 py-1.5 text-sm font-semibold text-rose-300 hover:bg-rose-500/15"
                                    >
                                        Deactivate
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => bulkStatus(true)}
                                        className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/15"
                                    >
                                        Reactivate
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => { setSelectedIds(new Set()); setSelectAllMatching(false); }}
                                        className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
                                    >
                                        Clear
                                    </button>
                                </div>
                            )}
                        </div>

                        {!selectAllMatching && selectedIds.size > 0 && users.total > users.data.length
                            && selectedIds.size >= users.data.filter((u) => !isLocked(u)).length && (
                            <div className="border-b border-slate-800 bg-orange-500/5 px-5 py-2 text-center text-sm text-slate-300">
                                All {selectedIds.size} on this page selected.{' '}
                                <button type="button" onClick={() => setSelectAllMatching(true)} className="font-semibold text-orange-400 hover:text-orange-300">
                                    Select all {users.total} matching your filters
                                </button>
                            </div>
                        )}

                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y divide-slate-800">
                                <thead className="bg-slate-950">
                                    <tr>
                                        {can('users.manage') && (
                                            <th className="w-10 px-4 py-3">
                                                <input
                                                    type="checkbox"
                                                    checked={users.data.length > 0 && users.data.every((u) => selectedIds.has(u.id) || isLocked(u))}
                                                    onChange={(e) => {
                                                        const next = new Set(selectedIds);
                                                        users.data.forEach((u) => {
                                                            if (isLocked(u)) return;
                                                            e.target.checked ? next.add(u.id) : next.delete(u.id);
                                                        });
                                                        setSelectedIds(next);
                                                    }}
                                                    className="rounded border-slate-500 bg-slate-800"
                                                />
                                            </th>
                                        )}
                                        {[
                                            { heading: 'User', sort: 'name' },
                                            { heading: 'Designation', sort: 'designation' },
                                            { heading: 'Shift', sort: 'shift' },
                                            { heading: 'Role', sort: 'role' },
                                            { heading: 'Weekly tracked', sort: 'weekly_hours', help: 'Work-diary hours this week (tracker + manual entries) — not clock in/out time.' },
                                            { heading: 'Actions', sort: null },
                                        ].map(({ heading, sort, help }, index) => (
                                            <th
                                                key={heading}
                                                className={`whitespace-nowrap px-4 py-3 text-left text-xs font-bold uppercase text-slate-300 ${
                                                    index === 0 ? 'sticky left-0 z-10 bg-slate-950' : ''
                                                }`}
                                            >
                                                {sort ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => sortBy(sort)}
                                                        title={help || `Sort by ${heading.toLowerCase()}`}
                                                        className="inline-flex items-center gap-1 uppercase hover:text-orange-300"
                                                    >
                                                        {heading}
                                                        {help && <span className="text-slate-400">ⓘ</span>}
                                                        {(filters.sort || 'name') === sort && (
                                                            <span>{(filters.dir || 'asc') === 'asc' ? '▲' : '▼'}</span>
                                                        )}
                                                    </button>
                                                ) : heading}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800">
                                    {users.data.length === 0 ? (
                                        <tr>
                                            <td colSpan={can('users.manage') ? 7 : 6} className="px-5 py-14 text-center">
                                                <Users className="mx-auto h-10 w-10 text-slate-500" />
                                                <h3 className="mt-3 font-semibold text-slate-100">No users found</h3>
                                                <p className="mt-1 text-sm text-slate-400">Adjust the search or selected filters.</p>
                                            </td>
                                        </tr>
                                    ) : users.data.map((user) => {
                                        const canEdit = can('users.manage') && !isLocked(user);
                                        const canDelete = can('users.delete')
                                            && user.id !== auth.user.id
                                            && !isLocked(user);
                                        const canSetStatus = can('users.manage')
                                            && user.id !== auth.user.id
                                            && !isLocked(user);

                                        return (
                                            <tr key={user.id} className={`bg-slate-900 transition hover:bg-slate-800/40 ${selectedIds.has(user.id) ? 'bg-orange-500/10' : ''}`}>
                                                {can('users.manage') && (
                                                    <td className="w-10 px-4 py-3">
                                                        <input
                                                            type="checkbox"
                                                            checked={selectedIds.has(user.id)}
                                                            disabled={isLocked(user)}
                                                            onChange={() => toggleSelected(user.id)}
                                                            className="rounded border-slate-700 text-orange-600 focus:ring-orange-500"
                                                        />
                                                    </td>
                                                )}
                                                <td className="sticky left-0 z-[1] min-w-64 bg-inherit px-4 py-3">
                                                    <div className="flex items-center gap-3">
                                                        <Avatar user={user} size="md" />
                                                        <div className="min-w-0">
                                                            <div className="flex items-center gap-2">
                                                                <span className="truncate text-sm font-semibold text-slate-100">{user.name}</span>
                                                                {!user.is_active && (
                                                                    <span className="shrink-0 rounded-full bg-slate-700/40 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-300">Deactivated</span>
                                                                )}
                                                            </div>
                                                            <div className="truncate text-sm text-slate-400">{user.email}</div>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-300">
                                                    <div className="font-medium text-slate-100">{user.designation || 'No designation'}</div>
                                                    {user.joining_date_display && (
                                                        <div className="text-xs text-slate-400">
                                                            Joined {user.joining_date_display}
                                                        </div>
                                                    )}
                                                </td>
                                                <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-300">
                                                    {user.shift_start_display ? (
                                                        <>
                                                            <div className="font-medium text-slate-100">{user.shift_start_display}</div>
                                                            <div className="text-xs text-slate-400">{user.shift_grace_minutes ?? 15}m grace</div>
                                                        </>
                                                    ) : (
                                                        <span className="text-slate-500">Not configured</span>
                                                    )}
                                                </td>
                                                <td className="whitespace-nowrap px-4 py-3">
                                                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${roleStyles[user.role] || 'bg-slate-700/40 text-slate-300'}`}>
                                                        {(user.role === 'super_admin' || user.role === 'owner') && <ShieldCheck className="h-3.5 w-3.5" />}
                                                        {user.role_label || user.role}
                                                    </span>
                                                </td>
                                                <td className="whitespace-nowrap px-4 py-3 font-mono text-sm font-semibold text-slate-100">
                                                    {user.weekly_hours_worked || '00:00'}
                                                </td>
                                                <td className="whitespace-nowrap px-4 py-3">
                                                    <div className="flex items-center gap-2">
                                                        {canEdit && (
                                                            <Link
                                                                href={editUserHref(user.id)}
                                                                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 text-slate-200 hover:bg-slate-800"
                                                                title={`Edit ${user.name}`}
                                                            >
                                                                <Pencil className="h-4 w-4" />
                                                            </Link>
                                                        )}
                                                        {canDelete && (
                                                            <button
                                                                type="button"
                                                                onClick={() => setDeleteUser(user)}
                                                                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-rose-500/40 text-rose-300 hover:bg-rose-500/15"
                                                                title={`Delete ${user.name}`}
                                                            >
                                                                <Trash2 className="h-4 w-4" />
                                                            </button>
                                                        )}
                                                        {canSetStatus && (
                                                            <button
                                                                type="button"
                                                                onClick={() => setStatus(user)}
                                                                className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border ${user.is_active ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/15'}`}
                                                                title={user.is_active ? `Deactivate ${user.name}` : `Reactivate ${user.name}`}
                                                            >
                                                                {user.is_active ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
                                                            </button>
                                                        )}
                                                        {!canEdit && !canDelete && !canSetStatus && <span className="text-sm text-slate-500">-</span>}
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                        {users.total > 0 && (
                            <div className="border-t border-slate-800 bg-slate-900 px-4 py-4">
                                <TraditionalPagination pagination={users} preserveState preserveScroll />
                            </div>
                        )}
                    </section>
                </div>
            </div>

            {showBulkModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
                    <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-slate-900 p-5 shadow-xl">
                        <h2 className="text-lg font-bold text-white">Bulk edit {selectedIds.size} user{selectedIds.size === 1 ? '' : 's'}</h2>
                        <p className="mt-1 text-sm text-slate-400">Only the sections you enable below will be applied — everything else stays untouched.</p>

                        <div className="mt-4 space-y-4">
                            <div className="rounded-lg border border-slate-800 p-3">
                                <label className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                                    <input type="checkbox" checked={bulk.setShift} onChange={(e) => setBulk({ ...bulk, setShift: e.target.checked })} className="rounded border-slate-700 bg-slate-900 text-orange-600" />
                                    Set shift
                                </label>
                                {bulk.setShift && (
                                    <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-300">
                                        <label className="flex items-center gap-2">Start
                                            <input type="time" value={bulk.shiftTime} onChange={(e) => setBulk({ ...bulk, shiftTime: e.target.value })} className="rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark]" />
                                        </label>
                                        <label className="flex items-center gap-2">Grace (min)
                                            <input type="number" min="0" max="240" value={bulk.shiftGrace} onChange={(e) => setBulk({ ...bulk, shiftGrace: e.target.value })} className="w-20 rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark]" />
                                        </label>
                                        <span className="text-xs text-slate-400">Leave start empty to clear the start time.</span>
                                    </div>
                                )}
                            </div>

                            <div className="rounded-lg border border-slate-800 p-3">
                                <label className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                                    <input type="checkbox" checked={bulk.setShiftId} onChange={(e) => setBulk({ ...bulk, setShiftId: e.target.checked })} className="rounded border-slate-700 bg-slate-900 text-orange-600" />
                                    Set shift (name)
                                </label>
                                {bulk.setShiftId && (
                                    <select value={bulk.shiftId} onChange={(e) => setBulk({ ...bulk, shiftId: e.target.value })} className="mt-2 w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark]">
                                        <option value="">No shift</option>
                                        {(filterOptions.shifts || []).map((s) => (
                                            <option key={s.id} value={s.id}>{s.name}</option>
                                        ))}
                                    </select>
                                )}
                            </div>

                            <div className="rounded-lg border border-slate-800 p-3">
                                <label className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                                    <input type="checkbox" checked={bulk.setShiftHours} onChange={(e) => setBulk({ ...bulk, setShiftHours: e.target.checked })} className="rounded border-slate-700 bg-slate-900 text-orange-600" />
                                    Set shift length (hours)
                                </label>
                                {bulk.setShiftHours && (
                                    <div className="mt-2 flex items-center gap-3 text-sm text-slate-300">
                                        <input type="number" min="0" max="24" step="0.5" placeholder="e.g. 10" value={bulk.shiftHours} onChange={(e) => setBulk({ ...bulk, shiftHours: e.target.value })} className="w-28 rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark]" />
                                        <span className="text-xs text-slate-400">Leave blank to clear (team default).</span>
                                    </div>
                                )}
                            </div>

                            <div className="rounded-lg border border-slate-800 p-3">
                                <label className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                                    <input type="checkbox" checked={bulk.setClockout} onChange={(e) => setBulk({ ...bulk, setClockout: e.target.checked })} className="rounded border-slate-700 bg-slate-900 text-orange-600" />
                                    Set clock-out reminder (minutes after shift)
                                </label>
                                {bulk.setClockout && (
                                    <div className="mt-2 flex items-center gap-3 text-sm text-slate-300">
                                        <input type="number" min="0" max="240" step="5" placeholder="e.g. 20" value={bulk.clockout} onChange={(e) => setBulk({ ...bulk, clockout: e.target.value })} className="w-28 rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark]" />
                                        <span className="text-xs text-slate-400">Leave blank for right at shift end.</span>
                                    </div>
                                )}
                            </div>

                            <div className="rounded-lg border border-slate-800 p-3">
                                <label className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                                    <input type="checkbox" checked={bulk.setDesignation} onChange={(e) => setBulk({ ...bulk, setDesignation: e.target.checked })} className="rounded border-slate-700 bg-slate-900 text-orange-600" />
                                    Set designation
                                </label>
                                {bulk.setDesignation && (
                                    <select value={bulk.designation} onChange={(e) => setBulk({ ...bulk, designation: e.target.value })} className="mt-2 w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark]">
                                        <option value="">No designation</option>
                                        {(filterOptions.designations || []).map((d) => (
                                            <option key={d} value={d}>{d}</option>
                                        ))}
                                    </select>
                                )}
                            </div>

                            <div className="rounded-lg border border-slate-800 p-3">
                                <label className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                                    <input type="checkbox" checked={bulk.setWorkTz} onChange={(e) => setBulk({ ...bulk, setWorkTz: e.target.checked })} className="rounded border-slate-700 bg-slate-900 text-orange-600" />
                                    Set work timezone
                                </label>
                                {bulk.setWorkTz && (
                                    <select value={bulk.workTz} onChange={(e) => setBulk({ ...bulk, workTz: e.target.value })} className="mt-2 w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark]">
                                        {WORK_TIMEZONES.map((zone) => (
                                            <option key={zone} value={zone}>{zone.replace(/_/g, ' ')}</option>
                                        ))}
                                    </select>
                                )}
                            </div>

                            {auth.user.is_super_admin && (
                                <div className="rounded-lg border border-slate-800 p-3">
                                    <label className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                                        <input type="checkbox" checked={bulk.setRole} onChange={(e) => setBulk({ ...bulk, setRole: e.target.checked })} className="rounded border-slate-700 bg-slate-900 text-orange-600" />
                                        Set role <span className="font-normal text-xs text-slate-400">(Super Admin only)</span>
                                    </label>
                                    {bulk.setRole && (
                                        <select value={bulk.role} onChange={(e) => setBulk({ ...bulk, role: e.target.value })} className="mt-2 w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark]">
                                            <option value="">Choose a role…</option>
                                            {roleOptions.filter((r) => r.value !== 'owner' || auth.user.is_owner).map((r) => (
                                                <option key={r.value} value={r.value}>{r.label}</option>
                                            ))}
                                        </select>
                                    )}
                                </div>
                            )}

                            {auth.user.is_super_admin && (
                                <div className="rounded-lg border border-slate-800 p-3">
                                    <label className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                                        <input type="checkbox" checked={bulk.setTracksTime} onChange={(e) => setBulk({ ...bulk, setTracksTime: e.target.checked })} className="rounded border-slate-700 bg-slate-900 text-orange-600" />
                                        Set “tracks time” <span className="font-normal text-xs text-slate-400">(Super Admin only)</span>
                                    </label>
                                    {bulk.setTracksTime && (
                                        <select value={bulk.tracksTime} onChange={(e) => setBulk({ ...bulk, tracksTime: e.target.value })} className="mt-2 w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark]">
                                            <option value="yes">Tracks time (include in performance)</option>
                                            <option value="no">Does not track time (exclude — HR, finance, …)</option>
                                        </select>
                                    )}
                                </div>
                            )}

                            {auth.user.is_super_admin && (
                                <div className="rounded-lg border border-slate-800 p-3 space-y-2">
                                    <p className="text-sm font-semibold text-slate-100">Permissions <span className="font-normal text-xs text-slate-400">(Super Admin only — applied on top of each user&apos;s current access)</span></p>
                                    <SearchableMultiSelect
                                        label="Grant"
                                        options={permissionOptions}
                                        selectedValues={bulk.permsAdd}
                                        onChange={(values) => setBulk({ ...bulk, permsAdd: values })}
                                        placeholder="No permissions to grant"
                                        inline
                                    />
                                    <SearchableMultiSelect
                                        label="Revoke"
                                        options={permissionOptions}
                                        selectedValues={bulk.permsRemove}
                                        onChange={(values) => setBulk({ ...bulk, permsRemove: values })}
                                        placeholder="No permissions to revoke"
                                        inline
                                    />
                                </div>
                            )}

                            {auth.user.is_super_admin && (
                                <div className="rounded-lg border border-slate-800 p-3">
                                    <label className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                                        <input type="checkbox" checked={bulk.setDevices} onChange={(e) => setBulk({ ...bulk, setDevices: e.target.checked })} className="rounded border-slate-700 bg-slate-900 text-orange-600" />
                                        Set device access <span className="font-normal text-xs text-slate-400">(Super Admin only)</span>
                                    </label>
                                    {bulk.setDevices && (
                                        <select value={bulk.allowDevices} onChange={(e) => setBulk({ ...bulk, allowDevices: e.target.value })} className="mt-2 w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark]">
                                            <option value="no">One device at a time (default)</option>
                                            <option value="yes">Allow multiple devices at once</option>
                                        </select>
                                    )}
                                </div>
                            )}

                            {auth.user.is_super_admin && (
                                <div className="rounded-lg border border-slate-800 p-3">
                                    <label className="block text-sm font-semibold text-slate-100">Slack reports <span className="font-normal text-xs text-slate-400">(Super Admin only)</span></label>
                                    <select value={bulk.slackMode} onChange={(e) => setBulk({ ...bulk, slackMode: e.target.value })} className="mt-2 w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark]">
                                        <option value="">Leave unchanged</option>
                                        <option value="include">Include in reports</option>
                                        <option value="exclude">Exclude from reports</option>
                                    </select>
                                </div>
                            )}
                        </div>

                        <div className="mt-5 flex justify-end gap-2">
                            <button type="button" onClick={() => setShowBulkModal(false)} className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">Cancel</button>
                            <button
                                type="button"
                                onClick={submitBulk}
                                disabled={bulkSaving}
                                className="rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-2 text-sm font-semibold text-white hover:from-orange-600 hover:to-amber-600 disabled:opacity-50"
                            >
                                {bulkSaving ? 'Applying…' : `Apply to ${selectedIds.size}`}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {deleteUser && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
                    <div className="w-full max-w-md rounded-lg bg-slate-900 p-5 shadow-xl">
                        <h2 className="text-lg font-bold text-white">Delete user?</h2>
                        <p className="mt-2 text-sm text-slate-400">
                            This will permanently delete {deleteUser.name}. Existing related records may prevent deletion.
                        </p>
                        <div className="mt-5 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setDeleteUser(null)}
                                className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={confirmDelete}
                                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-bold text-white hover:bg-rose-700"
                            >
                                Delete user
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showDesignationDialog && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
                    <div className="w-full max-w-lg rounded-lg bg-slate-900 shadow-xl">
                        <div className="border-b border-slate-800 px-5 py-4">
                            <h2 className="text-lg font-bold text-white">Manage designations</h2>
                            <p className="mt-1 text-sm text-slate-400">These appear as suggestions when adding or editing users.</p>
                        </div>
                        <div className="space-y-4 p-5">
                            <form onSubmit={addDesignation} className="flex gap-2">
                                <input
                                    value={newDesignation}
                                    onChange={(event) => setNewDesignation(event.target.value)}
                                    placeholder="Add designation"
                                    className="min-w-0 flex-1 rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 placeholder-slate-500 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500"
                                />
                                <button
                                    type="submit"
                                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700"
                                >
                                    Add
                                </button>
                            </form>

                            <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-800">
                                {managedDesignations.length === 0 ? (
                                    <div className="px-4 py-6 text-center text-sm text-slate-400">No designation suggestions yet.</div>
                                ) : managedDesignations.map((designation) => (
                                    <div key={designation.id} className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3 last:border-b-0">
                                        <span className="text-sm font-semibold text-slate-100">{designation.name}</span>
                                        <button
                                            type="button"
                                            onClick={() => removeDesignation(designation)}
                                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-rose-500/40 text-rose-300 hover:bg-rose-500/15"
                                            title={`Remove ${designation.name}`}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div className="flex justify-end border-t border-slate-800 px-5 py-4">
                            <button
                                type="button"
                                onClick={() => setShowDesignationDialog(false)}
                                className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showShiftDialog && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
                    <div className="w-full max-w-lg rounded-lg bg-slate-900 shadow-xl">
                        <div className="border-b border-slate-800 px-5 py-4">
                            <h2 className="text-lg font-bold text-white">Manage shifts</h2>
                            <p className="mt-1 text-sm text-slate-400">Shifts you can assign to people (Morning, Evening, …). Deleting one clears it from anyone who had it.</p>
                        </div>
                        <div className="space-y-4 p-5">
                            <form onSubmit={addShift} className="flex gap-2">
                                <input
                                    value={newShift}
                                    onChange={(event) => setNewShift(event.target.value)}
                                    placeholder="Add shift (e.g. Noon)"
                                    className="min-w-0 flex-1 rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 placeholder-slate-500 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500"
                                />
                                <button
                                    type="submit"
                                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700"
                                >
                                    Add
                                </button>
                            </form>

                            <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-800">
                                {managedShifts.length === 0 ? (
                                    <div className="px-4 py-6 text-center text-sm text-slate-400">No shifts yet.</div>
                                ) : managedShifts.map((shift) => (
                                    <div key={shift.id} className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3 last:border-b-0">
                                        <span className="text-sm font-semibold text-slate-100">{shift.name}</span>
                                        <button
                                            type="button"
                                            onClick={() => removeShift(shift)}
                                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-rose-500/40 text-rose-300 hover:bg-rose-500/15"
                                            title={`Remove ${shift.name}`}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div className="flex justify-end border-t border-slate-800 px-5 py-4">
                            <button
                                type="button"
                                onClick={() => setShowShiftDialog(false)}
                                className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </AuthenticatedLayout>
    );
}
