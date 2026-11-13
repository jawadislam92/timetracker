<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\CalculatesTimeStats;
use App\Models\MonitoringSetting;
use App\Models\TimeEntry;
use App\Models\TrackingSession;
use App\Models\User;
use App\Models\WorkHour;
use App\Services\ShiftBoardService;
use App\Services\TrackingSessionService;
use App\Support\AttendanceHours;
use App\Support\BusinessTime;
use App\Support\TimeClockRules;
use Carbon\Carbon;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Auth;

class TimeEntryController extends Controller
{
    use CalculatesTimeStats;

    public function index(Request $request)
    {
        $user = Auth::user();
        $query = TimeEntry::forUser($user->id)->with('user');

        // Filter by date if provided
        if ($request->has('date')) {
            $query->forDate($request->date);
        }

        $entries = $query->recent(100)->get();

        return response()->json([
            'entries' => $entries->map(function ($entry) {
                return [
                    'id' => $entry->id,
                    'action_type' => $entry->action_type,
                    'action_timestamp' => $entry->action_timestamp->toISOString(),
                    'formatted_date' => $entry->formatted_action_date,
                    'formatted_time' => $entry->formatted_action_time,
                    'notes' => $entry->notes,
                    'user_name' => $entry->user->name,
                ];
            }),
        ]);
    }

    public function store(Request $request)
    {
        $validated = $request->validate([
            'action_type' => 'required|in:clock_in,clock_out,break_start,break_end',
            'notes' => 'nullable|string|max:255',
        ]);

        $user = Auth::user();
        if ($user->isOwner()) {
            return response()->json(['message' => 'Owner accounts are not tracked, so there is nothing to clock.'], 422);
        }
        // action_timestamp + action_time are stored in the app timezone so the
        // canonical instant round-trips; the worker's own attendance day is
        // resolved by attendanceDateFor() (which converts to their work tz).
        $now = Carbon::now('Asia/Karachi');
        $actionType = $validated['action_type'];
        $attendanceDate = $user->attendanceDateFor($now);
        // Enforce the sequence against the GLOBAL current clock state, not just
        // today's — otherwise a clock-in left open past midnight looks "closed"
        // to today's empty list and a duplicate clock-in slips through (the
        // reported bug: clocked in 7:26 PM, then a second clock-in at 12:40 AM).
        $lastAction = TimeEntry::currentClockState($user->id);

        if (! $this->isActionAllowed($lastAction, $actionType)) {
            return response()->json([
                'message' => $this->blockedActionMessage($lastAction, $actionType),
            ], 422);
        }

        $entry = TimeEntry::create([
            'user_id' => $user->id,
            'action_type' => $actionType,
            'action_timestamp' => $now,
            'action_date' => $attendanceDate,
            'action_time' => $now->toTimeString(),
            'notes' => $validated['notes'] ?? null,
        ]);

        return response()->json([
            'entry' => [
                'id' => $entry->id,
                'action_type' => $entry->action_type,
                'action_timestamp' => $entry->action_timestamp->toISOString(),
                'formatted_date' => $entry->formatted_action_date,
                'formatted_time' => $entry->formatted_action_time,
                'notes' => $entry->notes,
                'user_name' => $user->name,
            ],
            'message' => 'Time entry recorded successfully',
        ]);
    }

    private function isActionAllowed(?string $lastAction, string $nextAction): bool
    {
        return TimeClockRules::isAllowed($lastAction, $nextAction);
    }

    private function blockedActionMessage(?string $lastAction, string $nextAction): string
    {
        return TimeClockRules::blockedMessage($lastAction, $nextAction);
    }

    public function export(Request $request)
    {
        $user = Auth::user();
        $query = TimeEntry::forUser($user->id)->with('user');

        // Filter by date range if provided
        if ($request->has('start_date')) {
            $query->whereDate('action_date', '>=', $request->start_date);
        }
        if ($request->has('end_date')) {
            $query->whereDate('action_date', '<=', $request->end_date);
        }

        $entries = $query->orderBy('action_timestamp', 'desc')->get();

        $csv = "Date,Time,Employee,Action,Notes\n";
        foreach ($entries as $entry) {
            $csv .= implode(',', [
                $entry->formatted_action_date,
                $entry->formatted_action_time,
                $entry->user->name,
                str_replace('_', ' ', ucwords($entry->action_type)),
                '"'.($entry->notes ?? '').'"',
            ])."\n";
        }

        return response($csv)
            ->header('Content-Type', 'text/csv')
            ->header('Content-Disposition', 'attachment; filename="time-entries-'.now()->format('Y-m-d').'.csv"');
    }

