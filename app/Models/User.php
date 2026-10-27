<?php

namespace App\Models;

// use Illuminate\Contracts\Auth\MustVerifyEmail;
use Carbon\Carbon;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\HasApiTokens;

class User extends Authenticatable
{
    use HasApiTokens, HasFactory, Notifiable;

    /**
     * The attributes that are mass assignable.
     *
     * @var array<int, string>
     */
    protected $fillable = [
        'name',
        'email',
        'password',
        'role',
        'permissions',
        'include_in_slack_reports',
        'avatar',
        'designation',
        'joining_date',
        'shift_id',
        'shift_start_time',
        'shift_grace_minutes',
        'work_timezone',
        'shift_hours',
        'clockout_reminder_minutes',
        'allow_multiple_devices',
        'tracks_time',
        'is_active',
    ];

    /**
     * The attributes that should be hidden for serialization.
     *
     * @var array<int, string>
     */
    protected $hidden = [
        'password',
        'remember_token',
        'permissions',
        'summary_layout',
    ];

    /**
     * Serialized users always carry a resolvable avatar URL; the raw path is
     * only meaningful server-side (the avatars disk may be local or S3).
     *
     * @var array<int, string>
     */
    protected $appends = [
        'avatar_url',
    ];

    /**
     * The attributes that should be cast.
     *
     * @var array<string, string>
     */
    protected $casts = [
        'email_verified_at' => 'datetime',
        'password' => 'hashed',
        'permissions' => 'array',
        'include_in_slack_reports' => 'boolean',
        'joining_date' => 'date',
        'shift_start_time' => 'datetime:H:i',
        'shift_grace_minutes' => 'integer',
        'shift_hours' => 'decimal:2',
        'clockout_reminder_minutes' => 'integer',
        'allow_multiple_devices' => 'boolean',
        'tracks_time' => 'boolean',
        'is_active' => 'boolean',
        'summary_layout' => 'array',
    ];

    const ROLES = [
        'super_admin' => 'Super Admin',
        'admin' => 'Admin',
        'member' => 'Member',
    ];

    public function isSuperAdmin(): bool
    {
        return $this->role === 'super_admin';
    }

    public function hasPermission(string $permission): bool
    {
        if ($this->isSuperAdmin()) {
            return true;
        }

        return in_array($permission, $this->expandedPermissions(), true);
    }

    public function hasAnyPermission(array $permissions): bool
    {
        return $this->isSuperAdmin()
            || collect($permissions)->contains(fn (string $permission) => $this->hasPermission($permission));
    }

    public function effectivePermissions(): array
    {
        if ($this->isSuperAdmin()) {
            return collect(config('access.permissions'))
                ->flatMap(fn (array $group) => array_keys($group))
                ->values()
                ->all();
        }

        return $this->expandedPermissions();
    }

    public function getRoleLabelAttribute(): string
    {
        return self::ROLES[$this->role] ?? ucfirst(str_replace('_', ' ', $this->role));
    }

    private function expandedPermissions(): array
    {
        $validPermissions = collect(config('access.permissions'))
            ->flatMap(fn (array $group) => array_keys($group))
            ->all();
        $assigned = array_values(array_intersect($this->permissions ?? [], $validPermissions));

        $implications = [
            'users.manage' => ['users.view'],
            'users.delete' => ['users.view'],
            'clients.manage' => ['clients.view'],
            'clients.import_export' => ['clients.view'],
            'profiles.manage' => ['profiles.view'],
            'attendance.manual_mark' => ['attendance.view'],
            'attendance.edit_times' => ['attendance.view'],
            'attendance.export' => ['attendance.view'],
            'shift.manage_all' => ['attendance.view'],
            'reports.export' => ['reports.view'],
            'reports.send_slack' => ['reports.view'],
            'monitoring.manage' => ['monitoring.view'],
            'monitoring.view_screenshots' => ['monitoring.view'],
            'monitoring.delete_screenshots' => ['monitoring.view', 'monitoring.view_screenshots'],
            'monitoring.settings' => ['monitoring.view'],
            'timeline.view_others' => [],
        ];

        $expanded = $assigned;
        foreach ($assigned as $permission) {
            $expanded = array_merge($expanded, $implications[$permission] ?? []);
        }

        return array_values(array_unique($expanded));
    }

