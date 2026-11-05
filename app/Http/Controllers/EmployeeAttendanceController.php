<?php

namespace App\Http\Controllers;

use App\Http\Controllers\Concerns\CalculatesTimeStats;
use App\Models\AttendanceBulkAction;
use App\Models\CompanyHoliday;
use App\Models\ManualAttendanceAudit;
use App\Models\ManualAttendanceMark;
use App\Models\TimeEntry;
use App\Models\TrackingAuditLog;
use App\Models\User;
use App\Services\AttendanceCloser;
use App\Services\AttendanceSlackReportService;
use App\Support\TimeClockRules;
use Carbon\Carbon;
use Carbon\CarbonPeriod;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use RuntimeException;
use App\Support\AttendanceHours;

class EmployeeAttendanceController extends Controller
{
    use CalculatesTimeStats;

    // The catalogue and the day-resolution rules live in App\Support\AttendanceStatus
    // so the payroll export (/api/payroll) resolves days exactly as this grid does.
    private const ATTENDANCE_STATUSES = \App\Support\AttendanceStatus::CODES;

    /**
     * Display the employee attendance page
     */
    public function index()
    {
        return Inertia::render('EmployeeAttendance', [
            'serverDate' => Carbon::today('Asia/Karachi')->toDateString(),
            'shiftOptions' => \App\Models\Shift::orderBy('sort_order')->orderBy('name')->get(['id', 'name']),
            'canManuallyMarkAttendance' => $this->canManuallyMarkAttendance(request()->user()),
            'canEditClockTimes' => $this->canEditClockTimes(request()->user()),
            'canSendAttendanceSlack' => request()->user()?->hasPermission('reports.send_slack') ?? false,
            'slackConfigured' => app(AttendanceSlackReportService::class)->configured(),
        ]);
    }

    /**
     * Existing clock times for one employee/day, as H:i strings in that worker's
     * own work timezone (returned alongside the zone label), to prefill the
     * "Edit clock times" dialog. Gated by attendance.edit_times.
     */
    public function getDayEntries(Request $request)
    {
        abort_unless($this->canEditClockTimes($request->user()), 403);

        $validated = $request->validate([
            'user_id' => ['required', 'integer', 'exists:users,id'],
            'date' => ['required', 'date_format:Y-m-d'],
        ]);

        $entries = TimeEntry::forUser($validated['user_id'])
            ->forDate($validated['date'])
            ->orderBy('action_timestamp')->orderBy('id')
            ->get();

        // Show (and later parse) the times in the SUBJECT's own work timezone so
        // an admin in another zone edits the worker's local wall-clock; the label
        // is returned so the dialog can show e.g. "(America/New York)".
        $subject = User::find($validated['user_id']);
        $tz = $subject?->workTimezone() ?: config('app.timezone', 'Asia/Karachi');
        $fmt = fn (?TimeEntry $e) => $e
            ? Carbon::parse($e->action_timestamp)->setTimezone($tz)->format('H:i')
            : null;

        return response()->json([
            'clock_in' => $fmt($entries->firstWhere('action_type', 'clock_in')),
            'clock_out' => $fmt($entries->where('action_type', 'clock_out')->last()),
            'break_start' => $fmt($entries->firstWhere('action_type', 'break_start')),
            'break_end' => $fmt($entries->where('action_type', 'break_end')->last()),
            'timezone' => $tz,
            // Only label a non-default zone, so the dialog is unchanged for local
            // (Asia/Karachi) staff and only shows a banner for remote workers.
            'timezone_label' => $tz !== config('app.timezone', 'Asia/Karachi')
                ? str_replace('_', ' ', $tz)
                : '',
        ]);
    }