    public function getTodaysEntries()
    {
        $user = Auth::user();
        $today = $user->attendanceDateFor(Carbon::now('Asia/Karachi'));

        $entries = TimeEntry::forUser($user->id)
            ->forDate($today)
            ->orderBy('action_timestamp', 'desc')
            ->get();

        // Day-boundary carry-over: if the worker is still inside an open session
        // that began on an EARLIER attendance day (clocked in last night, no
        // clock-out yet), pull that session's earlier rows into "today" so the
        // dashboard's clock state reads "Working" instead of flipping to
        // "Not Started" after midnight. Mirrors the global-aware state shared in
        // HandleInertiaRequests::share(); without it this day-scoped fetch wipes
        // the open clock-in the moment loadDashboard() runs (the half-second
        // flicker: correct on first paint, then "Not Started").
        $last = TimeEntry::forUser($user->id)
            ->orderByDesc('action_timestamp')->orderByDesc('id')
            ->first();

        if ($last && in_array($last->action_type, ['clock_in', 'break_start', 'break_end'], true)) {
            $openClockIn = TimeEntry::forUser($user->id)
                ->where('action_type', 'clock_in')
                ->orderByDesc('action_timestamp')->orderByDesc('id')
                ->first();

            if ($openClockIn && $openClockIn->action_date->toDateString() !== (string) $today) {
                $carryover = TimeEntry::forUser($user->id)
                    ->where('action_timestamp', '>=', $openClockIn->action_timestamp)
                    ->whereDate('action_date', '<', $today)
                    ->orderBy('action_timestamp', 'desc')
                    ->get();

                $entries = $entries->concat($carryover)
                    ->sortByDesc('action_timestamp')
                    ->values();
            }
        }

        return response()->json([
            'entries' => $entries->map(function ($entry) {
                return [
                    'id' => $entry->id,
                    'action_type' => $entry->action_type,
                    'action_timestamp' => $entry->action_timestamp->toISOString(),
                    'formatted_date' => $entry->formatted_action_date,
                    'formatted_time' => $entry->formatted_action_time,
                    'notes' => $entry->notes,
                    'user_name' => $entry->user->name,
                ];
            }),
        ]);
    }

    public function getTodaysSummary()
    {
        $user = Auth::user();
        // NOTE (per-worker timezone): the team summary buckets "today"/week/month
        // for every employee against one Asia/Karachi window. This is exact for
        // local staff; for a remote worker (non-Karachi work_timezone) their
        // dashboard summary day can be off near their midnight. It is a live
        // aggregation surface only (no stored data, no auto-close impact). When a
        // remote worker is piloted, derive the day per-employee via
        // $employee->attendanceDateFor(now()) and their week/month in
        // $employee->workTimezone() across the batch loaders below.
        $now = Carbon::now('Asia/Karachi');
        $weekStart = Carbon::now('Asia/Karachi')->startOfWeek(MonitoringSetting::weekStartDay());
        $monthStart = Carbon::now('Asia/Karachi')->startOfMonth();

        if ($user->hasAnyPermission(['dashboard.view_team', 'attendance.view'])) {
            // Eager-load shift overrides so the needs-attention pass can call
            // effectiveShiftFor() per employee without an N+1 (one extra query
            // for the whole team instead of one per person). Non-tracking staff
            // (HR etc.) are excluded so they don't dilute the KPIs at 0%.
            $employeesQuery = User::active()->staff()->tracksTime()->with(array_merge(User::shiftEagerLoads(), ['shift:id,name,sort_order']));
            \App\Support\ShiftFilter::apply($employeesQuery, request());
            $employees = $employeesQuery->get();
            $ids = $employees->pluck('id')->all();
            $entriesByUser = $this->loadSummaryEntries($ids, $now, $weekStart, $monthStart);
            $trackedByUserDate = $this->loadTrackedStats($ids, $now, $weekStart, $monthStart);
            $liveByUser = $this->loadLiveSessions($ids);
            $activityByUser = $this->loadDayActivity($ids, $now);

            // Build every row first (the KPI strip + status mix count the whole
            // team, including people who are clocked out or not started), then
            // filter the live table to those who actually have activity today.
            $allRows = $employees->map(fn ($employee) => $this->summaryStatsFor($employee, $entriesByUser->get($employee->id, collect()), $now, $weekStart, $monthStart, $trackedByUserDate, $liveByUser, $activityByUser));

            $employeesData = $allRows->filter(function ($employee) {
                // Tracked-only table: show anyone tracking now or with tracked
                // time today/yesterday (a night shift's evening lands on
                // yesterday). Someone who clocked in but never ran the tracker
                // has no row here — they're surfaced in Needs Attention instead,
                // so they don't appear as an all-zero "ghost" row.
                return $employee['is_live']
                    || $employee['tracked_hours'] > 0
                    || $employee['tracked_yesterday_hours'] > 0;
            });

            [$kpis, $attention] = $this->teamOverview($employees->keyBy('id'), $allRows, $entriesByUser, $now);

            $canClockOthers = (bool) $user->hasPermission('attendance.edit_times');
            $shiftBoard = app(ShiftBoardService::class)->build(
                $employees,
                $entriesByUser,
                $allRows->keyBy('user_id'),
                $now,
                $canClockOthers,
            );

            return response()->json([
                'employees' => $employeesData->values(),
                'team_kpis' => $kpis,
                'needs_attention' => $attention,
                'shift_board' => $shiftBoard,
                'can_clock_out_others' => $canClockOthers,
            ]);
        } else {
            // Regular users see only their own data
            $entriesByUser = $this->loadSummaryEntries([$user->id], $now, $weekStart, $monthStart);
            $trackedByUserDate = $this->loadTrackedStats([$user->id], $now, $weekStart, $monthStart);
            $liveByUser = $this->loadLiveSessions([$user->id]);
            $activityByUser = $this->loadDayActivity([$user->id], $now);

            return response()->json([
                'employees' => [$this->summaryStatsFor($user, $entriesByUser->get($user->id, collect()), $now, $weekStart, $monthStart, $trackedByUserDate, $liveByUser, $activityByUser)],
            ]);
        }
    }