    /**
     * Get the avatar URL attribute.
     *
     * On S3 this is a short-lived signed URL (objects are private); on the
     * local disk it is the public /storage path.
     */
    public function getAvatarUrlAttribute()
    {
        if (! $this->avatar) {
            return null;
        }

        // Stable, cacheable proxy route (see AvatarController). The ?v hash
        // changes only when the avatar file changes, so the browser caches
        // each image for a week instead of re-fetching a fresh presigned S3
        // URL on every page render.
        return route('avatar.show', ['user' => $this->id, 'v' => substr(md5($this->avatar), 0, 8)]);
    }

    /**
     * Get the work hours for the user.
     */
    public function workHours()
    {
        return $this->hasMany(WorkHour::class);
    }

    /**
     * Get the time entries for the user.
     */
    public function timeEntries()
    {
        return $this->hasMany(TimeEntry::class);
    }

    /**
     * Clocking in up to this many minutes before a shift starts counts toward
     * that shift's attendance day. Without it, an early arrival for a shift
     * starting at/after midnight (e.g. 23:50 for a 00:00 shift) lands on the
     * previous calendar day and "disappears" when the date rolls over.
     */
    public const EARLY_CLOCK_IN_GRACE_MINUTES = 240;

    /**
     * The timezone this worker's day and shift are measured in (their home
     * country). This is the WORK timezone — it decides which attendance day a
     * punch belongs to, when the shift starts/ends, and when auto-close fires.
     * It is deliberately separate from the per-viewer DISPLAY timezone (how a
     * person reading the screen sees times). Defaults to the app timezone
     * (Asia/Karachi) so an unset worker behaves exactly as before.
     */
    public function workTimezone(): string
    {
        return $this->work_timezone ?: config('app.timezone', 'Asia/Karachi');
    }

    public function attendanceDateFor(Carbon $timestamp): string
    {
        $localTimestamp = $timestamp->copy()->setTimezone($this->workTimezone());
        $calendarDate = $localTimestamp->toDateString();

        // Effective shift start for the day this timestamp falls on (honours a
        // one-day override; falls back to the standing shift). With no shift set
        // at all, the attendance day is just the calendar day.
        $startTime = $this->effectiveShiftFor($calendarDate)['start_time'];
        if (! $startTime) {
            return $calendarDate;
        }

        $todayShiftStart = $localTimestamp->copy()->startOfDay()
            ->setTimeFromTimeString($startTime->format('H:i:s'));

        // Early arrival for the NEXT day's shift. Only reachable late in the
        // evening for shifts that start around midnight; day shifts never get
        // within the grace window of tomorrow's start. Measured against
        // tomorrow's own effective start in case it has its own override.
        $tomorrowStart = $this->effectiveShiftFor($localTimestamp->copy()->addDay()->toDateString())['start_time'] ?? $startTime;
        $tomorrowShiftStart = $localTimestamp->copy()->addDay()->startOfDay()
            ->setTimeFromTimeString($tomorrowStart->format('H:i:s'));
        $minutesUntilTomorrowStart = $localTimestamp->diffInMinutes($tomorrowShiftStart, false);

        if ($minutesUntilTomorrowStart >= 0 && $minutesUntilTomorrowStart <= self::EARLY_CLOCK_IN_GRACE_MINUTES) {
            return $tomorrowShiftStart->toDateString();
        }

        if ($localTimestamp->greaterThanOrEqualTo($todayShiftStart)) {
            return $calendarDate;
        }

        // Late-night spillover belonging to the previous day's shift.
        $previousStart = $this->effectiveShiftFor($localTimestamp->copy()->subDay()->toDateString())['start_time'] ?? $startTime;
        $previousShiftStart = $localTimestamp->copy()->subDay()->startOfDay()
            ->setTimeFromTimeString($previousStart->format('H:i:s'));
        $minutesSincePreviousStart = $previousShiftStart->diffInMinutes($localTimestamp, false);

        return $minutesSincePreviousStart >= 0 && $minutesSincePreviousStart <= 12 * 60
            ? $localTimestamp->copy()->subDay()->toDateString()
            : $calendarDate;
    }

