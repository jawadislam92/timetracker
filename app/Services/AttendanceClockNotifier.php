<?php

namespace App\Services;

use App\Models\MonitoringSetting;
use App\Models\TimeEntry;

/**
 * Posts attendance clock activity to Slack as ONE thread per person per day:
 * the day's first clock-in is the parent message, and break-start, break-end,
 * and clock-out (plus any later clock-in after lunch) post as replies under it.
 *
 * Gating mirrors the existing toggles: clock-in and breaks follow the clock-in
 * toggle (they're presence events), clock-out follows the clock-out toggle. The
 * system's own auto clock-outs and admin clock-time edits are skipped — the
 * former posts its own worded lockout message, the latter is a back-dated edit.
 */
class AttendanceClockNotifier
{
    public function __construct(private SlackBotService $slack) {}

    public function notify(TimeEntry $entry): void
    {
        if (! in_array($entry->action_type, ['clock_in', 'clock_out', 'break_start', 'break_end'], true)) {
            return;
        }

        // Back-dated admin edits / an admin clocking someone out aren't the
        // worker clocking in/out right now — don't post them to the channel.
        if (str_starts_with((string) $entry->notes, 'Admin clock edit')
            || str_starts_with((string) $entry->notes, 'Admin clock-out')) {
            return;
        }

        // The auto clock-out path posts its own lockout message; don't double up.
        if ($entry->action_type === 'clock_out'
            && str_starts_with((string) $entry->notes, 'Auto clock-out')) {
            return;
        }

        // The break-end a close() writes when ending an open break (auto-close or
        // admin clock-out) is system bookkeeping, not the worker resuming work —
        // never announce ":back: ended their break" for it.
        if ($entry->action_type === 'break_end'
            && str_starts_with((string) $entry->notes, 'Auto break-end')) {
            return;
        }

        $settings = MonitoringSetting::current();
        $channel = $settings->attendanceChannel();
        if (! $channel) {
            return;
        }

        $clockinOn = (bool) $settings->slack_clockin_enabled;
        $clockoutOn = (bool) $settings->slack_clockout_enabled;

        $eventEnabled = match ($entry->action_type) {
            'clock_in', 'break_start', 'break_end' => $clockinOn,
            'clock_out' => $clockoutOn,
            default => false,
        };
        if (! $eventEnabled) {
            return;
        }

        // Make sure the day's thread parent (the first clock-in) exists. If the
        // person clocked in before threading was switched on, their clock-in has
        // no thread ts yet — back-fill it now so this event (and the rest of
        // their day) threads under one message instead of spamming the channel.
        $parentTs = $this->ensureThreadParent($entry, $channel, $clockinOn);

        // If this very entry IS the day's first clock-in, ensureThreadParent
        // already posted it as the parent — nothing more to do.
        $first = $this->firstClockIn($entry);
        if ($first && $entry->id === $first->id) {
            return;
        }

        // Otherwise post as a reply under the day's thread (standalone only if
        // there's genuinely no clock-in to anchor to).
        $this->slack->postToThread($channel, $this->message($entry), $parentTs);
    }

    /**
     * The Slack thread anchor for one person's attendance day, if the day's
     * first clock-in has been announced. Used by the auto clock-out commands so
     * their lockout messages land in the SAME thread as the person's clock
     * events instead of as standalone channel messages.
     */
    public static function dayThreadTs(int $userId, string|\DateTimeInterface $actionDate): ?string
    {
        // Callers pass the entry's date-cast action_date, which stringifies as
        // "Y-m-d 00:00:00"; compare on the calendar day.
        $day = $actionDate instanceof \DateTimeInterface
            ? $actionDate->format('Y-m-d')
            : substr($actionDate, 0, 10);

        return TimeEntry::where('user_id', $userId)
            ->whereDate('action_date', $day)
            ->where('action_type', 'clock_in')
            ->whereNotNull('slack_thread_ts')
            ->orderBy('action_timestamp')
            ->value('slack_thread_ts');
    }

    /**
     * Return the day's thread anchor (the first clock-in's Slack ts), posting
     * the parent clock-in message now if it hasn't been announced yet.
     */
    private function ensureThreadParent(TimeEntry $entry, string $channel, bool $clockinOn): ?string
    {
        $first = $this->firstClockIn($entry);
        if (! $first) {
            return null; // no clock-in to anchor to
        }
        if ($first->slack_thread_ts) {
            return $first->slack_thread_ts;
        }
        if (! $clockinOn) {
            return null; // can't announce the parent clock-in while it's disabled
        }

        $ts = $this->slack->postToThread($channel, $this->message($first));
        if ($ts) {
            // Query-builder update (NOT a model save): re-saving a loaded
            // TimeEntry makes Eloquent re-serialize the `timestamp` column
            // action_timestamp and shift it 5h (Karachi→UTC) on this UTC MySQL
            // server. We only need to write slack_thread_ts, so bypass the cast.
            TimeEntry::where('id', $first->id)->update(['slack_thread_ts' => $ts]);
        }

        return $ts;
    }

    /** The day's earliest clock-in for this user (the thread parent). */
    private function firstClockIn(TimeEntry $entry): ?TimeEntry
    {
        return TimeEntry::query()
            ->where('user_id', $entry->user_id)
            ->where('action_date', $entry->action_date)
            ->where('action_type', 'clock_in')
            ->orderBy('action_timestamp')->orderBy('id')
            ->first();
    }

    private function message(TimeEntry $entry): string
    {
        // Show the worker's own local clock time. For a remote worker, append the
        // city so the Pakistan team reading the channel can't misread it; local
        // (Asia/Karachi) staff get no suffix, exactly as before.
        $workTz = $entry->user?->workTimezone() ?: config('app.timezone', 'Asia/Karachi');
        $at = $entry->action_timestamp->copy()->setTimezone($workTz)->format('g:i A');
        if ($workTz !== config('app.timezone', 'Asia/Karachi')) {
            $at .= str_contains($workTz, '/')
                ? ' '.str_replace('_', ' ', substr(strrchr($workTz, '/'), 1))
                : ' '.$workTz;
        }
        $name = $entry->user->name ?? 'Someone';

        return match ($entry->action_type) {
            'clock_in' => sprintf(':office: *%s* clocked in at %s.', $name, $at),
            'break_start' => sprintf(':coffee: *%s* started a break at %s.', $name, $at),
            'break_end' => sprintf(':back: *%s* ended their break at %s.', $name, $at),
            'clock_out' => sprintf(':waving_black_flag: *%s* clocked out at %s.%s', $name, $at, $this->workedSuffix($entry)),
            default => sprintf('*%s* — %s at %s.', $name, $entry->action_type, $at),
        };
    }

    /**
     * " (worked 8h 12m)" for a clock-out, from the matching clock-in on the same
     * attendance day, or '' when it can't be determined cheaply.
     */
    private function workedSuffix(TimeEntry $clockOut): string
    {
        $clockIn = TimeEntry::query()
            ->where('user_id', $clockOut->user_id)
            ->where('action_type', 'clock_in')
            ->where('action_timestamp', '<=', $clockOut->action_timestamp)
            ->orderByDesc('action_timestamp')->orderByDesc('id')
            ->first();

        if (! $clockIn) {
            return '';
        }

        $mins = $clockIn->action_timestamp->diffInMinutes($clockOut->action_timestamp);
        if ($mins <= 0) {
            return '';
        }

        return $mins >= 60
            ? sprintf(' (worked %dh %dm)', intdiv($mins, 60), $mins % 60)
            : sprintf(' (worked %dm)', $mins);
    }
}