    /**
     * Set/correct an employee's clock-in, clock-out, and break times for a day
     * (e.g. they forgot to clock in). Replaces the day's TimeEntry rows with a
     * single legal clock_in → [break_start → break_end] → clock_out sequence,
     * audits the change, and suppresses the attendance Slack post. Gated by
     * attendance.edit_times. The in-office hours used everywhere derive live
     * from these rows, so every dependent number updates automatically.
     */
    public function updateClockTimes(Request $request)
    {
        $actor = $request->user();
        abort_unless($this->canEditClockTimes($actor), 403);

        $validated = $request->validate([
            'user_id' => ['required', 'integer', 'exists:users,id'],
            'date' => ['required', 'date_format:Y-m-d'],
            'clock_in' => ['nullable', 'date_format:H:i'],
            'clock_out' => ['nullable', 'date_format:H:i'],
            'break_start' => ['nullable', 'date_format:H:i'],
            'break_end' => ['nullable', 'date_format:H:i'],
            'reason' => ['required', 'string', 'max:255'],
        ]);

        $target = User::findOrFail($validated['user_id']);
        // Parse the entered times in the SUBJECT's own work timezone (the dialog
        // shows that zone's label), so an admin elsewhere edits the worker's
        // local wall-clock. action_date then buckets to the worker's day.
        // Carbon::parse (not createFromFormat) is used so the timezone is applied
        // to the wall-clock rather than ignored.
        $tz = $target->workTimezone();
        $date = $validated['date'];
        $mk = fn (string $hi) => Carbon::parse("{$date} {$hi}", $tz);

        // Provided actions in canonical clock order. break/clock_out that land
        // chronologically at/before clock_in are pushed to the next day so an
        // overnight shift stays monotonic.
        $order = ['clock_in', 'break_start', 'break_end', 'clock_out'];
        $provided = array_values(array_filter($order, fn ($a) => ! empty($validated[$a])));

        if (empty($provided)) {
            throw ValidationException::withMessages(['clock_in' => 'Enter at least a clock-in time.']);
        }

        $timestamps = [];
        $prev = null;
        foreach ($provided as $action) {
            $ts = $mk($validated[$action]);
            if ($prev) {
                while ($ts->lessThanOrEqualTo($prev)) {
                    $ts->addDay();
                }
            }
            $timestamps[$action] = $ts;
            $prev = $ts;
        }

        // Sequence must be legal (must start clock_in; break pairs; etc.).
        $last = null;
        foreach ($provided as $action) {
            if (! TimeClockRules::isAllowed($last, $action)) {
                throw ValidationException::withMessages([
                    $action => TimeClockRules::blockedMessage($last, $action),
                ]);
            }
            $last = $action;
        }

        // Every timestamp must bucket to the edited day for this user's shift,
        // so an edit can't silently corrupt a neighbouring attendance day.
        foreach ($timestamps as $action => $ts) {
            if ($target->attendanceDateFor($ts) !== $date) {
                throw ValidationException::withMessages([
                    $action => "That time falls on a different attendance day for this employee's shift. Please check the date and time.",
                ]);
            }
        }

        // Capture the old times for the audit before replacing the day.
        $oldEntries = TimeEntry::forUser($target->id)->forDate($date)
            ->orderBy('action_timestamp')->orderBy('id')->get();
        $fmtOld = fn (?TimeEntry $e) => $e
            ? Carbon::parse($e->action_timestamp)->setTimezone($tz)->format('H:i')
            : null;
        $oldValue = [
            'clock_in' => $fmtOld($oldEntries->firstWhere('action_type', 'clock_in')),
            'clock_out' => $fmtOld($oldEntries->where('action_type', 'clock_out')->last()),
            'break_start' => $fmtOld($oldEntries->firstWhere('action_type', 'break_start')),
            'break_end' => $fmtOld($oldEntries->where('action_type', 'break_end')->last()),
        ];

        DB::transaction(function () use ($target, $date, $timestamps, $provided) {
            // Replace-the-day: simpler than patching rows and guarantees a legal
            // sequence. The 'Admin clock edit' note suppresses the Slack post.
            TimeEntry::forUser($target->id)->forDate($date)->delete();
            foreach ($provided as $action) {
                // Store the canonical instant + action_time in the app timezone so
                // it round-trips and action_time == TIME(action_timestamp); the
                // entered value was parsed in the worker's zone above.
                $ts = $timestamps[$action]->copy()->setTimezone(config('app.timezone', 'Asia/Karachi'));
                TimeEntry::create([
                    'user_id' => $target->id,
                    'action_type' => $action,
                    'action_timestamp' => $ts,
                    'action_date' => $date,
                    'action_time' => $ts->toTimeString(),
                    'notes' => 'Admin clock edit',
                ]);
            }
        });

        TrackingAuditLog::record([
            'subject_user_id' => $target->id,
            'actor_user_id' => $actor->id,
            'action' => 'attendance.clock_edit',
            'event_date' => $date,
            'old_value' => $oldValue,
            'new_value' => [
                'clock_in' => $validated['clock_in'] ?? null,
                'clock_out' => $validated['clock_out'] ?? null,
                'break_start' => $validated['break_start'] ?? null,
                'break_end' => $validated['break_end'] ?? null,
            ],
            'reason' => $validated['reason'],
        ]);

        return response()->json(['message' => 'Clock times updated.']);
    }

    /**
     * Clock a worker out who forgot to (admin / super-admin only, gated by
     * attendance.edit_times). Writes a real clock_out via AttendanceCloser —
     * which also stops any tracker still running — defaulting to the worker's
     * shift end so their hours stay accurate instead of inflating to "now".
     * The action is audited; the 'Admin clock-out' note suppresses the Slack
     * clock-out post (an admin did this, the worker didn't clock out live).
     */
    public function adminClockOut(Request $request)
    {
        $actor = $request->user();
        abort_unless($this->canEditClockTimes($actor), 403);

        $validated = $request->validate([
            'user_id' => ['required', 'integer', 'exists:users,id'],
            'time' => ['nullable', 'date_format:H:i'],
            'note' => ['nullable', 'string', 'max:255'],
        ]);

        $target = User::findOrFail($validated['user_id']);

        // Open = latest action keeps them on the clock (clock_in / break_start /
        // break_end). Checked here (not via openClockIn, which ignores break_end)
        // so the action matches what the Shift Board shows as "clocked in".
        $last = TimeEntry::forUser($target->id)
            ->orderByDesc('action_timestamp')->orderByDesc('id')
            ->first();
        if (! $last || ! in_array($last->action_type, ['clock_in', 'break_start', 'break_end'], true)) {
            throw ValidationException::withMessages([
                'user_id' => $target->name.' is not currently clocked in.',
            ]);
        }

        $openClockIn = $last->action_type === 'clock_in'
            ? $last
            : TimeEntry::forUser($target->id)->where('action_type', 'clock_in')
                ->orderByDesc('action_timestamp')->orderByDesc('id')->first();
        if (! $openClockIn) {
            throw ValidationException::withMessages([
                'user_id' => 'Could not find an open clock-in for '.$target->name.'.',
            ]);
        }

        // Times are read in the SUBJECT's own work timezone (an admin elsewhere
        // closes the worker's local wall-clock); the open clock-in's day anchors
        // the close so an overnight session closes on the correct date.
        $tz = $target->workTimezone();
        $openDate = $openClockIn->action_date instanceof Carbon
            ? $openClockIn->action_date->toDateString()
            : (string) $openClockIn->action_date;
        $openTs = Carbon::parse($openClockIn->action_timestamp)->setTimezone($tz);

        $shift = $target->effectiveShiftFor($openDate);
        $defaultHours = (float) config('services.attendance.prompt_after_hours', 8);
        $shiftHours = $shift['hours'] ?? $defaultHours;
        $defaultClose = $shift['start_time']
            ? Carbon::parse($openDate.' '.$shift['start_time']->format('H:i:s'), $tz)->addMinutes((int) round($shiftHours * 60))
            : Carbon::now($tz);

        if (! empty($validated['time'])) {
            $closeAt = Carbon::parse($openDate.' '.$validated['time'], $tz);
            // An entered time at/before the clock-in belongs to the next day
            // (overnight shift); AttendanceCloser also clamps as a safety net.
            if ($closeAt->lessThanOrEqualTo($openTs)) {
                $closeAt->addDay();
            }
        } else {
            $closeAt = $defaultClose;
        }

        // Never write the clock-out before the worker's latest action — e.g. a
        // break taken after the shift end. Otherwise the clock-out lands earlier
        // in the timeline than that action, which stays the newest entry and the
        // session would still read as open. Push the close just past it.
        $lastTs = Carbon::parse($last->action_timestamp)->setTimezone($tz);
        if ($closeAt->lessThanOrEqualTo($lastTs)) {
            $closeAt = $lastTs->copy()->addMinute();
        }

        $note = trim((string) ($validated['note'] ?? ''));
        $reason = 'Admin clock-out'.($note !== '' ? ': '.$note : ' (forgot to clock out)');

        $clockOut = app(AttendanceCloser::class)->close($target->id, $closeAt, $reason);
        if (! $clockOut) {
            throw ValidationException::withMessages([
                'user_id' => 'Could not clock '.$target->name.' out — please refresh and try again.',
            ]);
        }

        $closedAtLocal = Carbon::parse($clockOut->action_timestamp)->setTimezone($tz);

        TrackingAuditLog::record([
            'subject_user_id' => $target->id,
            'actor_user_id' => $actor->id,
            'action' => 'attendance.admin_clock_out',
            'event_date' => $openDate,
            'old_value' => ['clock_out' => null],
            'new_value' => ['clock_out' => $closedAtLocal->format('H:i')],
            'reason' => $note !== '' ? $note : 'forgot to clock out',
        ]);

        return response()->json([
            'message' => 'Clocked out '.$target->name.' at '.$closedAtLocal->format('g:i A').'.',
        ]);
    }

