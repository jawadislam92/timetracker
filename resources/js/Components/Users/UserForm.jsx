import { useEffect, useState } from 'react';
import { Link, useForm } from '@inertiajs/react';
import { ArrowLeft, Camera, Check, Crown, ShieldCheck, UserRound, Users } from 'lucide-react';
import Avatar from '@/Components/Avatar';
import { WORK_TIMEZONES } from '@/constants/workTimezones';

const roleIcons = {
    owner: Crown,
    super_admin: ShieldCheck,
    admin: Users,
    member: UserRound,
};

export default function UserForm({
    user = null,
    roles = {},
    permissionGroups = {},
    canManageAccess = false,
    designationOptions = [],
    shiftOptions = [],
    returnTo = '',
}) {
    const editing = Boolean(user);
    const [avatarPreview, setAvatarPreview] = useState(user?.avatar_url || null);
    // True when the saved designation isn't one of the suggestions — the
    // select then shows the free-text input.
    const [customDesignation, setCustomDesignation] = useState(
        Boolean(user?.designation) && !designationOptions.includes(user.designation)
    );
    const form = useForm({
        _method: editing ? 'patch' : 'post',
        name: user?.name || '',
        email: user?.email || '',
        password: '',
        designation: user?.designation || '',
        shift_id: user?.shift_id ?? '',
        joining_date: user?.joining_date || '',
        shift_start_time: user?.shift_start_time || '',
        shift_grace_minutes: user?.shift_grace_minutes ?? 15,
        work_timezone: user?.work_timezone || 'Asia/Karachi',
        shift_hours: user?.shift_hours ?? '',
        clockout_reminder_minutes: user?.clockout_reminder_minutes ?? '',
        role: user?.role || 'member',
        permissions: user?.permissions || [],
        include_in_slack_reports: user?.include_in_slack_reports ?? true,
        tracks_time: user?.tracks_time ?? true,
        is_active: user?.is_active ?? true,
        allow_multiple_devices: user?.allow_multiple_devices ?? false,
        avatar: null,
        shift_effective_from: '',
        return_to: returnTo || user?.return_to || '',
    });

    // Editing a shift field opens a new history era, so HR needs to say WHEN it
    // takes effect — otherwise a correction made today would silently re-judge
    // every past day against the new times.
    const today = new Date().toISOString().slice(0, 10);
    const shiftChanged = [
        ['shift_start_time', user?.shift_start_time || ''],
        ['shift_grace_minutes', user?.shift_grace_minutes ?? 15],
        ['shift_hours', user?.shift_hours ?? ''],
        ['work_timezone', user?.work_timezone || 'Asia/Karachi'],
        ['shift_id', user?.shift_id ?? ''],
    ].some(([key, original]) => String(form.data[key] ?? '') !== String(original ?? ''));

    const togglePermission = (permission) => {
        const selected = form.data.permissions.includes(permission);
        form.setData(
            'permissions',
            selected
                ? form.data.permissions.filter((item) => item !== permission)
                : [...form.data.permissions, permission]
        );
    };

    const fullAccess = form.data.role === 'super_admin' || form.data.role === 'owner';

    const selectRole = (role) => {
        form.setData('role', role);
        if (role === 'super_admin' || role === 'owner') form.setData('permissions', []);
    };

    const handleAvatar = (event) => {
        const file = event.target.files?.[0] || null;
        form.setData('avatar', file);
        setAvatarPreview(file ? URL.createObjectURL(file) : user?.avatar_url || null);
    };

    // Release the blob URL created for a freshly-picked avatar so repeated picks
    // and unmount don't leak it. Only blob: URLs (never a saved avatar_url).
    useEffect(() => {
        if (avatarPreview?.startsWith('blob:')) {
            return () => URL.revokeObjectURL(avatarPreview);
        }
    }, [avatarPreview]);

    const submit = (event) => {
        event.preventDefault();
        form.post(editing ? route('users.update', user.id) : route('users.store'), {
            forceFormData: true,
            preserveScroll: true,
        });
    };

    return (
        <form onSubmit={submit} className="space-y-6">
            <section className="rounded-lg border border-slate-800 bg-slate-900 shadow-sm">
                <div className="border-b border-slate-800 px-5 py-4">
                    <h2 className="font-bold text-white">Account details</h2>
                    <p className="mt-1 text-sm text-slate-400">Identity, login, designation, and attendance schedule.</p>
                </div>

                <div className="grid gap-6 p-5 lg:grid-cols-[180px_1fr]">
                    <div>
                        <div className="flex flex-col items-center gap-3 rounded-lg bg-slate-900 p-4">
                            {avatarPreview ? (
                                <img src={avatarPreview} alt="" className="h-24 w-24 rounded-full object-cover" />
                            ) : (
                                <Avatar user={{ name: form.data.name || 'User' }} size="xl" />
                            )}
                            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">
                                <Camera className="h-4 w-4" />
                                Choose photo
                                <input type="file" accept="image/*" onChange={handleAvatar} className="hidden" />
                            </label>
                            {form.errors.avatar && <p className="text-xs font-medium text-rose-400">{form.errors.avatar}</p>}
                        </div>
                    </div>

                    <div className="grid gap-5 md:grid-cols-2">
                        <Field label="Full name" error={form.errors.name}>
                            <input
                                value={form.data.name}
                                onChange={(event) => form.setData('name', event.target.value)}
                                className="w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 placeholder-slate-500 focus:border-orange-500 focus:ring-orange-500"
                                required
                            />
                        </Field>
                        <Field label="Email address" error={form.errors.email}>
                            <input
                                type="email"
                                value={form.data.email}
                                onChange={(event) => form.setData('email', event.target.value)}
                                className="w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 placeholder-slate-500 focus:border-orange-500 focus:ring-orange-500"
                                required
                            />
                        </Field>
                        <Field
                            label={editing ? 'New password' : 'Password'}
                            hint={editing ? 'Leave blank to keep the current password, or use at least 12 characters.' : 'Use at least 12 characters.'}
                            error={form.errors.password}
                        >
                            <input
                                type="password"
                                value={form.data.password}
                                onChange={(event) => form.setData('password', event.target.value)}
                                className="w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 placeholder-slate-500 focus:border-orange-500 focus:ring-orange-500"
                                required={!editing}
                            />
                        </Field>
                        <Field label="Designation" hint="Pick from the list, or choose “New designation” to type one." error={form.errors.designation}>
                            <select
                                value={customDesignation ? '__custom__' : form.data.designation}
                                onChange={(event) => {
                                    if (event.target.value === '__custom__') {
                                        setCustomDesignation(true);
                                        form.setData('designation', '');
                                    } else {
                                        setCustomDesignation(false);
                                        form.setData('designation', event.target.value);
                                    }
                                }}
                                className="w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500"
                            >
                                <option value="">No designation</option>
                                {designationOptions.map((designation) => (
                                    <option key={designation} value={designation}>{designation}</option>
                                ))}
                                <option value="__custom__">+ New designation…</option>
                            </select>
                            {customDesignation && (
                                <input
                                    value={form.data.designation}
                                    onChange={(event) => form.setData('designation', event.target.value)}
                                    placeholder="Type the new designation"
                                    autoFocus
                                    className="mt-2 w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 placeholder-slate-500 focus:border-orange-500 focus:ring-orange-500"
                                />
                            )}
                        </Field>
                        <Field label="Joining date" hint="Days before this date show as Late joining." error={form.errors.joining_date}>
                            <input
                                type="date"
                                value={form.data.joining_date}
                                onChange={(event) => form.setData('joining_date', event.target.value)}
                                className="w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500"
                            />
                        </Field>
                        <Field label="Shift" hint="Which shift this person is on (Morning/Evening/…). Managers filter the team by this; add or edit shift names on the Users list page." error={form.errors.shift_id}>
                            <select
                                value={form.data.shift_id ?? ''}
                                onChange={(event) => form.setData('shift_id', event.target.value === '' ? '' : Number(event.target.value))}
                                className="w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500"
                            >
                                <option value="">No shift</option>
                                {shiftOptions.map((shift) => (
                                    <option key={shift.id} value={shift.id}>{shift.name}</option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Shift start time" hint="Used to detect late coming automatically." error={form.errors.shift_start_time}>
                            <input
                                type="time"
                                value={form.data.shift_start_time}
                                onChange={(event) => form.setData('shift_start_time', event.target.value)}
                                className="w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500"
                            />
                        </Field>
                        <Field label="Grace period" hint="Late after shift start plus this many minutes." error={form.errors.shift_grace_minutes}>
                            <select
                                value={form.data.shift_grace_minutes}
                                onChange={(event) => form.setData('shift_grace_minutes', Number(event.target.value))}
                                className="w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500"
                            >
                                {[0, 5, 10, 15, 20, 30, 45, 60].map((minutes) => (
                                    <option key={minutes} value={minutes}>
                                        {minutes === 0 ? 'No grace period' : `${minutes} minutes`}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        {editing && shiftChanged && (
                            <Field
                                label="Shift change effective from"
                                hint="Days before this date keep being judged by the previous shift, so past attendance never changes. Pick an earlier date to backdate the change."
                                error={form.errors.shift_effective_from}
                            >
                                <input
                                    type="date"
                                    max={today}
                                    value={form.data.shift_effective_from || today}
                                    onChange={(event) => form.setData('shift_effective_from', event.target.value)}
                                    className="w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500"
                                />
                            </Field>
                        )}
                        <Field label="Work timezone" hint="The country/zone this person's day and shift are measured in. Their clock-in/out, attendance day and auto-close use this zone. Leave Asia/Karachi for local staff." error={form.errors.work_timezone}>
                            <select
                                value={form.data.work_timezone}
                                onChange={(event) => form.setData('work_timezone', event.target.value)}
                                className="w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 [color-scheme:dark] focus:border-orange-500 focus:ring-orange-500"
                            >
                                {WORK_TIMEZONES.map((zone) => (
                                    <option key={zone} value={zone}>
                                        {zone.replace(/_/g, ' ')}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Shift length (hours)" hint="Expected length of this person's shift, e.g. 10. Widens their forgotten-clock-out safety cap. Blank = team default." error={form.errors.shift_hours}>
                            <input
                                type="number"
                                min={0}
                                max={24}
                                step={0.5}
                                value={form.data.shift_hours}
                                onChange={(event) => form.setData('shift_hours', event.target.value)}
                                placeholder="e.g. 10"
                                className="w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 placeholder-slate-500 focus:border-orange-500 focus:ring-orange-500"
                            />
                        </Field>
                        <Field label="Clock-out reminder (minutes after shift)" hint="How long after their shift ends to send the Slack “still working?” nudge — e.g. 20 means 20 min past an 8h shift. Blank = right at shift end." error={form.errors.clockout_reminder_minutes}>
                            <input
                                type="number"
                                min={0}
                                max={240}
                                step={5}
                                value={form.data.clockout_reminder_minutes}
                                onChange={(event) => form.setData('clockout_reminder_minutes', event.target.value)}
                                placeholder="e.g. 20"
                                className="w-full rounded-lg border-slate-700 bg-slate-900 text-sm text-slate-200 placeholder-slate-500 focus:border-orange-500 focus:ring-orange-500"
                            />
                        </Field>
                    </div>
                </div>
            </section>

            {canManageAccess && (
                <>
                    <section className="rounded-lg border border-slate-800 bg-slate-900 shadow-sm">
                        <div className="border-b border-slate-800 px-5 py-4">
                            <h2 className="font-bold text-white">Role</h2>
                            <p className="mt-1 text-sm text-slate-400">Roles describe responsibility; permissions control exact access.</p>
                        </div>
                        <div className="grid gap-3 p-5 md:grid-cols-3">
                            {Object.entries(roles).map(([key, role]) => {
                                const Icon = roleIcons[key] || UserRound;
                                const selected = form.data.role === key;
                                return (
                                    <button
                                        key={key}
                                        type="button"
                                        onClick={() => selectRole(key)}
                                        className={`flex min-h-28 items-start gap-3 rounded-lg border p-4 text-left transition ${
                                            selected
                                                ? 'border-orange-500 bg-orange-500/10 ring-1 ring-orange-500'
                                                : 'border-slate-800 bg-slate-900 hover:border-slate-600'
                                        }`}
                                    >
                                        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${selected ? 'bg-orange-500 text-white' : 'bg-slate-700 text-slate-300'}`}>
                                            <Icon className="h-5 w-5" />
                                        </span>
                                        <span>
                                            <span className="flex items-center gap-2 font-bold text-slate-100">
                                                {role.label}
                                                {selected && <Check className="h-4 w-4 text-orange-400" />}
                                            </span>
                                            <span className="mt-1 block text-sm leading-5 text-slate-400">{role.description}</span>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </section>

                    <section className="rounded-lg border border-slate-800 bg-slate-900 shadow-sm">
                        <div className="border-b border-slate-800 px-5 py-4">
                            <h2 className="font-bold text-white">Selected access</h2>
                            <p className="mt-1 text-sm text-slate-400">
                                {fullAccess
                                    ? `${form.data.role === 'owner' ? 'Owner' : 'Super Admin'} already has every permission.`
                                    : 'Choose only the areas this account needs.'}
                            </p>
                        </div>
                        <div className="divide-y divide-slate-800">
                            {Object.entries(permissionGroups).map(([group, permissions]) => (
                                <div key={group} className="grid gap-3 px-5 py-4 md:grid-cols-[160px_1fr]">
                                    <h3 className="text-sm font-bold text-slate-100">{group}</h3>
                                    <div className="grid gap-2 xl:grid-cols-2">
                                        {Object.entries(permissions).map(([permission, def]) => {
                                            // Catalog entries are {label, description}; tolerate
                                            // the old plain-string shape too.
                                            const label = typeof def === 'string' ? def : def.label;
                                            const description = typeof def === 'string' ? null : def.description;
                                            return (
                                                <label
                                                    key={permission}
                                                    className={`flex items-start gap-3 rounded-lg px-3 py-2 ${
                                                        fullAccess
                                                            ? 'cursor-not-allowed bg-slate-800'
                                                            : 'cursor-pointer hover:bg-slate-800'
                                                    }`}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={fullAccess || form.data.permissions.includes(permission)}
                                                        disabled={fullAccess}
                                                        onChange={() => togglePermission(permission)}
                                                        className="mt-0.5 rounded border-slate-700 bg-slate-900 text-orange-500 focus:ring-orange-500"
                                                    />
                                                    <span className="min-w-0">
                                                        <span className="block text-sm font-semibold text-slate-200">{label}</span>
                                                        {description && (
                                                            <span className="mt-0.5 block text-xs leading-5 text-slate-400">{description}</span>
                                                        )}
                                                    </span>
                                                </label>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                        {form.errors.permissions && <p className="px-5 pb-4 text-sm font-medium text-rose-400">{form.errors.permissions}</p>}
                    </section>

                    <section className="rounded-lg border border-slate-800 bg-slate-900 shadow-sm">
                        <div className="border-b border-slate-800 px-5 py-4">
                            <h2 className="font-bold text-white">Slack reporting</h2>
                            <p className="mt-1 text-sm text-slate-400">Control whether this person is included in routine hours reports.</p>
                        </div>
                        <label className="flex cursor-pointer items-start gap-3 p-5">
                            <input
                                type="checkbox"
                                checked={form.data.include_in_slack_reports}
                                onChange={(event) => form.setData('include_in_slack_reports', event.target.checked)}
                                className="mt-0.5 rounded border-slate-700 bg-slate-900 text-orange-500 focus:ring-orange-500"
                            />
                            <span>
                                <span className="block text-sm font-semibold text-slate-100">Include in Slack reports by default</span>
                                <span className="mt-1 block text-sm leading-5 text-slate-400">
                                    Enabled users are preselected in manual reports and included in automatic Sunday reports.
                                </span>
                            </span>
                        </label>
                        {form.errors.include_in_slack_reports && (
                            <p className="px-5 pb-4 text-sm font-medium text-rose-400">{form.errors.include_in_slack_reports}</p>
                        )}

                        <label className="flex cursor-pointer items-start gap-3 border-t border-slate-800 p-5">
                            <input
                                type="checkbox"
                                checked={form.data.tracks_time}
                                onChange={(event) => form.setData('tracks_time', event.target.checked)}
                                className="mt-0.5 rounded border-slate-700 bg-slate-900 text-orange-500 focus:ring-orange-500"
                            />
                            <span>
                                <span className="block text-sm font-semibold text-slate-100">Tracks time (include in performance)</span>
                                <span className="mt-1 block text-sm leading-5 text-slate-400">
                                    On for staff who track work. Turn <b>off</b> for non-tracking roles (HR, finance) so they don&apos;t show as “0% this week” in Team Performance, the dashboard team view, and digests.
                                </span>
                            </span>
                        </label>
                        {form.errors.tracks_time && (
                            <p className="px-5 pb-4 text-sm font-medium text-rose-400">{form.errors.tracks_time}</p>
                        )}

                        <label className="flex cursor-pointer items-start gap-3 border-t border-slate-800 p-5">
                            <input
                                type="checkbox"
                                checked={form.data.is_active}
                                onChange={(event) => form.setData('is_active', event.target.checked)}
                                className="mt-0.5 rounded border-slate-700 bg-slate-900 text-orange-500 focus:ring-orange-500"
                            />
                            <span>
                                <span className="block text-sm font-semibold text-slate-100">Account active</span>
                                <span className="mt-1 block text-sm leading-5 text-slate-400">
                                    On for current staff. Turn <b>off</b> to deactivate someone who left — they can no longer sign in to the web app or desktop tracker (existing tokens are revoked) and drop out of active directory, assignment, and performance views. Their history is kept; reactivate anytime.
                                </span>
                            </span>
                        </label>
                        {form.errors.is_active && (
                            <p className="px-5 pb-4 text-sm font-medium text-rose-400">{form.errors.is_active}</p>
                        )}
                    </section>

                    <section className="rounded-lg border border-slate-800 bg-slate-900 shadow-sm">
                        <div className="border-b border-slate-800 px-5 py-4">
                            <h2 className="font-bold text-white">Devices</h2>
                            <p className="mt-1 text-sm text-slate-400">By default a person can track on only one device at a time — starting on a second device stops the first, so time is never double-counted.</p>
                        </div>
                        <label className="flex cursor-pointer items-start gap-3 p-5">
                            <input
                                type="checkbox"
                                checked={form.data.allow_multiple_devices}
                                onChange={(event) => form.setData('allow_multiple_devices', event.target.checked)}
                                className="mt-0.5 rounded border-slate-700 bg-slate-900 text-orange-500 focus:ring-orange-500"
                            />
                            <span>
                                <span className="block text-sm font-semibold text-slate-100">Allow tracking on multiple devices at once</span>
                                <span className="mt-1 block text-sm leading-5 text-slate-400">
                                    Only enable for someone who genuinely needs two machines tracking simultaneously. Overlapping time is kept and clearly marked as double-tracked.
                                </span>
                            </span>
                        </label>
                    </section>
                </>
            )}

            <div className="flex flex-col-reverse gap-3 border-t border-slate-800 pt-5 sm:flex-row sm:justify-end">
                <Link
                    href={route('users.index')}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-slate-200 hover:bg-slate-800"
                >
                    <ArrowLeft className="h-4 w-4" />
                    Cancel
                </Link>
                <button
                    type="submit"
                    disabled={form.processing}
                    className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {form.processing ? 'Saving...' : editing ? 'Save changes' : 'Create user'}
                </button>
            </div>
        </form>
    );
}

function Field({ label, hint = null, error = null, children }) {
    return (
        <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-slate-300">{label}</span>
            {children}
            {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
            {error && <span className="mt-1 block text-xs font-medium text-rose-400">{error}</span>}
        </label>
    );
}