    /**
     * Ranged team-activity table for the dashboard's "Team Activity" panel, so a
     * manager can flip the same list to Yesterday / This week / a custom range
     * without leaving the dashboard. Per-member tracked + in-office + activity
     * over the window, computed with the SAME inDaySeconds + dayInOfficeHours the
     * Team Performance page and the live table use — so the numbers always agree.
     * (The default "today" view keeps using today-summary's richer live columns;
     * this powers the historical ranges, which have no "current status".)
     */
    public function teamActivity(Request $request)
    {
        $user = Auth::user();
        abort_unless($user->hasAnyPermission(['dashboard.view_team', 'attendance.view']), 403);

        [$rangeStart, $rangeEnd] = $this->resolveActivityRange($request);
        [$dayStart, $dayEnd] = BusinessTime::utcRange($rangeStart, $rangeEnd);
        $svc = app(TrackingSessionService::class);

        $usersQuery = User::active()->staff()->tracksTime()->with('shift:id,name')->orderBy('name');
        \App\Support\ShiftFilter::apply($usersQuery, $request);
        $users = $usersQuery->get(['id', 'name', 'designation', 'avatar', 'shift_id']);
        $ids = $users->pluck('id');

        // Sessions overlapping the range (each clamped to its in-range share),
        // grouped per user.
        $sessionsByUser = TrackingSession::query()
            ->whereIn('user_id', $ids)
            ->where('started_at', '<', $dayEnd)
            ->where(fn ($q) => $q->whereNull('stopped_at')->orWhere('stopped_at', '>', $dayStart))
            ->where(fn ($q) => $q->where('total_seconds', '>=', 60)->orWhere('status', TrackingSession::STATUS_ACTIVE))
            ->get(['id', 'user_id', 'started_at', 'stopped_at', 'total_seconds', 'activity_percent', 'status'])
            ->groupBy('user_id');

        // Clock entries in the range, grouped per user → per attendance day, so
        // in-office hours sum each day's clock-in/out window across the range.
        $entriesByUser = TimeEntry::query()
            ->whereIn('user_id', $ids)
            ->whereBetween('action_timestamp', [$dayStart, $dayEnd])
            ->orderBy('action_timestamp')->orderBy('id')
            ->get()
            ->groupBy('user_id');

        // Manual (non-tracker) work-diary hours dilute activity at 0%, exactly
        // like the Team table.
        $manualByUser = WorkHour::query()
            ->whereIn('user_id', $ids)
            ->whereBetween('date', [$rangeStart->toDateString(), $rangeEnd->toDateString()])
            ->where(fn ($q) => $q->whereNull('source')->orWhere('source', '!=', 'tracker'))
            ->get(['user_id', 'hours'])
            ->groupBy('user_id');

        $liveIds = TrackingSession::active()->pluck('user_id')->flip();

        $rows = $users->map(function (User $u) use ($sessionsByUser, $entriesByUser, $manualByUser, $liveIds, $svc, $dayStart, $dayEnd) {
            $sessions = $sessionsByUser->get($u->id, collect());
            $trackedSeconds = (int) $sessions->sum(fn ($s) => $svc->inDaySeconds($s, $dayStart, $dayEnd));
            $weighted = $sessions->sum(fn ($s) => (int) $s->activity_percent * $svc->inDaySeconds($s, $dayStart, $dayEnd));
            $manualSeconds = (int) round((float) $manualByUser->get($u->id, collect())->sum('hours') * 3600);
            $totalSeconds = $trackedSeconds + $manualSeconds;
            $trackedActivity = $trackedSeconds > 0 ? $weighted / $trackedSeconds : 0;
            $activity = $totalSeconds > 0 ? (int) round($trackedActivity * ($trackedSeconds / $totalSeconds)) : 0;

            $byDay = $entriesByUser->get($u->id, collect())
                ->groupBy(fn ($e) => $e->action_date instanceof Carbon ? $e->action_date->toDateString() : substr((string) $e->action_date, 0, 10));
            $inOfficeSeconds = (int) round($byDay->sum(fn ($dayEntries) => AttendanceHours::dayInOfficeHours($dayEntries)) * 3600);

            return [
                'user_id' => $u->id,
                'user_name' => $u->name,
                'designation' => $u->designation ?? 'Employee',
                'shift_name' => $u->shift_name,
                'avatar' => $u->avatar_url ?? null,
                'tracked_seconds' => $trackedSeconds + $manualSeconds,
                'in_office_seconds' => $inOfficeSeconds,
                'activity_percent' => $activity,
                'days_worked' => $byDay->filter(fn ($d) => $d->isNotEmpty())->count(),
                'is_live' => $liveIds->has($u->id),
            ];
        })
            ->filter(fn ($r) => $r['tracked_seconds'] > 0 || $r['in_office_seconds'] > 0 || $r['is_live'])
            ->sortBy([['is_live', 'desc'], ['tracked_seconds', 'desc'], ['user_name', 'asc']])
            ->values();

        return response()->json([
            'range' => $request->input('range', 'today'),
            'start' => $rangeStart->toDateString(),
            'end' => $rangeEnd->toDateString(),
            'employees' => $rows,
        ]);
    }