    public function getMonthlyGrid(Request $request)
    {
        $validated = $request->validate([
            'month' => ['nullable', 'date_format:Y-m'],
            'week' => ['nullable', 'date_format:Y-m-d'],
        ]);

        $month = $validated['month'] ?? Carbon::today('Asia/Karachi')->format('Y-m');
        if (! empty($validated['week'])) {
            $startDate = Carbon::parse($validated['week'], 'Asia/Karachi')->startOfWeek(Carbon::MONDAY)->startOfDay();
            $endDate = $startDate->copy()->addDays(6)->endOfDay();
        } else {
            $startDate = Carbon::createFromFormat('Y-m-d', "{$month}-01", 'Asia/Karachi')->startOfDay();
            $endDate = $startDate->copy()->endOfMonth();
        }
        $now = Carbon::now('Asia/Karachi');
        $today = $now->copy()->startOfDay();
        $holidays = CompanyHoliday::between($startDate, $endDate);

        $days = collect(CarbonPeriod::create($startDate, $endDate->copy()->startOfDay()))->map(function (Carbon $date) use ($holidays) {
            return [
                'date' => $date->toDateString(),
                'day' => $date->day,
                'month_label' => $date->format('M'),
                'weekday' => $date->format('D'),
                'is_weekend' => $date->isSunday(),
                'holiday' => ($holidays[$date->toDateString()] ?? null)?->name,
            ];
        });

        // Parsed once per day here rather than once per employee-day cell —
        // with a full team this loop body otherwise runs ~700 times a month.
        $carbonDays = $days->mapWithKeys(fn (array $day) => [
            $day['date'] => Carbon::parse($day['date'], 'Asia/Karachi'),
        ]);

        $entriesByUserDate = TimeEntry::query()
            ->whereBetween('action_date', [$startDate->toDateString(), $endDate->toDateString()])
            ->orderBy('action_timestamp')
            ->get()
            ->groupBy(fn (TimeEntry $entry) => $entry->user_id.'|'.$entry->action_date->toDateString());

        $manualMarks = ManualAttendanceMark::query()
            ->whereBetween('attendance_date', [$startDate->toDateString(), $endDate->toDateString()])
            ->get()
            ->keyBy(fn (ManualAttendanceMark $mark) => $mark->user_id.'|'.$mark->attendance_date->toDateString());

        $summaryTemplate = [
            'holidays' => 0,
            'present' => 0,
            'absent' => 0,
            'leave' => 0,
            'half_day' => 0,
            'work_from_home' => 0,
            'late_coming' => 0,
            'late_joining' => 0,
            'public_holiday' => 0,
            'total_work_hours' => 0,
        ];

        // User ids that have real history (time entries or manual marks) in the
        // viewed month, derived from the already-fetched collections. The keys are
        // "userId|date", so split off the user id.
        $usersWithHistory = $entriesByUserDate->keys()
            ->merge($manualMarks->keys())
            ->map(fn (string $key) => (int) explode('|', $key)[0])
            ->unique()
            ->values();

        // Live grid hides deactivated staff going forward, but a deactivated user
        // who has entries/manual marks in the viewed month still renders so the
        // historical period stays intact.
        $employeesQuery = User::query()
            // Eager-load the shift history + overrides: the grid resolves a shift
            // for every user x every day, which otherwise lazy-loads per user.
            ->with(array_merge(['shift:id,name'], User::shiftEagerLoads()))
            ->where(function ($query) use ($usersWithHistory) {
                $query->active();
                if ($usersWithHistory->isNotEmpty()) {
                    $query->orWhereIn('id', $usersWithHistory->all());
                }
            })
            ->orderBy('name');
        \App\Support\ShiftFilter::apply($employeesQuery, $request);
        $employees = $employeesQuery->get()
            ->map(function (User $employee) use ($days, $carbonDays, $entriesByUserDate, $manualMarks, $holidays, $now, $today, $summaryTemplate) {
                $summary = $summaryTemplate;

                $dayCells = $days->map(function (array $day) use ($employee, $carbonDays, $entriesByUserDate, $manualMarks, $holidays, $now, $today, &$summary) {
                    $date = $carbonDays[$day['date']];
                    $key = $employee->id.'|'.$day['date'];
                    $entries = $entriesByUserDate->get($key, collect());
                    $manualMark = $manualMarks->get($key);
                    $stats = $entries->isNotEmpty() ? $this->calculateTimeStats($entries) : null;

                    $firstClockIn = $entries->where('action_type', 'clock_in')->first();
                    $lastEntry = $entries->last();
                    $status = $this->resolveMonthlyStatus($employee, $date, $entries, $manualMark, $now, $today, $firstClockIn, ($holidays[$day['date']] ?? null)?->status_code);
                    $this->addStatusToSummary($summary, $status['code'], $stats['workHours'] ?? 0);

                    return [
                        'date' => $day['date'],
                        'status_code' => $status['code'],
                        'status_label' => $status['label'],
                        'source' => $status['source'],
                        'work_hours' => $stats['workHours'] ?? 0,
                        'break_hours' => $stats['breakHours'] ?? 0,
                        'first_clock_in' => $firstClockIn ? $firstClockIn->formatted_action_time : null,
                        'last_action_time' => $lastEntry ? $lastEntry->formatted_action_time : null,
                        'manual_note' => $manualMark?->note,
                    ];
                })->values();

                $summary['total_work_hours'] = round($summary['total_work_hours'], 2);

                return [
                    'user_id' => $employee->id,
                    'user_name' => $employee->name,
                    'avatar' => $employee->avatar_url ?? null,
                    'designation' => $employee->designation ?? 'Employee',
                    'shift_name' => $employee->shift_name,
                    'days' => $dayCells,
                    'summary' => $summary,
                ];
            })
            ->values();

        return response()->json([
            'month' => $month,
            'days' => $days->values(),
            'employees' => $employees,
            'statusOptions' => collect(self::ATTENDANCE_STATUSES)
                ->map(fn (string $label, string $code) => ['code' => $code, 'label' => $label])
                ->values(),
            'canManualMark' => $this->canManuallyMarkAttendance($request->user()),
        ]);
    }

