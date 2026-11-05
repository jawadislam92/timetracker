<?php

namespace App\Services;

use App\Models\CompanyHoliday;
use App\Models\ManualAttendanceMark;
use App\Models\TimeEntry;
use App\Models\User;
use App\Services\Concerns\FormatsSlackBlocks;
use App\Support\AttendanceHours;
use Carbon\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Http;
use RuntimeException;
use Throwable;

class AttendanceSlackReportService
{
    use FormatsSlackBlocks;

    private const MAX_TABLE_DATA_ROWS = 98;

    public function configured(): bool
    {
        return filled(config('services.slack_reports.webhook_url'));
    }

    public function sendMonthly(string $month, array $userIds, array $includeFields): array
    {
        if (! $this->configured()) {
            throw new RuntimeException('Slack reporting is not configured.');
        }

        $startDate = Carbon::createFromFormat('Y-m-d', "{$month}-01", config('services.slack_reports.timezone'))->startOfDay();
        $endDate = $startDate->copy()->endOfMonth();
        $now = Carbon::now(config('services.slack_reports.timezone'));
        $today = $now->copy()->startOfDay();
        $includeFields = array_values(array_intersect($includeFields, [
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
        ]));

        if ($includeFields === []) {
            $includeFields = ['present', 'absent', 'leave', 'half_day', 'work_from_home', 'late_coming', 'late_joining'];
        }

        $users = User::query()
            ->whereIn('id', $userIds)
            ->with(User::shiftEagerLoads())
            ->orderBy('name')
            ->get(['id', 'name', 'joining_date', 'shift_start_time', 'shift_grace_minutes', 'shift_hours']);

        $entriesByUserDate = TimeEntry::query()
            ->whereIn('user_id', $users->pluck('id'))
            ->whereBetween('action_date', [$startDate->toDateString(), $endDate->toDateString()])
            ->orderBy('action_timestamp')
            ->get()
            ->groupBy(fn (TimeEntry $entry) => $entry->user_id.'|'.$entry->action_date->toDateString());

        $manualMarks = ManualAttendanceMark::query()
            ->whereIn('user_id', $users->pluck('id'))
            ->whereBetween('attendance_date', [$startDate->toDateString(), $endDate->toDateString()])
            ->get()
            ->keyBy(fn (ManualAttendanceMark $mark) => $mark->user_id.'|'.$mark->attendance_date->toDateString());

        $holidays = CompanyHoliday::between($startDate, $endDate);

        $rows = $users->map(function (User $user) use ($startDate, $endDate, $now, $today, $entriesByUserDate, $manualMarks, $holidays, $includeFields) {
            $summary = $this->emptySummary();

            for ($date = $startDate->copy(); $date->lte($endDate); $date->addDay()) {
                $key = $user->id.'|'.$date->toDateString();
                $entries = $entriesByUserDate->get($key, collect());
                $manualMark = $manualMarks->get($key);
                $statusCode = $this->statusForDate($user, $date, $entries, $manualMark, $now, $today, ($holidays[$date->toDateString()] ?? null)?->status_code);

                if ($statusCode) {
                    $this->addStatusToSummary($summary, $statusCode);
                }

                $summary['total_work_hours'] += $entries->isNotEmpty()
                    ? $this->calculateWorkHours($entries)
                    : 0;
            }

            $row = ['user' => $user->name];

            foreach ($includeFields as $field) {
                $row[$field] = $field === 'total_work_hours'
                    ? $this->formatHours($summary[$field])
                    : (string) $summary[$field];
            }

            return $row;
        })->values();

        $columns = array_merge(['user'], $includeFields);
        $visibleRows = $rows->take(self::MAX_TABLE_DATA_ROWS);
        $omittedRows = max(0, $rows->count() - $visibleRows->count());
        $tableRows = collect([
            collect($columns)
                ->map(fn (string $column) => $this->tableBoldCell($this->fieldLabel($column)))
                ->all(),
        ]);

        $visibleRows->each(function (array $row) use ($columns, $tableRows) {
            $tableRows->push(
                collect($columns)
                    ->map(fn (string $column) => $this->tableTextCell($row[$column] ?? '-'))
                    ->all()
            );
        });

        $period = $startDate->format('F Y');
        $contextParts = [
            sprintf('*Users:* %d', $users->count()),
        ];

        if ($omittedRows > 0) {
            $contextParts[] = sprintf('*%d additional rows omitted*', $omittedRows);
        }

        $payload = [
            'text' => "Attendance Report | {$period} | {$users->count()} users",
            'blocks' => [
                [
                    'type' => 'header',
                    'text' => [
                        'type' => 'plain_text',
                        'text' => 'Attendance Report',
                    ],
                ],
                [
                    'type' => 'section',
                    'text' => [
                        'type' => 'mrkdwn',
                        'text' => "*Month:* {$period}",
                    ],
                ],
                [
                    'type' => 'table',
                    'column_settings' => collect($columns)
                        ->map(fn (string $column) => [
                            'align' => $column === 'user' ? 'left' : 'right',
                            'is_wrapped' => $column === 'user',
                        ])
                        ->all(),
                    'rows' => $tableRows->all(),
                ],
                [
                    'type' => 'context',
                    'elements' => [[
                        'type' => 'mrkdwn',
                        'text' => implode(' | ', $contextParts),
                    ]],
                ],
            ],
        ];

        try {
            $response = Http::asJson()
                ->timeout(10)
                ->retry(2, 250)
                ->post(config('services.slack_reports.webhook_url'), $payload);
        } catch (Throwable) {
            throw new RuntimeException('The app could not connect to Slack.');
        }

        if ($response->failed()) {
            throw new RuntimeException('Slack did not accept the attendance report.');
        }

        return [
            'month' => $period,
            'user_count' => $users->count(),
        ];
    }