    /**
     * Resolve the dashboard team-activity range: a custom start+end, else a
     * named preset. Mirrors TeamController::resolveRange so the dashboard panel
     * and the Team Performance page bucket dates identically.
     *
     * @return array{0: Carbon, 1: Carbon}
     */
    private function resolveActivityRange(Request $request): array
    {
        $tz = BusinessTime::tz();

        if ($request->filled('start') && $request->filled('end')) {
            try {
                return [
                    Carbon::parse($request->input('start'), $tz)->startOfDay(),
                    Carbon::parse($request->input('end'), $tz)->endOfDay(),
                ];
            } catch (\Throwable $e) {
                // fall through to named ranges
            }
        }

        $today = BusinessTime::today();

        return match ($request->input('range', 'today')) {
            'yesterday' => [$today->copy()->subDay(), $today->copy()->subDay()->endOfDay()],
            'week' => [$today->copy()->startOfWeek(MonitoringSetting::weekStartDay()), $today->copy()->endOfDay()],
            'month' => [$today->copy()->startOfMonth(), $today->copy()->endOfDay()],
            default => [$today->copy(), $today->copy()->endOfDay()],
        };
    }

    /**
     * The dashboard "at a glance" trend. Team tracked-hours bucketed by hour for
     * today / yesterday (24 buckets) or by day for this week (7 buckets), driven
     * by the same quick toggle as the KPI strip. Every bucket is the SAME
     * inDaySeconds proportional split the tables use, just over a narrower
     * window, so the buckets always sum back to the day/range total — a bar can
     * never claim hours a row doesn't have. Non-team viewers get their own.
     */
    public function dashboardTrend(Request $request)
    {
        $user = Auth::user();
        $ids = $user->hasAnyPermission(['dashboard.view_team', 'attendance.view'])
            ? User::active()->staff()->pluck('id')->all()
            : [$user->id];

        $tz = 'Asia/Karachi';
        $svc = app(TrackingSessionService::class);
        $range = $request->query('range', 'today');

        if ($range === 'week') {
            // Seven day-buckets ending today; labels are dates the client
            // formats in the viewer's own timezone.
            $rangeStart = Carbon::now($tz)->subDays(6)->startOfDay();
            $rangeEnd = Carbon::now($tz)->endOfDay();
            $buckets = [];
            $labels = [];
            $cursor = $rangeStart->copy();
            while ($cursor->lessThan($rangeEnd)) {
                $buckets[] = [$cursor->copy(), $cursor->copy()->endOfDay()];
                $labels[] = $cursor->toDateString();
                $cursor->addDay();
            }
            $granularity = 'day';
        } else {
            // 24 hour-buckets for a single day (today or yesterday).
            $day = $range === 'yesterday' ? Carbon::now($tz)->subDay() : Carbon::now($tz);
            $rangeStart = $day->copy()->startOfDay();
            $rangeEnd = $day->copy()->endOfDay();
            $buckets = [];
            $labels = [];
            for ($h = 0; $h < 24; $h++) {
                $bStart = $rangeStart->copy()->addHours($h);
                $buckets[] = [$bStart, $bStart->copy()->addHour()];
                $labels[] = sprintf('%02d:00', $h);
            }
            $granularity = 'hour';
        }

        $sessions = TrackingSession::query()
            ->whereIn('user_id', $ids)
            ->where('started_at', '<=', $rangeEnd)
            ->where(function ($q) use ($rangeStart) {
                $q->whereNull('stopped_at')->orWhere('stopped_at', '>=', $rangeStart);
            })
            ->where(function ($q) {
                $q->where('total_seconds', '>=', 60)->orWhere('status', TrackingSession::STATUS_ACTIVE);
            })
            ->get(['id', 'user_id', 'started_at', 'stopped_at', 'total_seconds', 'status']);

        $hours = array_map(
            fn ($b) => round($sessions->sum(fn ($s) => $svc->inDaySeconds($s, $b[0], $b[1])) / 3600, 2),
            $buckets,
        );

        return response()->json([
            'range' => $range,
            'granularity' => $granularity,
            'labels' => $labels,
            'hours' => $hours,
        ]);
    }