    public function updateManualStatus(Request $request)
    {
        if (! $this->canManuallyMarkAttendance($request->user())) {
            abort(403, 'You do not have permission to manually mark attendance.');
        }

        $validated = $request->validate([
            'user_id' => ['required', 'integer', 'exists:users,id'],
            'date' => ['required', 'date_format:Y-m-d'],
            'status_code' => ['nullable', Rule::in(array_keys(self::ATTENDANCE_STATUSES))],
            'note' => ['nullable', 'string', 'max:255'],
        ]);

        $date = Carbon::parse($validated['date'], 'Asia/Karachi')->toDateString();
        $statusCode = $validated['status_code'] ?? null;

        DB::transaction(function () use ($date, $request, $statusCode, $validated) {
            $mark = ManualAttendanceMark::query()
                ->where('user_id', $validated['user_id'])
                ->whereDate('attendance_date', $date)
                ->first();

            $oldStatusCode = $mark?->status_code;
            $oldReason = $mark?->note;
            $newReason = $validated['note'] ?? null;

            if (! $statusCode) {
                if ($mark) {
                    $this->recordManualAttendanceAudit(
                        $validated['user_id'],
                        $date,
                        $oldStatusCode,
                        null,
                        $request->user()->id,
                        $oldReason
                    );

                    $mark->delete();
                }

                return;
            }

            if (! $mark) {
                $mark = new ManualAttendanceMark([
                    'user_id' => $validated['user_id'],
                    'attendance_date' => $date,
                ]);
            }

            if ($oldStatusCode !== $statusCode || $oldReason !== $newReason) {
                $this->recordManualAttendanceAudit(
                    $validated['user_id'],
                    $date,
                    $oldStatusCode,
                    $statusCode,
                    $request->user()->id,
                    $newReason
                );
            }

            $mark->fill([
                'marked_by_user_id' => $request->user()->id,
                'status_code' => $statusCode,
                'note' => $newReason,
            ])->save();
        });

        if (! $statusCode) {
            return response()->json(['message' => 'Manual attendance mark cleared.']);
        }

        return response()->json(['message' => 'Attendance status updated.']);
    }

    /**
     * What a calendar change would do, day by day, so the confirmation can name
     * the exact days and warn when it would hide real attendance. Changes nothing.
     */
    public function previewCalendar(Request $request)
    {
        [$validated, $userIds, $dates] = $this->calendarInput($request);
        [$first, $last] = [$dates->first(), $dates->last()];

        $clockedIn = TimeEntry::query()
            ->whereIn('user_id', $userIds)
            ->whereDate('action_date', '>=', $first)
            ->whereDate('action_date', '<=', $last)
            ->where('action_type', 'clock_in')
            ->get(['user_id', 'action_date'])
            ->groupBy(fn (TimeEntry $entry) => $entry->action_date->toDateString())
            ->map(fn ($rows) => $rows->pluck('user_id')->unique()->count());

        $marks = ManualAttendanceMark::query()
            ->whereIn('user_id', $userIds)
            ->whereDate('attendance_date', '>=', $first)
            ->whereDate('attendance_date', '<=', $last)
            ->get(['status_code', 'attendance_date']);
        $isApply = $validated['operation'] === 'apply';
        $replaced = $isApply ? $marks->where('status_code', '!=', $validated['status_code']) : $marks;
        $replacedByDate = $replaced->countBy(fn (ManualAttendanceMark $mark) => $mark->attendance_date->toDateString());

        return response()->json([
            'operation' => $validated['operation'],
            'status_label' => $isApply ? self::ATTENDANCE_STATUSES[$validated['status_code']] : null,
            'people' => count($userIds),
            'cells' => $isApply ? count($userIds) * $dates->count() : $marks->count(),
            'replaced' => $replaced->count(),
            'days' => $dates->map(fn (string $date) => [
                'date' => $date,
                'label' => Carbon::parse($date, 'Asia/Karachi')->format('D j M'),
                'clocked_in' => $clockedIn[$date] ?? 0,
                'replaced' => $replacedByDate[$date] ?? 0,
            ])->values(),
        ]);
    }

