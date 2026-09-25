<?php

namespace App\Services;

use App\Models\ManualAttendanceMark;
use App\Models\TimeEntry;
use App\Models\TrackingSession;
use App\Models\User;
use App\Support\AttendanceHours;
use App\Support\AttendanceStatus;
use Carbon\Carbon;
use Illuminate\Support\Collection;

/**
 * Read-only export for the payroll app. Nothing here writes. Day statuses come
 * from AttendanceStatus::resolve() (the same function the monthly grid uses),
 * in-office time from AttendanceHours::dayInOfficeHours() (same as the grid),
 * tracked time from TrackingSessionService::inDaySeconds() over the person's
 * shift work-day window (same as Timeline/Team).
 */
class PayrollExportService
{
    private const TZ = 'Asia/Karachi';

    public function __construct(private TrackingSessionService $sessions) {}

    public function users(): array
    {
        $today = Carbon::today(self::TZ)->toDateString();

        return User::query()
            ->with(array_merge(['shift:id,name'], User::shiftEagerLoads()))
            ->orderBy('name')
            ->get()
            ->map(function (User $u) use ($today) {
                $shift = $u->effectiveShiftFor($today);

                return [
                    'id' => $u->id,
                    'name' => $u->name,
                    'email' => $u->email,
                    'designation' => $u->designation,
                    'role' => $u->role,
                    'is_active' => $u->isActive(),
                    'tracks_time' => (bool) ($u->tracks_time ?? true),
                    'joining_date' => $u->joining_date?->toDateString(),
                    'work_timezone' => $u->workTimezone(),
                    'shift_name' => $u->shift_name,
                    'shift_start' => $shift['start_time']?->format('H:i'),
                    'shift_hours' => $shift['hours'],
                    'shift_grace_minutes' => $shift['grace_minutes'],
                ];
            })
            ->values()
            ->all();
    }

    /**
     * @param  int[]|null  $userIds  null = every user
     */
    public function attendance(string $month, ?array $userIds = null): array
    {
        $startDate = Carbon::createFromFormat('Y-m-d', "{$month}-01", self::TZ)->startOfDay();
        $endDate = $startDate->copy()->endOfMonth();
        $now = Carbon::now(self::TZ);
        $today = $now->copy()->startOfDay();

        $dates = collect(range(1, $endDate->day))->map(fn (int $d) => $startDate->copy()->day($d));

        $usersQuery = User::query()->with(array_merge(['shift:id,name'], User::shiftEagerLoads()))->orderBy('name');
        if ($userIds !== null) {
            $usersQuery->whereIn('id', $userIds);
        }
        $users = $usersQuery->get();
        $ids = $users->pluck('id')->all();

        $entriesByUserDate = TimeEntry::query()
            ->whereIn('user_id', $ids)
            ->whereBetween('action_date', [$startDate->toDateString(), $endDate->toDateString()])
            ->orderBy('action_timestamp')
            ->get()
            ->groupBy(fn (TimeEntry $e) => $e->user_id.'|'.$e->action_date->toDateString());

        $marks = ManualAttendanceMark::query()
            ->whereIn('user_id', $ids)
            ->whereBetween('attendance_date', [$startDate->toDateString(), $endDate->toDateString()])
            ->get()
            ->keyBy(fn (ManualAttendanceMark $m) => $m->user_id.'|'.$m->attendance_date->toDateString());

        // One query for the month's sessions (a day before and after, for
        // overnight spill), then each day takes its wall-clock share.
        $sessionsByUser = TrackingSession::query()
            ->whereIn('user_id', $ids)
            ->where('started_at', '<', $endDate->copy()->addDay())
            ->where(fn ($q) => $q->whereNull('stopped_at')->orWhere('stopped_at', '>', $startDate->copy()->subDay()))
            ->where(fn ($q) => $q->where('total_seconds', '>=', 60)->orWhere('status', 'active'))
            ->orderBy('started_at')
            ->get()
            ->groupBy('user_id');

        $out = $users->map(function (User $user) use ($dates, $entriesByUserDate, $marks, $sessionsByUser, $now, $today) {
            $summary = ['present' => 0, 'absent' => 0, 'leave' => 0, 'half_day' => 0, 'work_from_home' => 0, 'late_coming' => 0, 'late_joining' => 0, 'holidays' => 0, 'public_holiday' => 0, 'total_work_hours' => 0];
            $userSessions = $sessionsByUser->get($user->id, collect());

            $days = $dates->map(function (Carbon $date) use ($user, $entriesByUserDate, $marks, $userSessions, $now, $today, &$summary) {
                $key = $user->id.'|'.$date->toDateString();
                $entries = $entriesByUserDate->get($key, collect());
                $mark = $marks->get($key);
                $firstClockIn = $entries->firstWhere('action_type', 'clock_in');
                $lastClockOut = $entries->where('action_type', 'clock_out')->last();

                $status = AttendanceStatus::resolve($user, $date, $mark, $now, $today, $firstClockIn, self::TZ);
                $inOfficeHours = $entries->isNotEmpty() ? AttendanceHours::dayInOfficeHours($entries) : 0.0;
                AttendanceStatus::addToSummary($summary, $status['code'], $inOfficeHours);

                $late = $status['code'] === 'LC';
                $lateMinutes = $late ? AttendanceStatus::lateMinutes($user, $date, $firstClockIn, self::TZ) : 0;

                return [
                    'date' => $date->toDateString(),
                    'code' => $status['code'],
                    'label' => $status['label'],
                    'source' => $status['source'],
                    'late' => $late,
                    'late_minutes' => $lateMinutes,
                    'first_clock_in' => $firstClockIn?->action_timestamp?->toIso8601String(),
                    'last_clock_out' => $lastClockOut?->action_timestamp?->toIso8601String(),
                    'in_office_seconds' => (int) round($inOfficeHours * 3600),
                    'tracked_seconds' => $this->trackedSecondsFor($user, $date, $userSessions),
                    'note' => $mark?->note,
                ];
            })->values();

            $summary['total_work_hours'] = round($summary['total_work_hours'], 2);

            return [
                'id' => $user->id,
                'name' => $user->name,
                'is_active' => $user->isActive(),
                'work_timezone' => $user->workTimezone(),
                'days' => $days,
                'summary' => $summary,
            ];
        })->values();

        return [
            'month' => $month,
            'timezone' => self::TZ,
            'today' => $today->toDateString(),
            'generated_at' => $now->toIso8601String(),
            'codes' => AttendanceStatus::CODES,
            'users' => $out->all(),
        ];
    }

    /** Tracked seconds inside this person's shift work-day window for the date. */
    private function trackedSecondsFor(User $user, Carbon $date, Collection $userSessions): int
    {
        if ($userSessions->isEmpty()) {
            return 0;
        }

        $shift = $user->effectiveShiftFor($date->toDateString());
        $tz = $shift['timezone'] ?: $user->workTimezone();
        $anchor = $shift['start_time']
            ? Carbon::parse($date->toDateString().' '.$shift['start_time']->format('H:i:s'), $tz)
            : Carbon::parse($date->toDateString().' 12:00:00', $tz);
        [$winStart, $winEnd] = $user->attendanceDayWindowFor($anchor);

        $total = 0;
        foreach ($userSessions as $session) {
            $total += $this->sessions->inDaySeconds($session, $winStart, $winEnd);
        }

        return $total;
    }
}