    /**
     * Roll the per-employee rows into the dashboard command-center: KPI counts,
     * a status mix for the doughnut, and a needs-attention list the owner can
     * act on. Computed entirely from data already loaded for the table (no new
     * queries beyond the eager-loaded shift overrides), so it can never disagree
     * with the rows below it. The stale-clock-out rule reuses the SAME shift end
     * + buffer math as AutoCloseAttendance so the dashboard flags exactly the
     * sessions auto-close will eventually close — never a different set.
     *
     * @param  Collection  $employeesById  every employee keyed by id (shiftOverrides loaded)
     * @param  Collection  $allRows  the unfiltered summaryStatsFor rows
     * @param  Collection  $entriesByUser  today+ entries grouped by user_id
     * @return array{0: array<string,mixed>, 1: array<int,array<string,mixed>>}
     */
    private function teamOverview(Collection $employeesById, Collection $allRows, Collection $entriesByUser, Carbon $now): array
    {
        $buffer = (int) config('services.attendance.auto_close_buffer_minutes', 20);
        $defaultHours = (float) config('services.attendance.prompt_after_hours', 8);
        // Warning types the admin hid in Settings (e.g. "not tracking" while
        // the whole company deliberately runs on web clock-in only).
        $hidden = MonitoringSetting::current()->hiddenAttentionTypes();

        $present = 0;
        $working = 0;
        $onBreak = 0;
        $totalTracked = 0.0;
        $activitySum = 0;
        $activityCount = 0;
        $attention = [];

        foreach ($allRows as $row) {
            $emp = $employeesById->get($row['user_id']);
            if (! $emp) {
                continue;
            }

            $tracked = (float) $row['tracked_hours'];
            $status = $row['current_status'];
            $isLive = (bool) $row['is_live'];
            $totalTracked += $tracked;

            if ($row['total_entries'] > 0) {
                $present++;
            }
            if ($status === 'Working') {
                $working++;
            }
            if ($status === 'On Break') {
                $onBreak++;
            }
            if ($tracked > 0) {
                $activitySum += (int) $row['activity_percent'];
                $activityCount++;
            }

            // This employee's entries for their own attendance day today (the
            // first clock-in + last break_start drive the late / long-break /
            // stale-clock-out checks).
            $today = $emp->attendanceDateFor($now);
            $todayEntries = $entriesByUser->get($emp->id, collect())
                ->filter(fn ($e) => $e->action_date->toDateString() === $today)
                ->values();
            $firstClockIn = $todayEntries->firstWhere('action_type', 'clock_in');
            $open = in_array($status, ['Working', 'On Break'], true);

            $base = [
                'user_id' => $emp->id,
                'name' => $emp->name,
                'avatar' => $emp->avatar_url ?? null,
                'designation' => $emp->designation ?? 'Employee',
            ];
            $flags = [];

            // 1. Forgot / stale clock-out (red): an open session past the same
            // shift-end + buffer auto-close uses. Skip a live tracker — that's
            // genuine overtime auto-close also leaves alone.
            if ($open && $firstClockIn && ! $isLive) {
                $tz = $emp->workTimezone();
                $clockInTs = Carbon::parse($firstClockIn->action_timestamp)->setTimezone($tz);
                $clockInDate = $firstClockIn->action_date instanceof Carbon
                    ? $firstClockIn->action_date->toDateString()
                    : (string) $firstClockIn->action_date;
                $shift = $emp->effectiveShiftFor($clockInDate);
                $shiftHours = $shift['hours'] ?? $defaultHours;
                $shiftEnd = $shift['start_time']
                    ? Carbon::parse($clockInDate.' '.$shift['start_time']->format('H:i:s'), $tz)
                        ->addMinutes((int) round($shiftHours * 60))
                    : $clockInTs->copy()->addMinutes((int) round($shiftHours * 60));
                $closeAt = ($shiftEnd->greaterThan($clockInTs) ? $shiftEnd->copy() : $clockInTs->copy())
                    ->addMinutes($buffer);
                if ($now->greaterThan($closeAt)) {
                    $flags[] = ['severity' => 'red', 'type' => 'stale_clock_out', 'message' => 'Clocked in past shift end — likely forgot to clock out'];
                }
            }

            // 2. Clocked in but not tracking (amber): present, open session, but
            // no tracker time and nothing running.
            if ($status === 'Working' && ! $isLive && $tracked < 0.1) {
                $flags[] = ['severity' => 'amber', 'type' => 'not_tracking', 'message' => 'Clocked in but not tracking'];
            }

            // 3. Tracking without clocking in (blue): a live tracker but no
            // clock-in recorded for today.
            if ($isLive && ! $firstClockIn) {
                $flags[] = ['severity' => 'blue', 'type' => 'no_clock_in', 'message' => 'Tracking without clocking in'];
            }

            // 4. Low activity (amber): genuinely low — only when they DID track,
            // so a zero-tracked person is caught by #2, not double-flagged here.
            if ($tracked > 0 && (int) $row['activity_percent'] < 30) {
                $flags[] = ['severity' => 'amber', 'type' => 'low_activity', 'message' => 'Low activity ('.((int) $row['activity_percent']).'%)'];
            }

            // 5. Late clock-in (amber): shared late-detection (shift start + grace
            // in the worker's own tz).
            if (AttendanceHours::isLateClockIn($emp, $now, $firstClockIn)) {
                $flags[] = ['severity' => 'amber', 'type' => 'late', 'message' => 'Late clock-in'];
            }

            // 6. On break too long (amber): open break running over 90 minutes.
            if ($status === 'On Break') {
                $lastBreak = $todayEntries->filter(fn ($e) => $e->action_type === 'break_start')->last();
                if ($lastBreak) {
                    $mins = (int) Carbon::parse($lastBreak->action_timestamp)->setTimezone($emp->workTimezone())->diffInMinutes($now);
                    if ($mins > 90) {
                        $flags[] = ['severity' => 'amber', 'type' => 'long_break', 'message' => 'On break '.$mins.'m'];
                    }
                }
            }

            foreach ($flags as $f) {
                if (in_array($f['type'], $hidden, true)) {
                    continue;
                }
                $attention[] = $base + $f + ['is_live' => $isLive];
            }
        }

        // Most urgent first (red → amber → blue), then by name for a stable order.
        $rank = ['red' => 0, 'amber' => 1, 'blue' => 2];
        usort($attention, fn ($a, $b) => [$rank[$a['severity']] ?? 9, $a['name']] <=> [$rank[$b['severity']] ?? 9, $b['name']]);

        $kpis = [
            'team_size' => $employeesById->count(),
            'present' => $present,
            'working' => $working,
            'on_break' => $onBreak,
            'clocked_out' => max(0, $present - $working - $onBreak),
            'avg_activity' => $activityCount > 0 ? (int) round($activitySum / $activityCount) : null,
            'total_tracked_hours' => round($totalTracked, 1),
            'needs_attention' => count($attention),
            'status_mix' => [
                ['label' => 'Working', 'value' => $working],
                ['label' => 'On break', 'value' => $onBreak],
                ['label' => 'Clocked out', 'value' => max(0, $present - $working - $onBreak)],
                ['label' => 'Not started', 'value' => max(0, $employeesById->count() - $present)],
            ],
        ];

        return [$kpis, $attention];
    }