    public function updateCalendar(Request $request)
    {
        [$validated, $userIds, $dates] = $this->calendarInput($request);

        [$affected, $bulkActionId] = DB::transaction(function () use ($validated, $userIds, $dates, $request) {
            $bulkAction = AttendanceBulkAction::available()
                ? AttendanceBulkAction::create([
                    'operation' => $validated['operation'],
                    'status_code' => $validated['operation'] === 'apply' ? $validated['status_code'] : null,
                    'start_date' => $dates->first(),
                    'end_date' => $dates->last(),
                    'people_count' => count($userIds),
                    'days_count' => $dates->count(),
                    'note' => $validated['note'] ?? null,
                    'changed_by_user_id' => $request->user()->id,
                ])
                : null;

            $affected = $this->applyCalendarChange($validated, $userIds, $dates, $request->user()->id, $bulkAction?->id);

            if ($bulkAction) {
                $changed = ManualAttendanceAudit::query()->where('bulk_action_id', $bulkAction->id)->count();
                $changed > 0 ? $bulkAction->update(['cells_count' => $changed]) : $bulkAction->delete();
            }

            return [$affected, $bulkAction?->exists ? $bulkAction->id : null];
        });

        return response()->json([
            'message' => $validated['operation'] === 'clear'
                ? "Removed {$affected} scheduled attendance marks."
                : "Applied attendance to {$affected} person-days.",
            'affected' => $affected,
            'bulk_action_id' => $bulkActionId,
        ]);
    }

    /** @return array{0: array, 1: array<int, int>, 2: \Illuminate\Support\Collection<int, string>} */
    private function calendarInput(Request $request): array
    {
        if (! $this->canManuallyMarkAttendance($request->user())) {
            abort(403, 'You do not have permission to schedule attendance.');
        }

        $validated = $request->validate([
            'operation' => ['required', Rule::in(['apply', 'clear'])],
            'scope' => ['required', Rule::in(['company', 'selected'])],
            'user_ids' => ['nullable', 'array'],
            'user_ids.*' => ['integer', 'exists:users,id'],
            'start_date' => ['required', 'date_format:Y-m-d'],
            'end_date' => ['required', 'date_format:Y-m-d', 'after_or_equal:start_date'],
            'status_code' => ['nullable', Rule::in(['H', 'PH', 'L', 'HD', 'WFH'])],
            'note' => ['nullable', 'string', 'max:255'],
        ]);

        if ($validated['operation'] === 'apply' && empty($validated['status_code'])) {
            throw ValidationException::withMessages([
                'status_code' => 'Choose an attendance status to apply.',
            ]);
        }

        $startDate = Carbon::parse($validated['start_date'], 'Asia/Karachi')->startOfDay();
        $endDate = Carbon::parse($validated['end_date'], 'Asia/Karachi')->startOfDay();

        if ($startDate->diffInDays($endDate) > 365) {
            throw ValidationException::withMessages([
                'end_date' => 'The attendance calendar range cannot exceed 366 days.',
            ]);
        }

        // Company-scope scheduling only targets active staff so a bulk apply
        // doesn't recreate marks for archived users. Explicit selections are
        // honoured as-is (admin-chosen ids).
        $userIds = $validated['scope'] === 'company'
            ? User::query()->active()->pluck('id')->all()
            : array_values(array_unique($validated['user_ids'] ?? []));

        if ($userIds === []) {
            throw ValidationException::withMessages([
                'user_ids' => 'Select at least one user.',
            ]);
        }

        $dates = collect(CarbonPeriod::create($startDate, $endDate))
            ->map(fn (Carbon $date) => $date->toDateString());

        return [$validated, $userIds, $dates];
    }

    private function applyCalendarChange(array $validated, array $userIds, $dates, int $actorId, ?int $bulkActionId): int
    {
        if ($validated['operation'] === 'clear') {
            $marks = ManualAttendanceMark::query()
                ->whereIn('user_id', $userIds)
                ->whereDate('attendance_date', '>=', $dates->first())
                ->whereDate('attendance_date', '<=', $dates->last())
                ->get();

            foreach ($marks as $mark) {
                $this->recordManualAttendanceAudit(
                    $mark->user_id,
                    $mark->attendance_date->toDateString(),
                    $mark->status_code,
                    null,
                    $actorId,
                    $mark->note,
                    $bulkActionId,
                    $mark->note
                );
            }

            ManualAttendanceMark::query()
                ->whereIn('id', $marks->pluck('id'))
                ->delete();

            return $marks->count();
        }

        $affected = 0;

        foreach ($userIds as $userId) {
            foreach ($dates as $date) {
                $mark = ManualAttendanceMark::query()
                    ->where('user_id', $userId)
                    ->whereDate('attendance_date', $date)
                    ->first() ?? new ManualAttendanceMark([
                        'user_id' => $userId,
                        'attendance_date' => $date,
                    ]);
                $oldStatusCode = $mark->exists ? $mark->status_code : null;
                $oldReason = $mark->exists ? $mark->note : null;
                $newReason = $validated['note'] ?? null;

                if ($oldStatusCode !== $validated['status_code'] || $oldReason !== $newReason) {
                    $this->recordManualAttendanceAudit(
                        $userId,
                        $date,
                        $oldStatusCode,
                        $validated['status_code'],
                        $actorId,
                        $newReason,
                        $bulkActionId,
                        $oldReason
                    );
                }

                $mark->fill([
                    'marked_by_user_id' => $actorId,
                    'status_code' => $validated['status_code'],
                    'note' => $newReason,
                ])->save();
                $affected++;
            }
        }

        return $affected;
    }

