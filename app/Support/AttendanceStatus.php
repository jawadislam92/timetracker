<?php

namespace App\Support;

use App\Models\ManualAttendanceMark;
use App\Models\TimeEntry;
use App\Models\User;
use Carbon\Carbon;

/**
 * The single place that decides what one employee-day IS (Present, Absent,
 * Late coming, Holiday…). Extracted from EmployeeAttendanceController so the
 * monthly grid and the read-only payroll export resolve every day identically.
 * Rule order: manual mark > company holiday (unless they clocked in or had not
 * joined yet) > future > before joining > clocked in (late or present) > Sunday
 * > today's shift not started > absent.
 */
class AttendanceStatus
{
    public const CODES = [
        'P' => 'Present',
        'A' => 'Absent',
        'H' => 'Holiday',
        'L' => 'Leave',
        'HD' => 'Half day',
        'WFH' => 'Work from home',
        'LC' => 'Late coming',
        'LI' => 'Late joining',
        'PH' => 'Public holiday',
    ];

    /**
     * @return array{code: ?string, label: string, source: string}
     */
    public static function resolve(
        User $employee,
        Carbon $date,
        ?ManualAttendanceMark $manualMark,
        Carbon $now,
        Carbon $today,
        ?TimeEntry $firstClockIn,
        string $timezone = 'Asia/Karachi',
        ?string $holidayCode = null,
    ): array {
        if ($manualMark) {
            return [
                'code' => $manualMark->status_code,
                'label' => self::CODES[$manualMark->status_code] ?? $manualMark->status_code,
                'source' => 'manual',
            ];
        }

        if ($holidayCode && ! $firstClockIn && ! self::isBeforeJoiningDate($employee, $date)) {
            return ['code' => $holidayCode, 'label' => self::CODES[$holidayCode] ?? $holidayCode, 'source' => 'automatic'];
        }

        if ($date->isFuture() && ! $date->isSameDay($today)) {
            return ['code' => null, 'label' => 'Not set', 'source' => 'future'];
        }

        if (self::isBeforeJoiningDate($employee, $date)) {
            return ['code' => 'LI', 'label' => self::CODES['LI'], 'source' => 'automatic'];
        }

        if ($firstClockIn) {
            if (AttendanceHours::isLateClockIn($employee, $date, $firstClockIn, $timezone)) {
                return ['code' => 'LC', 'label' => self::CODES['LC'], 'source' => 'automatic'];
            }

            return ['code' => 'P', 'label' => self::CODES['P'], 'source' => 'automatic'];
        }

        if ($date->isSunday()) {
            return ['code' => 'H', 'label' => self::CODES['H'], 'source' => 'automatic'];
        }

        if ($date->isSameDay($today) && ! AttendanceHours::isShiftAbsenceDue($employee, $date, $now, $timezone)) {
            return ['code' => null, 'label' => 'Shift not started', 'source' => 'pending'];
        }

        return ['code' => 'A', 'label' => self::CODES['A'], 'source' => 'automatic'];
    }

    public static function isBeforeJoiningDate(User $employee, Carbon $date): bool
    {
        if (! $employee->joining_date) {
            return false;
        }

        return $date->toDateString() < $employee->joining_date->toDateString();
    }

    /**
     * Minutes between the shift start and the first clock-in for a day the grid
     * marked Late coming. The grid never stored this; it is measured from the
     * shift START (not start + grace) so "15 minutes late" reads naturally.
     */
    public static function lateMinutes(User $employee, Carbon $date, ?TimeEntry $firstClockIn, string $timezone = 'Asia/Karachi'): int
    {
        if (! $firstClockIn) {
            return 0;
        }
        $localDate = $date->copy()->setTimezone($timezone);
        $shift = $employee->effectiveShiftFor($localDate->toDateString());
        if (! $shift['start_time']) {
            return 0;
        }
        $shiftStart = $localDate->copy()->setTimeFromTimeString($shift['start_time']->format('H:i:s'));
        $clockIn = Carbon::parse($firstClockIn->action_timestamp)->setTimezone($timezone);

        return max(0, (int) floor($shiftStart->diffInMinutes($clockIn, false)));
    }

    public static function addToSummary(array &$summary, ?string $statusCode, float|int $workHours): void
    {
        $summary['total_work_hours'] += (float) $workHours;

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
            'H' => $summary['holidays']++,
            'L' => $summary['leave']++,
            'HD' => $summary['half_day']++,
            'WFH' => $summary['work_from_home']++,
            'PH' => $summary['public_holiday']++,
            default => null,
        };
    }
}