    /**
     * Day activity % per user, from the tracker's own per-session activity
     * score weighted by tracked time. We use the session score (the same number
     * shown on each screenshot) rather than raw samples, because it's delivered
     * reliably via heartbeats even when the (large) samples table is sparse.
     */
    private function loadDayActivity(array $userIds, Carbon $now): Collection
    {
        $svc = app(TrackingSessionService::class);
        $dayStart = $now->copy()->startOfDay();
        $dayEnd = $now->copy()->endOfDay();

        return \App\Models\TrackingSession::query()
            ->whereIn('user_id', $userIds)
            ->where('total_seconds', '>', 0)
            ->where('started_at', '<=', $dayEnd)
            // Sessions overlapping today, including a night shift's session that
            // started yesterday evening and finished after midnight (or is still
            // running).
            ->where(function ($q) use ($dayStart) {
                $q->whereNull('stopped_at')
                    ->orWhere('stopped_at', '>=', $dayStart);
            })
            ->get(['id', 'user_id', 'started_at', 'stopped_at', 'total_seconds', 'activity_percent'])
            ->groupBy('user_id')
            ->map(function ($sessions) use ($svc, $dayStart, $dayEnd) {
                // Weight each session's activity by its IN-DAY tracked share
                // (not its whole total), so the Activity % matches the
                // calendar-day "Tracked today" hours shown beside it — and the
                // member analytics / Team page, which weight the same way. An
                // overnight session's yesterday-evening keystrokes no longer
                // inflate today's activity.
                $tot = 0;
                $weighted = 0;
                foreach ($sessions as $s) {
                    $share = $svc->inDaySeconds($s, $dayStart, $dayEnd);
                    $tot += $share;
                    $weighted += (int) $s->activity_percent * $share;
                }

                return $tot > 0 ? (int) round($weighted / $tot) : 0;
            });
    }