    public function getManualHistory(Request $request)
    {
        if (! $this->canManuallyMarkAttendance($request->user())) {
            abort(403, 'You do not have permission to view manual attendance history.');
        }

        $validated = $request->validate([
            'month' => ['nullable', 'date_format:Y-m'],
            'user_id' => ['nullable', 'integer', 'exists:users,id'],
        ]);

        $month = $validated['month'] ?? Carbon::today('Asia/Karachi')->format('Y-m');
        $startDate = Carbon::createFromFormat('Y-m-d', "{$month}-01", 'Asia/Karachi')->startOfDay();
        $endDate = $startDate->copy()->endOfMonth();

        $history = ManualAttendanceAudit::query()
            ->with(['user:id,name,designation,avatar', 'changedBy:id,name'])
            ->whereBetween('attendance_date', [$startDate->toDateString(), $endDate->toDateString()])
            ->when($validated['user_id'] ?? null, fn ($query, int $userId) => $query->where('user_id', $userId))
            ->orderByDesc('changed_at')
            ->orderByDesc('id')
            ->limit(250)
            ->get()
            ->map(fn (ManualAttendanceAudit $audit) => [
                'id' => $audit->id,
                'attendance_date' => $audit->attendance_date->toDateString(),
                'employee_name' => $audit->user?->name ?? 'Deleted user',
                'employee_designation' => $audit->user?->designation ?? 'Member',
                'old_status_code' => $audit->old_status_code,
                'old_status_label' => $this->statusLabel($audit->old_status_code),
                'new_status_code' => $audit->new_status_code,
                'new_status_label' => $this->statusLabel($audit->new_status_code),
                'changed_by' => $audit->changedBy?->name ?? 'System',
                'changed_at' => $audit->changed_at
                    ? $audit->changed_at->copy()->setTimezone('Asia/Karachi')->format('Y-m-d g:i A')
                    : null,
                'reason' => $audit->reason,
            ]);

        $bulkActions = ! AttendanceBulkAction::available() ? collect() : AttendanceBulkAction::query()
            ->with('changedBy:id,name')
            ->whereDate('start_date', '<=', $endDate->toDateString())
            ->whereDate('end_date', '>=', $startDate->toDateString())
            ->latest('id')
            ->limit(25)
            ->get()
            ->map(fn (AttendanceBulkAction $action) => [
                'id' => $action->id,
                'changed_by' => $action->changedBy?->name ?? 'System',
                'status_label' => $action->operation === 'clear' ? 'Removed marks' : $this->statusLabel($action->status_code),
                'people' => $action->people_count,
                'days' => $action->days_count,
                'cells' => $action->cells_count,
                'range' => $action->start_date->isSameDay($action->end_date)
                    ? $action->start_date->format('D j M')
                    : $action->start_date->format('D j M').' to '.$action->end_date->format('D j M'),
                'changed_at' => $action->created_at?->copy()->setTimezone('Asia/Karachi')->format('j M g:i A'),
                'undone' => (bool) $action->undone_at,
            ]);

        return response()->json([
            'month' => $month,
            'history' => $history,
            'bulk_actions' => $bulkActions,
        ]);
    }

    public function sendSlack(Request $request, AttendanceSlackReportService $slack)
    {
        $validated = $request->validate([
            'month' => ['required', 'date_format:Y-m'],
            'user_ids' => ['required', 'array', 'min:1'],
            'user_ids.*' => ['integer', 'exists:users,id'],
            'include_fields' => ['required', 'array', 'min:1'],
            'include_fields.*' => [
                'string',
                Rule::in([
                    'present',
                    'absent',
                    'leave',
                    'half_day',
                    'work_from_home',
                    'late_coming',
                    'late_joining',
                    'holidays',
                    'public_holiday',
                    'total_work_hours',
                ]),
            ],
        ]);

        try {
            $summary = $slack->sendMonthly(
                $validated['month'],
                $validated['user_ids'],
                $validated['include_fields']
            );
        } catch (RuntimeException $exception) {
            throw ValidationException::withMessages([
                'slack' => $exception->getMessage(),
            ]);
        }

        return response()->json([
            'message' => "Attendance report sent to Slack for {$summary['month']}.",
        ]);
    }

    /**
     * Get summary view data
     */
    public function getSummary(Request $request)
    {
        $date = Carbon::parse($request->input('date', Carbon::today('Asia/Karachi')->toDateString()), 'Asia/Karachi')->toDateString();

        $entriesByUser = $this->entriesForDateByUser($date);

        // Live summary view: only iterate active staff. Deactivated users with no
        // entries are already skipped (the null-on-empty filter below), and their
        // historical day entries remain queryable by explicit user id elsewhere.
        $employees = \App\Support\ShiftFilter::apply(User::active()->with('shift:id,name'), $request)->orderBy('name')->get()->map(function ($employee) use ($entriesByUser) {
            $entries = $entriesByUser->get($employee->id, collect());

            if ($entries->isEmpty()) {
                return null;
            }

            $stats = $this->calculateTimeStats($entries);

            // Get first clock in time
            $firstClockIn = $entries->where('action_type', 'clock_in')->first();

            // Get last action
            $lastEntry = $entries->last();

            return [
                'user_id' => $employee->id,
                'user_name' => $employee->name,
                'avatar' => $employee->avatar_url ?? null,
                'designation' => $employee->designation ?? 'Employee',
                'shift_name' => $employee->shift_name,
                'total_work_hours' => $stats['workHours'],
                'total_break_hours' => $stats['breakHours'],
                'current_status' => $stats['status'],
                'first_clock_in' => $firstClockIn ? $firstClockIn->formatted_action_time : null,
                'last_action_time' => $lastEntry ? $lastEntry->formatted_action_time : null,
                'clock_in_via' => \App\Support\ClockSource::label($firstClockIn?->clock_source),
                'clock_out_via' => \App\Support\ClockSource::label($entries->where('action_type', 'clock_out')->last()?->clock_source),
                'total_entries' => $entries->count(),
            ];
        })->filter()->values();

        return response()->json([
            'employees' => $employees,
        ]);
    }

