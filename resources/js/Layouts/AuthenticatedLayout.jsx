import { useMemo, useState } from 'react';
import { Link, usePage } from '@inertiajs/react';
import {
    Activity,
    BarChart3,
    Briefcase,
    CalendarClock,
    CalendarDays,
    ChevronDown,
    Clock,
    Film,
    HelpCircle,
    Inbox,
    LayoutDashboard,
    LayoutGrid,
    LogOut,
    Menu,
    PieChart,
    MonitorDown,
    Plus,
    Settings as SettingsIcon,
    Sparkles,
    UserCircle,
    Users,
    Wrench,
    X,
} from 'lucide-react';
import AiChatWidget from '@/Components/AiChatWidget';
import ApplicationLogo from '@/Components/ApplicationLogo';
import Avatar from '@/Components/Avatar';
import Dropdown from '@/Components/Dropdown';

function isActiveRoute(names) {
    return names.some((name) => route().current(name));
}

function NavItem({ item, onClick }) {
    const Icon = item.icon;
    const active = isActiveRoute(item.active);

    return (
        <Link
            href={item.href}
            onClick={onClick}
            prefetch
            cacheFor="20s"
            className={[
                'inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-2 text-sm font-medium transition xl:px-3',
                active
                    ? 'bg-gradient-to-r from-orange-500 to-amber-500 text-white shadow-lg shadow-orange-500/25'
                    : 'text-slate-300 hover:bg-white/10 hover:text-white',
            ].join(' ')}
        >
            <Icon className="h-4 w-4" />
            <span>{item.label}</span>
            {item.badge > 0 && (
                <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                    {item.badge}
                </span>
            )}
        </Link>
    );
}

// A top-bar grouping: a trigger button that opens a dropdown of related links.
function NavGroup({ label, icon: Icon, items }) {
    const active = items.some((item) => isActiveRoute(item.active));

    return (
        <Dropdown>
            <Dropdown.Trigger>
                <button
                    type="button"
                    className={[
                        'inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-2 text-sm font-medium transition xl:px-3',
                        active ? 'bg-gradient-to-r from-orange-500 to-amber-500 text-white shadow-lg shadow-orange-500/25' : 'text-slate-300 hover:bg-white/10 hover:text-white',
                    ].join(' ')}
                >
                    <Icon className="h-4 w-4" />
                    <span>{label}</span>
                    <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                </button>
            </Dropdown.Trigger>
            <Dropdown.Content align="left" width="56">
                {items.map((item) => {
                    const ItemIcon = item.icon;
                    const isActive = isActiveRoute(item.active);
                    return (
                        <Dropdown.Link
                            key={item.label}
                            href={item.href}
                            prefetch
                            cacheFor="20s"
                            className={isActive ? 'bg-slate-800 font-semibold text-slate-100' : ''}
                        >
                            <span className="flex items-center gap-2">
                                <ItemIcon className="h-4 w-4 text-slate-400" />
                                {item.label}
                            </span>
                        </Dropdown.Link>
                    );
                })}
            </Dropdown.Content>
        </Dropdown>
    );
}