    /**
     * Currently-running tracker sessions keyed by user_id, so the dashboard's
     * "Tracked" column counts in-progress work instead of reading 0 until the
     * session stops. One query for the whole team.
     */
    private function loadLiveSessions(array $userIds): Collection
    {
        return \App\Models\TrackingSession::query()
            ->whereIn('user_id', $userIds)
            ->where('status', \App\Models\TrackingSession::STATUS_ACTIVE)
            ->get(['user_id', 'started_at', 'total_seconds'])
            ->keyBy('user_id');
    }

    /**
     * Tracked hours per user for the dashboard: today, yesterday, this week
     * (since Monday) and this month (since the 1st) — ALL plain CALENDAR days
     * in the business timezone, split with the shared inDaySeconds helper, so
     * the dashboard always agrees with the Timeline and the desktop app.
     * (Design decision 2026-07-04: the dashboard measures tracked work only;
     * attendance/in-office lives in the Attendance section. Tracked numbers
     * are never bucketed by shift day — a night shift's post-midnight work
     * simply belongs to the next date, exactly like the Timeline shows it.)
     *
     * Includes manual work-diary hours (non-tracker rows) per range.
     *
     * @param  array<int>  $userIds
     * @return Collection  keyed by user_id => ['today','yesterday','week','month'] float hours
     */
    private function loadTrackedStats(array $userIds, Carbon $now, Carbon $weekStart, Carbon $monthStart): Collection
    {
        $svc = app(TrackingSessionService::class);

        $todayStart = $now->copy()->startOfDay();
        $todayEnd = $now->copy()->endOfDay();
        $yStart = $todayStart->copy()->subDay();
        $yEnd = $yStart->copy()->endOfDay();

        $windows = [
            'today' => [$todayStart, $todayEnd],
            'yesterday' => [$yStart, $yEnd],
            'week' => [$weekStart->copy()->startOfDay(), $todayEnd],
            'month' => [$monthStart->copy()->startOfDay(), $todayEnd],
        ];
        $fetchStart = collect($windows)->map(fn ($w) => $w[0])->min();

        // One query for every session overlapping any window; each window then
        // takes its overlap share. Skip deletion crumbs (<60s) but always keep
        // a live session.
        $sessionsByUser = TrackingSession::query()
            ->whereIn('user_id', $userIds)
            ->where('started_at', '<=', $todayEnd)
            ->where(function ($q) use ($fetchStart) {
                $q->whereNull('stopped_at')->orWhere('stopped_at', '>=', $fetchStart);
            })
            ->where(function ($q) {
                $q->where('total_seconds', '>=', 60)
                    ->orWhere('status', TrackingSession::STATUS_ACTIVE);
            })
            ->get(['id', 'user_id', 'started_at', 'stopped_at', 'total_seconds', 'status'])
            ->groupBy('user_id');

        // Manual work-diary hours (non-tracker rows) bucketed by their date.
        $manualByUser = WorkHour::query()
            ->whereIn('user_id', $userIds)
            ->whereDate('date', '>=', $fetchStart->toDateString())
            ->where(function ($q) {
                $q->whereNull('source')->orWhere('source', '!=', 'tracker');
            })
            ->get(['user_id', 'hours', 'date'])
            ->groupBy('user_id');

        return collect($userIds)->mapWithKeys(function ($id) use ($sessionsByUser, $manualByUser, $windows, $svc) {
            $sessions = $sessionsByUser->get($id, collect());
            $manual = $manualByUser->get($id, collect());

            $stats = [];
            foreach ($windows as $key => [$start, $end]) {
                $tracker = (int) $sessions->sum(fn ($s) => $svc->inDaySeconds($s, $start, $end));
                $manualHours = (float) $manual
                    ->filter(function ($r) use ($start, $end) {
                        $d = Carbon::parse($r->date)->toDateString();

                        return $d >= $start->toDateString() && $d <= $end->toDateString();
                    })
                    ->sum('hours');
                $stats[$key] = round($tracker / 3600 + $manualHours, 2);
            }

            return [$id => $stats];
        });
    }