    private function emptySummary(): array
    {
        return [
            'present' => 0,
            'absent' => 0,
            'leave' => 0,
            'half_day' => 0,
            'work_from_home' => 0,
            'late_coming' => 0,
            'late_joining' => 0,
            'holidays' => 0,
            'public_holiday' => 0,
            'total_work_hours' => 0,
        ];
    }

    private function statusForDate(
        User $user,
        Carbon $date,
        Collection $entries,
        ?ManualAttendanceMark $manualMark,
        Carbon $now,
        Carbon $today,
        ?string $holidayCode = null
    ): ?string {
        if ($manualMark) {
            return $manualMark->status_code;
        }

        if ($holidayCode && $entries->where('action_type', 'clock_in')->isEmpty() && ! $this->isBeforeJoiningDate($user, $date)) {
            return $holidayCode;
        }

        if ($date->isFuture() && ! $date->isSameDay($today)) {
            return null;
        }

        if ($this->isBeforeJoiningDate($user, $date)) {
            return 'LI';
        }

        $firstClockIn = $entries->where('action_type', 'clock_in')->first();

        if ($firstClockIn) {
            return AttendanceHours::isLateClockIn($user, $date, $firstClockIn, config('services.slack_reports.timezone')) ? 'LC' : 'P';
        }

        if ($date->isSunday()) {
            return 'H';
        }

        return $date->isSameDay($today) && ! AttendanceHours::isShiftAbsenceDue($user, $date, $now, config('services.slack_reports.timezone'))
            ? null
            : 'A';
    }


    private function addStatusToSummary(array &$summary, string $statusCode): void
    {
        if ($statusCode === 'LC') {
            $summary['present']++;
            $summary['late_coming']++;

            return;
        }

        if ($statusCode === 'LI') {
            $summary['late_joining']++;

            return;
        }

        match ($statusCode) {
            'P' => $summary['present']++,
            'A' => $summary['absent']++,
            'L' => $summary['leave']++,
            'HD' => $summary['half_day']++,
            'WFH' => $summary['work_from_home']++,
            'H' => $summary['holidays']++,
            'PH' => $summary['public_holiday']++,
            default => null,
        };
    }

    private function isBeforeJoiningDate(User $user, Carbon $date): bool
    {
        if (! $user->joining_date) {
            return false;
        }

        return $date->toDateString() < $user->joining_date->toDateString();
    }

    private function calculateWorkHours(Collection $entries): float
    {
        $totalWorkMinutes = 0;
        $totalBreakMinutes = 0;
        $currentSessionStart = null;
        $currentBreakStart = null;

        foreach ($entries as $entry) {
            $entryTime = Carbon::parse($entry->action_timestamp)->setTimezone(config('services.slack_reports.timezone'));

            if ($entry->action_type === 'clock_in') {
                $currentSessionStart = $entryTime;
            } elseif ($entry->action_type === 'clock_out' && $currentSessionStart) {
                $totalWorkMinutes += max(0, (int) floor($currentSessionStart->diffInMinutes($entryTime, false)));
                $currentSessionStart = null;
            } elseif ($entry->action_type === 'break_start') {
                $currentBreakStart = $entryTime;
            } elseif ($entry->action_type === 'break_end' && $currentBreakStart) {
                $totalBreakMinutes += max(0, (int) floor($currentBreakStart->diffInMinutes($entryTime, false)));
                $currentBreakStart = null;
            }
        }

        return round(max(0, $totalWorkMinutes - $totalBreakMinutes) / 60, 2);
    }

    private function fieldLabel(string $field): string
    {
        return match ($field) {
            'user' => 'User',
            'present' => 'Present',
            'absent' => 'Absent',
            'leave' => 'Leave',
            'half_day' => 'Half Day',
            'work_from_home' => 'WFH',
            'late_coming' => 'Late Coming',
            'late_joining' => 'Late Joining',
            'holidays' => 'Holidays',
            'public_holiday' => 'Public Holiday',
            'total_work_hours' => 'Hours',
            default => ucfirst($field),
        };
    }

}