    /**
     * The wall-clock window of the WORK day $now belongs to — the inverse of
     * attendanceDateFor(): every instant inside [start, end) buckets to the
     * same attendance date. Lets "today" surfaces (dashboard cards, desktop
     * today ring) count a night shift's post-midnight work on the same day as
     * its clock-in instead of resetting to zero at midnight mid-shift.
     *
     * Exact for a steady shift; on the rare day a shift override CHANGES the
     * start time across the boundary, the window approximates the dominant
     * (spillover) rule.
     *
     * @return array{0: Carbon, 1: Carbon} [start, end) in the work timezone
     */
    public function attendanceDayWindowFor(Carbon $now): array
    {
        $date = $this->attendanceDateFor($now);
        $nextDate = Carbon::parse($date, $this->workTimezone())->addDay()->toDateString();

        return [$this->workDayStartFor($date), $this->workDayStartFor($nextDate)];
    }

    /**
     * The instant attendance day $date begins, mirroring attendanceDateFor()'s
     * branches: a >12:00 shift's day starts when the previous day's 12-hour
     * spillover ends (e.g. a 16:00 shift's day runs 04:00 → 04:00); a shift
     * starting within the early grace of midnight opens the evening before;
     * everyone else gets plain midnight.
     */
    private function workDayStartFor(string $date): Carbon
    {
        $tz = $this->workTimezone();
        $dayStart = Carbon::parse($date, $tz)->startOfDay();

        $todayShift = $this->effectiveShiftFor($date)['start_time'];
        $previousShift = $this->effectiveShiftFor($dayStart->copy()->subDay()->toDateString())['start_time'] ?? $todayShift;

        // Previous day's late shift spills past midnight for up to 12 hours.
        $spillEnd = null;
        if ($previousShift) {
            $spillEnd = $dayStart->copy()->subDay()
                ->setTimeFromTimeString($previousShift->format('H:i:s'))
                ->addHours(12);
        }

        // A shift starting within the early-grace window after midnight opens
        // its day up to EARLY_CLOCK_IN_GRACE_MINUTES before the shift start
        // (i.e. late the previous evening) — but only when the previous day's
        // spillover doesn't reach past midnight.
        if ($todayShift && (! $spillEnd || $spillEnd->lessThanOrEqualTo($dayStart))) {
            $graceOpen = $dayStart->copy()
                ->setTimeFromTimeString($todayShift->format('H:i:s'))
                ->subMinutes(self::EARLY_CLOCK_IN_GRACE_MINUTES);
            if ($graceOpen->lessThan($dayStart)) {
                return $graceOpen;
            }
        }

        // The spillover comparison in attendanceDateFor() is INCLUSIVE at
        // exactly +12h (that instant still belongs to the previous day), so
        // this day opens one second after.
        return $spillEnd && $spillEnd->greaterThan($dayStart) ? $spillEnd->addSecond() : $dayStart;
    }

    /**
     * One-day shift overrides for this user (see {@see UserShiftOverride}).
     */
    public function shiftOverrides()
    {
        return $this->hasMany(UserShiftOverride::class);
    }

    /**
     * Standing-shift history, newest era first — {@see effectiveShiftFor()}
     * walks this to answer "which shift was in force on that date". Ordered in
     * the relation so the resolver can take the first match without sorting.
     */
    public function shiftAssignments()
    {
        return $this->hasMany(UserShiftAssignment::class)->orderByDesc('effective_from');
    }

    /**
     * Is the shift-history table actually there yet?
     *
     * Deploys land CODE before migrations are run by hand, so for a window the
     * new resolver exists while `user_shift_assignments` does not. Querying it
     * then would 500 every authenticated page. When it is missing we simply fall
     * back to the users.* columns — exactly the pre-history behaviour — and the
     * feature switches itself on the moment the migration runs.
     *
     * Memoised per request; a schema lookup per user would be far worse than the
     * problem it guards against.
     */
    private static ?bool $shiftHistoryAvailable = null;

    public static function shiftHistoryAvailable(): bool
    {
        if (self::$shiftHistoryAvailable === null) {
            try {
                self::$shiftHistoryAvailable = \Illuminate\Support\Facades\Schema::hasTable('user_shift_assignments');
            } catch (\Throwable) {
                self::$shiftHistoryAvailable = false;
            }
        }

        return self::$shiftHistoryAvailable;
    }

    /** Drop the memo — for tests that create or drop the table mid-run. */
    public static function forgetShiftHistoryAvailability(): void
    {
        self::$shiftHistoryAvailable = null;
    }