    /**
     * One grouped fetch instead of three queries per employee — the previous
     * shape ran ~165 queries for a full team and made every clock action feel
     * 5+ seconds slow (the dashboard refetches this summary after each one).
     *
     * @param  array<int>  $userIds
     * @return Collection keyed by user_id, entries ordered chronologically
     */
    private function loadSummaryEntries(array $userIds, Carbon $now, Carbon $weekStart, Carbon $monthStart): Collection
    {
        // An overnight shift's "today" can resolve to yesterday's date, which
        // on the 1st of a month falls before monthStart — widen the range so
        // the today-bucket never loses entries.
        $rangeStart = min($monthStart->toDateString(), $weekStart->toDateString(), $now->copy()->subDay()->toDateString());

        return TimeEntry::query()
            ->whereIn('user_id', $userIds)
            ->whereDate('action_date', '>=', $rangeStart)
            ->orderBy('action_timestamp', 'asc')
            ->get()
            ->groupBy('user_id');
    }

    /**
     * @param  Collection  $entries  this user's entries, chronological
     * @return array<string, mixed>
     */
    private function summaryStatsFor(User $employee, $entries, Carbon $now, Carbon $weekStart, Carbon $monthStart, ?Collection $trackedByUserDate = null, ?Collection $liveByUser = null, ?Collection $activityByUser = null): array
    {
        $today = $employee->attendanceDateFor($now);
        $weekStartDate = $weekStart->toDateString();
        $monthStartDate = $monthStart->toDateString();

        $todayEntries = $entries->filter(fn ($e) => $e->action_date->toDateString() === $today)->values();
        $weeklyEntries = $entries->filter(fn ($e) => $e->action_date->toDateString() >= $weekStartDate)->values();
        $monthlyEntries = $entries->filter(fn ($e) => $e->action_date->toDateString() >= $monthStartDate)->values();

        $stats = $this->calculateEmployeeStats($employee, $todayEntries, $weeklyEntries, $monthlyEntries);

        // Tracked work per CALENDAR day/range (see loadTrackedStats): always
        // agrees with the Timeline and the desktop app. tracked_hours = today;
        // yesterday/week/month feed the dashboard's tracked-only team table.
        $tracked = $trackedByUserDate?->get($employee->id) ?? [];
        $stats['tracked_hours'] = round((float) ($tracked['today'] ?? 0), 2);
        $stats['tracked_yesterday_hours'] = round((float) ($tracked['yesterday'] ?? 0), 2);
        $stats['tracked_week_hours'] = round((float) ($tracked['week'] ?? 0), 2);
        $stats['tracked_month_hours'] = round((float) ($tracked['month'] ?? 0), 2);

        // Live flag drives the "Working" badge / sort; the running time is
        // already included in tracked_hours above via inDaySeconds. live_since
        // (the active session's start) lets the Live board show a running
        // "current session" duration.
        $live = $liveByUser?->get($employee->id);
        $stats['is_live'] = (bool) $live;
        $stats['live_since'] = $live ? Carbon::parse($live->started_at)->toISOString() : null;

        // Day-level activity: how active they actually were while tracked
        // (replaces the confusing tracked-vs-clocked "coverage" ratio).
        $stats['activity_percent'] = (int) round((float) ($activityByUser[$employee->id] ?? 0));

        return $stats;
    }

    private function calculateEmployeeStats($employee, $todayEntries, $weeklyEntries, $monthlyEntries)
    {
        // Calculate today's stats
        $todayStats = $this->calculateTimeStats($todayEntries);

        // Calculate weekly stats
        $weeklyStats = $this->calculateTimeStats($weeklyEntries);

        // Calculate monthly stats
        $monthlyStats = $this->calculateTimeStats($monthlyEntries);

        return [
            'user_id' => $employee->id,
            'user_name' => $employee->name,
            'avatar' => $employee->avatar_url ?? null,
            'designation' => $employee->designation ?? 'Employee',
            'shift_name' => $employee->shift_name,
            'total_work_hours' => $todayStats['workHours'],
            'total_break_hours' => $todayStats['breakHours'],
            'weekly_work_hours' => $weeklyStats['workHours'],
            'weekly_break_hours' => $weeklyStats['breakHours'],
            'monthly_work_hours' => $monthlyStats['workHours'],
            'monthly_break_hours' => $monthlyStats['breakHours'],
            'total_entries' => $todayEntries->count(),
            'last_action' => $todayStats['lastAction'],
            'current_status' => $todayStats['status'],
            'last_action_time' => $todayEntries->last()?->formatted_action_time,
            'shift_start_time' => $employee->shift_start_time?->format('H:i'),
        ];
    }

    // calculateTimeStats() + positiveMinutesBetween() now live in the shared
    // CalculatesTimeStats trait (used here and by EmployeeAttendanceController).
}
