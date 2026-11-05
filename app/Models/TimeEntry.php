<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class TimeEntry extends Model
{
    use HasFactory;

    protected $fillable = [
        'user_id',
        'action_type',
        'action_timestamp',
        'action_date',
        'action_time',
        'notes',
        'slack_thread_ts',
    ];

    protected $casts = [
        'action_timestamp' => 'datetime',
        'action_date' => 'date',
        'action_time' => 'datetime:H:i:s',
    ];

    /**
     * Announce clock activity to the attendance Slack channel as one thread per
     * person per day (clock-in is the parent; breaks and clock-out are
     * replies). Fires for web, desktop, and any path that creates the entry.
     * It is queued from a terminating callback so it never adds latency to the
     * clock action itself; the scheduled worker posts it within a minute.
     * {@see \App\Services\AttendanceClockNotifier} holds the threading + gating
     * rules.
     */
    protected static function booted(): void
    {
        static::created(function (self $entry) {
            // Diagnostic capture: if a clock punch is filed on the wrong
            // attendance day, snapshot the request + call path + clock state so
            // the culprit is pinned the next time it happens. Never breaks the
            // clock action (fully wrapped inside).
            \App\Support\AttendanceDiagnostics::captureMisfile($entry);

            app()->terminating(function () use ($entry) {
                try {
                    \App\Jobs\PostClockEventToSlack::dispatch($entry->id);
                } catch (\Throwable $e) {
                    \Illuminate\Support\Facades\Log::warning('Attendance Slack post failed', ['message' => $e->getMessage()]);
                }
            });
        });
    }

    public function user()
    {
        return $this->belongsTo(User::class);
    }

    public function scopeForUser($query, $userId)
    {
        return $query->where('user_id', $userId);
    }

    /**
     * The user's CURRENT clock state: the action_type of their globally most
     * recent entry, regardless of attendance day. The clock sequence must be
     * enforced against this (not against today's entries only) so a clock-in
     * left open last night still blocks a new clock-in after midnight — you
     * can't clock in while already clocked in. Returns null if they've never
     * clocked anything (then a clock-in is the only allowed action).
     */
    public static function currentClockState(int $userId): ?string
    {
        return static::where('user_id', $userId)
            ->orderByDesc('action_timestamp')->orderByDesc('id')
            ->value('action_type');
    }

    public function scopeForDate($query, $date)
    {
        return $query->whereDate('action_date', $date);
    }

    public function scopeRecent($query, $limit = 50)
    {
        return $query->orderBy('action_timestamp', 'desc')->limit($limit);
    }

    public function getFormattedActionTimeAttribute()
    {
        return $this->action_timestamp->setTimezone('Asia/Karachi')->format('g:i A');
    }

    public function getFormattedActionDateAttribute()
    {
        return $this->action_timestamp->setTimezone('Asia/Karachi')->format('M j, Y');
    }

    public function getFormattedActionTimestampAttribute()
    {
        return $this->action_timestamp->setTimezone('Asia/Karachi')->format('M j, Y g:i A');
    }
}