    /**
     * Get detailed activity view data
     */
    public function getDetailed(Request $request)
    {
        $date = Carbon::parse($request->input('date', Carbon::today('Asia/Karachi')->toDateString()), 'Asia/Karachi')->toDateString();

        $entriesByUser = $this->entriesForDateByUser($date);

        // Live detailed view iterates active staff only (deactivated users are
        // hidden going forward); empty-entry users are dropped below.
        $activities = \App\Support\ShiftFilter::apply(User::active()->with('shift:id,name'), $request)->orderBy('name')->get()->map(function ($employee) use ($entriesByUser) {
            $entries = $entriesByUser->get($employee->id, collect());

            if ($entries->isEmpty()) {
                return null;
            }

            return [
                'user_id' => $employee->id,
                'user_name' => $employee->name,
                'avatar' => $employee->avatar_url ?? null,
                'designation' => $employee->designation ?? 'Employee',
                'shift_name' => $employee->shift_name,
                'entries' => $entries->map(function ($entry) {
                    return [
                        'id' => $entry->id,
                        'action_type' => $entry->action_type,
                        // Pre-formatted (Karachi) for back-compat; action_iso is the
                        // canonical instant so the client can render it in the
                        // viewer's chosen display timezone.
                        'formatted_time' => $entry->formatted_action_time,
                        'action_iso' => $entry->action_timestamp
                            ? Carbon::parse($entry->action_timestamp)->toISOString()
                            : null,
                        'notes' => $entry->notes,
                        'source_label' => \App\Support\ClockSource::label($entry->clock_source),
                    ];
                }),
            ];
        })->filter()->values();

        return response()->json([
            'activities' => $activities,
        ]);
    }

    /**
     * Get timeline view data
     */
    public function getTimeline(Request $request)
    {
        $date = Carbon::parse($request->input('date', Carbon::today('Asia/Karachi')->toDateString()), 'Asia/Karachi')->toDateString();

        $entriesByUser = $this->entriesForDateByUser($date);

        // Live timeline view iterates active staff only; empty-entry users are
        // dropped below.
        $timelines = \App\Support\ShiftFilter::apply(User::active()->with('shift:id,name'), $request)->orderBy('name')->get()->map(function ($employee) use ($entriesByUser) {
            $entries = $entriesByUser->get($employee->id, collect());

            if ($entries->isEmpty()) {
                return null;
            }

            $stats = $this->calculateTimeStats($entries);
            $sessions = $this->buildSessions($entries);

            return [
                'user_id' => $employee->id,
                'user_name' => $employee->name,
                'avatar' => $employee->avatar_url ?? null,
                'designation' => $employee->designation ?? 'Employee',
                'shift_name' => $employee->shift_name,
                'total_work_hours' => $stats['workHours'],
                'total_break_hours' => $stats['breakHours'],
                'sessions' => $sessions,
            ];
        })->filter()->values();

        return response()->json([
            'timelines' => $timelines,
        ]);
    }

    /**
     * Export attendance data as CSV
     */
    public function export(Request $request)
    {
        $date = Carbon::parse($request->input('date', Carbon::today('Asia/Karachi')->toDateString()), 'Asia/Karachi')->toDateString();

        $csv = "Employee,Designation,Status,Work Hours,Break Hours,First Clock In,Last Action,Total Actions\n";

        $entriesByUser = $this->entriesForDateByUser($date);
        // Live export iterates active staff only; empty-entry users are skipped below.
        $employees = User::active()->orderBy('name')->get();

        foreach ($employees as $employee) {
            $entries = $entriesByUser->get($employee->id, collect());

            if ($entries->isEmpty()) {
                continue;
            }

            $stats = $this->calculateTimeStats($entries);
            $firstClockIn = $entries->where('action_type', 'clock_in')->first();
            $lastEntry = $entries->last();

            $csv .= implode(',', [
                '"'.$employee->name.'"',
                '"'.($employee->designation ?? 'Employee').'"',
                '"'.$stats['status'].'"',
                number_format($stats['workHours'], 2),
                number_format($stats['breakHours'], 2),
                '"'.($firstClockIn ? $firstClockIn->formatted_action_time : '-').'"',
                '"'.($lastEntry ? $lastEntry->formatted_action_time : '-').'"',
                $entries->count(),
            ])."\n";

            // Add detailed entries
            $csv .= "\nDetailed Activity:\n";
            $csv .= "Time,Action,Notes\n";
            foreach ($entries as $entry) {
                $csv .= implode(',', [
                    '"'.$entry->formatted_action_time.'"',
                    '"'.str_replace('_', ' ', ucwords($entry->action_type)).'"',
                    '"'.($entry->notes ?? '').'"',
                ])."\n";
            }
            $csv .= "\n";
        }

        return response($csv)
            ->header('Content-Type', 'text/csv')
            ->header('Content-Disposition', 'attachment; filename="employee-attendance-'.$date.'.csv"');
    }