export default function Authenticated({ user, header, children }) {
    const [showingNavigationDropdown, setShowingNavigationDropdown] = useState(false);
    const can = (permission) => user?.is_super_admin || user?.permissions?.includes(permission);
    const canCreateManualWorkHour = user?.can_create_manual_work_hour ?? true;
    const feedback = usePage().props.feedback || { can_manage: false, open_count: 0, unseen_count: 0 };

    // Nav is grouped into a few readable buckets so it scales from a phone to a
    // wide monitor: Dashboard sits on its own, then Real-time (your work day),
    // Performance (reporting), Admin (people/clients/system), and Help + Requests
    // stay one tap away for everyone. Account actions live in the avatar menu.
    const primaryItems = useMemo(() => [
        { label: 'Dashboard', href: route('dashboard'), icon: LayoutDashboard, active: ['dashboard'] },
    ].filter(Boolean), [user?.is_super_admin, user?.permissions]);

    // Real-time — the operational, day-to-day pages.
    const realtimeItems = useMemo(() => [
        { label: 'Timeline', href: route('timeline.index'), icon: Film, active: ['timeline.index'] },
        can('attendance.view') && { label: 'Attendance', href: route('employee-attendance.index'), icon: CalendarDays, active: ['employee-attendance.index'] },
        { label: 'Work Diary', href: route('work-hours.index'), icon: Clock, active: ['work-hours.index', 'work-hours.create', 'work-hours.edit'] },
        (can('shift.edit_own') || can('shift.manage_all')) && { label: 'My Schedule', href: route('shift-overrides.index'), icon: CalendarClock, active: ['shift-overrides.index'] },
    ].filter(Boolean), [user?.is_super_admin, user?.permissions]);

    // Performance — reporting & analytics.
    const performanceItems = useMemo(() => [
        can('reports.view') && { label: 'Summary', href: route('summary.index'), icon: PieChart, active: ['summary.index'] },
        can('reports.view') && { label: 'Reports', href: route('work-hours.report'), icon: BarChart3, active: ['work-hours.report'] },
        can('timeline.view_others') && { label: 'Team Performance', href: route('team.index'), icon: Activity, active: ['team.index'] },
    ].filter(Boolean), [user?.is_super_admin, user?.permissions]);

    // Admin — people, clients, and system configuration (was Management + System).
    const adminItems = useMemo(() => [
        can('users.view') && { label: 'Users', href: route('users.index'), icon: Users, active: ['users.index', 'users.create', 'users.edit'] },
        can('clients.view') && { label: 'Clients', href: route('clients.index'), icon: Briefcase, active: ['clients.index'] },
        can('profiles.view') && { label: 'Profiles', href: route('upwork-profiles.index'), icon: UserCircle, active: ['upwork-profiles.index', 'upwork-profiles.create', 'upwork-profiles.edit'] },
        can('monitoring.settings') && { label: 'Compliance', href: route('monitoring.compliance'), icon: Activity, active: ['monitoring.compliance'] },
        can('monitoring.settings') && { label: 'Settings', href: route('settings.index'), icon: SettingsIcon, active: ['settings.index'] },
        user?.is_super_admin && { label: 'Developer', href: route('developer.index'), icon: Wrench, active: ['developer.index'] },
    ].filter(Boolean), [user?.is_super_admin, user?.permissions]);

    // Help + Requests — for everyone, always reachable.
    const supportItems = useMemo(() => [
        { label: 'Help', href: route('help'), icon: HelpCircle, active: ['help'] },
        {
            label: feedback.can_manage ? 'Inbox' : 'Requests',
            href: route('feedback.index'),
            icon: Inbox,
            active: ['feedback.index'],
            badge: feedback.can_manage ? feedback.open_count : feedback.unseen_count,
        },
    ].filter(Boolean), [feedback.can_manage, feedback.open_count, feedback.unseen_count]);

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100">
            <nav className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/95 shadow-lg shadow-slate-950/30 backdrop-blur">
                <div className="w-full px-4 sm:px-6 lg:px-8">
                    <div className="flex h-16 items-center justify-between gap-4">
                        <div className="flex min-w-0 items-center gap-3 xl:gap-5">
                            <Link href={route('dashboard')} className="flex shrink-0 items-center gap-3">
                                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-900 shadow-md shadow-orange-500/20 ring-1 ring-orange-500/40">
                                    <ApplicationLogo size="9" />
                                </span>
                                <span className="hidden leading-tight 2xl:block">
                                    <span className="block text-base font-bold text-white">SA Track</span>
                                    <span className="block text-xs font-medium text-slate-400">by Sparking Asia</span>
                                </span>
                            </Link>

                            <div className="hidden items-center gap-1 lg:flex">
                                {primaryItems.map((item) => (
                                    <NavItem key={item.label} item={item} />
                                ))}
                                {realtimeItems.length > 0 && <NavGroup label="Real-time" icon={Activity} items={realtimeItems} />}
                                {performanceItems.length > 0 && <NavGroup label="Performance" icon={BarChart3} items={performanceItems} />}
                                {adminItems.length > 0 && <NavGroup label="Admin" icon={LayoutGrid} items={adminItems} />}
                                {supportItems.map((item) => (
                                    <NavItem key={item.label} item={item} />
                                ))}
                            </div>
                        </div>

                        <div className="hidden shrink-0 items-center gap-3 sm:flex">
                            {canCreateManualWorkHour && (
                                <Link
                                    href={route('work-hours.create')}
                                    className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-3.5 py-2 text-sm font-semibold text-white shadow-lg shadow-orange-500/25 transition hover:from-orange-600 hover:to-amber-600 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 focus:ring-offset-slate-950"
                                >
                                    <Plus className="h-4 w-4" />
                                    <span className="hidden md:inline">Add Manual Time</span>
                                </Link>
                            )}

                            <Dropdown>
                                <Dropdown.Trigger>
                                    <button className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 focus:ring-offset-slate-950">
                                        <Avatar user={user} size="sm" />
                                        <span className="hidden max-w-40 truncate xl:block">{user?.name}</span>
                                        <ChevronDown className="h-4 w-4 text-slate-400" />
                                    </button>
                                </Dropdown.Trigger>
                                <Dropdown.Content>
                                    <Dropdown.Link href={route('profile.edit')}>
                                        <span className="flex items-center gap-2">
                                            <UserCircle className="h-4 w-4" />
                                            Profile
                                        </span>
                                    </Dropdown.Link>
                                    <Dropdown.Link href={route('desktop-downloads.index')}>
                                        <span className="flex items-center gap-2">
                                            <MonitorDown className="h-4 w-4" />
                                            Desktop App
                                        </span>
                                    </Dropdown.Link>
                                    <Dropdown.Link href={route('help')}>
                                        <span className="flex items-center gap-2">
                                            <HelpCircle className="h-4 w-4" />
                                            How to use
                                        </span>
                                    </Dropdown.Link>
                                    <Dropdown.Link href={route('logout')} method="post" as="button">
                                        <span className="flex items-center gap-2">
                                            <LogOut className="h-4 w-4" />
                                            Log Out
                                        </span>
                                    </Dropdown.Link>
                                </Dropdown.Content>
                            </Dropdown>
                        </div>

                        <button
                            onClick={() => setShowingNavigationDropdown((previousState) => !previousState)}
                            className="inline-flex items-center justify-center rounded-lg p-2 text-slate-300 transition hover:bg-white/10 hover:text-white lg:hidden"
                            aria-label="Toggle navigation"
                        >
                            {showingNavigationDropdown ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
                        </button>
                    </div>
                </div>

                {showingNavigationDropdown && (
                    <div className="border-t border-slate-800 bg-slate-950 lg:hidden">
                        <div className="space-y-1 px-4 py-3">
                            {primaryItems.map((item) => (
                                <NavItem key={item.label} item={item} onClick={() => setShowingNavigationDropdown(false)} />
                            ))}

                            {[
                                ['Real-time', realtimeItems],
                                ['Performance', performanceItems],
                                ['Admin', adminItems],
                            ].map(([label, items]) => items.length > 0 && (
                                <div key={label} className="pt-3">
                                    <div className="px-2.5 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</div>
                                    {items.map((item) => (
                                        <NavItem key={item.label} item={item} onClick={() => setShowingNavigationDropdown(false)} />
                                    ))}
                                </div>
                            ))}

                            <div className="pt-3">
                                <div className="px-2.5 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Support</div>
                                {supportItems.map((item) => (
                                    <NavItem key={item.label} item={item} onClick={() => setShowingNavigationDropdown(false)} />
                                ))}
                            </div>

                            {canCreateManualWorkHour && (
                                <Link
                                    href={route('work-hours.create')}
                                    onClick={() => setShowingNavigationDropdown(false)}
                                    className="mt-3 flex items-center gap-2 rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-3 py-2 text-sm font-semibold text-white shadow-lg shadow-orange-500/25"
                                >
                                    <Plus className="h-4 w-4" />
                                    Add Manual Time
                                </Link>
                            )}
                        </div>

                        <div className="border-t border-slate-800 px-4 py-4">
                            <div className="mb-3 flex items-center gap-3">
                                <Avatar user={user} size="lg" />
                                <div className="min-w-0">
                                    <div className="truncate font-semibold text-white">{user?.name ?? ''}</div>
                                    <div className="truncate text-sm text-slate-400">{user?.email ?? ''}</div>
                                </div>
                            </div>
                            <div className="grid gap-2">
                                <Link
                                    href={route('profile.edit')}
                                    className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-300 hover:bg-white/10 hover:text-white"
                                >
                                    <UserCircle className="h-4 w-4" />
                                    Profile Settings
                                </Link>
                                <Link
                                    href={route('desktop-downloads.index')}
                                    onClick={() => setShowingNavigationDropdown(false)}
                                    className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-300 hover:bg-white/10 hover:text-white"
                                >
                                    <MonitorDown className="h-4 w-4" />
                                    Desktop App
                                </Link>
                                <Link
                                    href={route('help')}
                                    onClick={() => setShowingNavigationDropdown(false)}
                                    className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-300 hover:bg-white/10 hover:text-white"
                                >
                                    <HelpCircle className="h-4 w-4" />
                                    How to use
                                </Link>
                                <Link
                                    href={route('logout')}
                                    method="post"
                                    as="button"
                                    className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-300 hover:bg-white/10 hover:text-white"
                                >
                                    <LogOut className="h-4 w-4" />
                                    Log Out
                                </Link>
                            </div>
                        </div>
                    </div>
                )}
            </nav>

            {header && (
                <header className="relative overflow-hidden border-b border-slate-800 bg-gradient-to-r from-slate-950 via-slate-900 to-slate-950">
                    <div
                        className="pointer-events-none absolute -top-16 right-0 h-40 w-96 rounded-full bg-orange-500/10 blur-3xl"
                        aria-hidden="true"
                    />
                    <div className="relative w-full px-4 py-4 sm:px-6 lg:px-8">
                        <h1 className="flex items-center gap-3 text-xl font-semibold text-white">
                            <span className="h-5 w-1 rounded-full bg-gradient-to-b from-orange-400 to-amber-500" aria-hidden="true" />
                            {typeof header === 'string' ? header : (header?.props?.children || 'Page')}
                        </h1>
                    </div>
                </header>
            )}

            <main>{children}</main>

            {/* Floating AI chat — only for people granted the AI permission
                (each question costs API credit). */}
            {can('ai.assistant') && <AiChatWidget />}
        </div>
    );
}