    /**
     * Relations every shift consumer should eager-load. Skips the history table
     * while it does not exist so a pre-migration deploy cannot break the page.
     *
     * @return array<int, string>
     */
    public static function shiftEagerLoads(string $prefix = ''): array
    {
        $relations = [$prefix.'shiftOverrides'];

        if (self::shiftHistoryAvailable()) {
            $relations[] = $prefix.'shiftAssignments';
        }

        return $relations;
    }

    /**
     * The curated shift (Morning/Noon/Evening/Night/…) this person is assigned
     * to — a filter/grouping LABEL, separate from the shift timing. Nullable.
     */
    public function shift()
    {
        return $this->belongsTo(Shift::class);
    }

    /** Convenience for payloads/tables: the assigned shift's name, or null. */
    public function getShiftNameAttribute(): ?string
    {
        return $this->shift?->name;
    }

    /**
     * The effective shift for an attendance date: a one-day override when the
     * user set one, otherwise their standing shift. Single source of truth for
     * every shift consumer — bucketing, auto-close, "still working?" nudges and
     * late detection all read this, so a change applies everywhere at once.
     *
     * Resolution order: a one-day override, then the standing-shift ERA in force
     * on that date, then the live users.* columns. The era layer is what keeps
     * history stable — see UserShiftAssignment.
     *
     * Returns ['start_time' => ?Carbon, 'hours' => ?float, 'grace_minutes' => int,
     * 'timezone' => string]. Grace and timezone are era-resolved; callers must
     * NOT read $user->shift_grace_minutes directly or they reintroduce the drift.
     */
    /**
     * Only employees expected to track time. Excludes non-tracking staff (HR,
     * finance, etc.) from team / performance aggregates so they never show as
     * "0% this week". Attendance and the user directory still include everyone.
     */
    public function scopeTracksTime($query)
    {
        return $query->where('tracks_time', true);
    }

    /**
     * Active (not deactivated) users. Deactivated users — people who left the
     * company — are hidden from active directory / assignment / performance
     * views, blocked from logging in and tracking, but keep all their history.
     * Chain alongside tracksTime() where both apply.
     */
    public function scopeActive($query)
    {
        return $query->where('is_active', true);
    }

    /**
     * Single source of truth for "may this user use the app?". Null-safe so
     * rows created before the is_active column (and the default true) read as
     * active — and so a stray direct ->is_active read can't bypass the gate.
     */
    public function isActive(): bool
    {
        return (bool) ($this->is_active ?? true);
    }

    public function effectiveShiftFor(string|Carbon $date): array
    {
        $dateStr = $date instanceof Carbon ? $date->toDateString() : (string) $date;

        // Property access lazy-loads each relation once and caches it on the
        // instance, so the repeated calls in attendanceDateFor() stay in-memory.

        // 1. The standing-shift ERA in force on this date. Without this the
        //    live users.* columns were used for every historical date, so any
        //    shift edit retroactively re-judged the past — on-time days became
        //    "late". Rows are ordered newest-first, so the first era that
        //    started on or before the date is the one that applies.
        $assignment = self::shiftHistoryAvailable()
            ? $this->shiftAssignments->first(
                fn ($a) => optional($a->effective_from)->toDateString() <= $dateStr
            )
            : null;

        // 2. Fall back to the current columns when no era covers the date —
        //    pre-backfill rows and factory-built users in tests. This is what
        //    makes the change a no-op at cutover.
        $startTime = $assignment ? $assignment->shift_start_time : $this->shift_start_time;
        $hoursSource = $assignment ? $assignment->shift_hours : $this->shift_hours;
        $hours = $hoursSource !== null ? (float) $hoursSource : null;
        $grace = (int) ($assignment
            ? ($assignment->shift_grace_minutes ?? $this->shift_grace_minutes ?? 0)
            : ($this->shift_grace_minutes ?? 0));
        $timezone = ($assignment && $assignment->work_timezone)
            ? $assignment->work_timezone
            : $this->workTimezone();

        // 3. A one-day exception beats the era for its exact date. Overrides
        //    carry no grace or timezone, so those stay era-resolved.
        $override = $this->shiftOverrides->first(
            fn ($o) => optional($o->date)->toDateString() === $dateStr
        );

        if ($override) {
            if ($override->shift_start_time) {
                $startTime = $override->shift_start_time;
            }
            if ($override->shift_hours !== null) {
                $hours = (float) $override->shift_hours;
            }
        }

        return [
            'start_time' => $startTime,
            'hours' => $hours,
            'grace_minutes' => $grace,
            'timezone' => $timezone,
        ];
    }
}