    /**
     * One whereIn fetch for every employee's entries on an attendance day,
     * keyed by user — the per-employee lazy queries were a 55-query N+1 on
     * each tab switch. action_date is stamped by attendanceDateFor() at
     * clock time, so all tabs share the same shift-anchored bucketing.
     *
     * @return \Illuminate\Support\Collection
     */
    private function entriesForDateByUser(string $date)
    {
        return TimeEntry::query()
            ->whereDate('action_date', $date)
            ->orderBy('action_timestamp')
            ->get()
            ->groupBy('user_id');
    }

    /**
     * Calculate time statistics from entries
     */
    // calculateTimeStats() now lives in the shared CalculatesTimeStats trait
    // (used here and by TimeEntryController).

    /**
     * Build work and break sessions from entries
     */
    private function buildSessions($entries)
    {
        $sessions = [];
        $currentWorkStart = null;
        $currentBreakStart = null;

        foreach ($entries as $entry) {
            $entryTime = Carbon::parse($entry->action_timestamp)->setTimezone('Asia/Karachi');

            switch ($entry->action_type) {
                case 'clock_in':
                    $currentWorkStart = $entryTime;
                    break;

                case 'clock_out':
                    if ($currentWorkStart) {
                        $durationMinutes = $this->positiveMinutesBetween($currentWorkStart, $entryTime);
                        $sessions[] = [
                            'type' => 'work',
                            'start_time' => $currentWorkStart->format('g:i A'),
                            'end_time' => $entryTime->format('g:i A'),
                            'duration' => $this->formatDuration($durationMinutes),
                        ];
                        $currentWorkStart = null;
                    }
                    break;

                case 'break_start':
                    $currentBreakStart = $entryTime;
                    break;

                case 'break_end':
                    if ($currentBreakStart) {
                        $durationMinutes = $this->positiveMinutesBetween($currentBreakStart, $entryTime);
                        $sessions[] = [
                            'type' => 'break',
                            'start_time' => $currentBreakStart->format('g:i A'),
                            'end_time' => $entryTime->format('g:i A'),
                            'duration' => $this->formatDuration($durationMinutes),
                        ];
                        $currentBreakStart = null;
                    }
                    break;
            }
        }

        $now = Carbon::now('Asia/Karachi');

        // Show the ongoing session unless it's a stale orphaned clock-in.
        // The old same-calendar-day check made a night shift's running
        // session vanish from this tab at midnight; the 18h cap mirrors
        // calculateTimeStats so the visible session matches the hours.
        if ($currentWorkStart) {
            $durationMinutes = $this->positiveMinutesBetween($currentWorkStart, $now);
            if ($durationMinutes <= 18 * 60) {
                $sessions[] = [
                    'type' => 'work',
                    'start_time' => $currentWorkStart->format('g:i A'),
                    'end_time' => null,
                    'duration' => $this->formatDuration($durationMinutes).' (ongoing)',
                ];
            }
        }

        if ($currentBreakStart) {
            $durationMinutes = $this->positiveMinutesBetween($currentBreakStart, $now);
            if ($durationMinutes <= 18 * 60) {
                $sessions[] = [
                    'type' => 'break',
                    'start_time' => $currentBreakStart->format('g:i A'),
                    'end_time' => null,
                    'duration' => $this->formatDuration($durationMinutes).' (ongoing)',
                ];
            }
        }

        return $sessions;
    }

    // positiveMinutesBetween() now lives in the shared CalculatesTimeStats trait.

    private function resolveMonthlyStatus(
        User $employee,
        Carbon $date,
        $entries,
        ?ManualAttendanceMark $manualMark,
        Carbon $now,
        Carbon $today,
        ?TimeEntry $firstClockIn,
        ?string $holidayCode = null
    ): array {
        return \App\Support\AttendanceStatus::resolve($employee, $date, $manualMark, $now, $today, $firstClockIn, 'Asia/Karachi', $holidayCode);
    }

    private function addStatusToSummary(array &$summary, ?string $statusCode, float|int $workHours): void
    {
        \App\Support\AttendanceStatus::addToSummary($summary, $statusCode, $workHours);
    }

    private function isBeforeJoiningDate(User $employee, Carbon $date): bool
    {
        return \App\Support\AttendanceStatus::isBeforeJoiningDate($employee, $date);
    }


    private function canManuallyMarkAttendance(?User $user): bool
    {
        return (bool) $user && (
            $user->isSuperAdmin()
            || $user->hasPermission('attendance.manual_mark')
        );
    }

    private function canEditClockTimes(?User $user): bool
    {
        return (bool) $user && $user->hasPermission('attendance.edit_times');
    }

    private function recordManualAttendanceAudit(
        int $userId,
        string $attendanceDate,
        ?string $oldStatusCode,
        ?string $newStatusCode,
        ?int $changedByUserId,
        ?string $reason,
        ?int $bulkActionId = null,
        ?string $oldNote = null
    ): void {
        $bulkFields = AttendanceBulkAction::available() ? ['bulk_action_id' => $bulkActionId, 'old_note' => $oldNote] : [];

        ManualAttendanceAudit::create($bulkFields + [
            'user_id' => $userId,
            'attendance_date' => $attendanceDate,
            'old_status_code' => $oldStatusCode,
            'new_status_code' => $newStatusCode,
            'changed_by_user_id' => $changedByUserId,
            'changed_at' => Carbon::now('Asia/Karachi'),
            'reason' => $reason,
        ]);
    }

    private function statusLabel(?string $statusCode): string
    {
        if (! $statusCode) {
            return 'Auto';
        }

        return self::ATTENDANCE_STATUSES[$statusCode] ?? $statusCode;
    }

    private function formatDuration(int $durationMinutes)
    {
        $hours = intdiv($durationMinutes, 60);
        $minutes = $durationMinutes % 60;

        if ($hours > 0) {
            return "{$hours}h {$minutes}m";
        }

        return "{$minutes}m";
    }
}
