<?php

namespace App\Console\Commands;

use App\Models\TimeEntry;
use App\Models\TrackingActivitySample;
use App\Models\TrackingScreenshot;
use App\Models\TrackingSession;
use App\Models\User;
use App\Services\SlackBotService;
use App\Support\BusinessTime;
use Carbon\Carbon;
use Illuminate\Console\Command;

/**
 * Capture-health watchdog. A tracker can keep sending heartbeats (so it shows
 * "live" with time + activity %) while its screenshot/sample helpers are blocked
 * by antivirus — so the person looks tracked but the day has no screenshots or
 * apps. This finds those silent sessions in real time and posts a Slack alert,
 * so a broken machine surfaces immediately instead of being discovered days
 * later in an empty report. Alerts at most once per session.
 */
class SilentTrackerCheck extends Command
{
    protected $signature = 'monitoring:silent-tracker-check
        {--minutes=20 : Flag a live session with no screenshot/sample for this long}
        {--user= : Limit to one user id (testing)}
        {--force : Ignore the already-alerted guard (re-alert; testing)}
        {--dry-run : Report without posting or marking}';

    protected $description = 'Alert when a live tracker sends heartbeats but no screenshots/samples (likely antivirus block).';

    public function handle(SlackBotService $slack): int
    {
        $minutes = (int) $this->option('minutes');
        $dry = (bool) $this->option('dry-run');
        $force = (bool) $this->option('force');
        $now = Carbon::now(BusinessTime::tz());
        $cutoff = $now->copy()->subMinutes($minutes);
        $liveCutoff = $now->copy()->subMinutes(5);

        $sessions = TrackingSession::query()
            ->where('status', TrackingSession::STATUS_ACTIVE)
            ->where('started_at', '<=', $cutoff)            // running long enough to have captured
            ->where('last_heartbeat_at', '>=', $liveCutoff) // genuinely live (heartbeats arriving)
            ->when(! $force, fn ($q) => $q->whereNull('health_alerted_at'))
            ->when($this->option('user'), fn ($q) => $q->where('user_id', $this->option('user')))
            ->get();

        // Batch the "last capture" lookups: one grouped query each instead of
        // two max() queries per session inside the loop (was 2N queries / run).
        $ids = $sessions->pluck('id');
        $lastShots = TrackingScreenshot::whereIn('tracking_session_id', $ids)
            ->groupBy('tracking_session_id')
            ->selectRaw('tracking_session_id, MAX(captured_at) as m')
            ->pluck('m', 'tracking_session_id');
        $lastSamples = TrackingActivitySample::whereIn('tracking_session_id', $ids)
            ->groupBy('tracking_session_id')
            ->selectRaw('tracking_session_id, MAX(captured_at) as m')
            ->pluck('m', 'tracking_session_id');

        $flagged = 0;

        foreach ($sessions as $s) {
            $lastShot = $lastShots[$s->id] ?? null;
            $lastSample = $lastSamples[$s->id] ?? null;
            $last = collect([$lastShot, $lastSample])->filter()->map(fn ($d) => Carbon::parse($d))->max();

            $silent = ! $last || $last->lt($cutoff);
            if (! $silent) {
                continue;
            }

            $user = User::find($s->user_id);
            if ($user?->isOwner()) {
                continue; // Owners are not tracked, so never alert on them
            }
            $name = $user?->name ?? ('#'.$s->user_id);

            // A break legitimately captures nothing — never AV-alert someone on
            // break. The desktop can keep the tracked-seconds counter advancing
            // during a break, which would otherwise fool the paused-vs-block
            // check below into a false antivirus alarm (the reported Asim Khan
            // case: captures stopped the instant he hit break, but the timer
            // kept ticking, so the watchdog cried "AV block").
            if (TimeEntry::currentClockState($s->user_id) === 'break_start') {
                if (! $dry) {
                    TrackingSession::where('id', $s->id)->update(['health_probe_seconds' => (int) $s->total_seconds]);
                }
                \App\Support\TrackerHealthDiagnostics::capture($s, 'skipped: on break', $last, $now);
                $this->line(sprintf('%-22s no capture but ON BREAK → skip', $name));

                continue;
            }

            // Distinguish a PAUSED tracker (idle/break — legitimately captures
            // nothing) from an AV-BLOCKED one (working but capture blocked). The
            // desktop freezes total_seconds while paused and keeps advancing it
            // while active, so compare it to the snapshot from the previous run:
            //   unchanged  → paused/idle → no alert
            //   advanced   → working but not capturing → antivirus block → alert
            // The first time we see a silent session we only record the baseline.
            $prev = $s->health_probe_seconds;
            $cur = (int) $s->total_seconds;
            $advanced = $prev !== null && $cur > ((int) $prev + 60);

            if ($dry) {
                $state = $prev === null ? 'baseline' : ($advanced ? 'AV-block → would alert' : 'paused/idle → skip');
                $this->line(sprintf('%-22s no capture, %s [dry-run]', $name, $state));
                continue;
            }

            // Snapshot this run's total for the next comparison, always.
            $s->health_probe_seconds = $cur;

            if (! $advanced) {
                // No prior baseline yet, or frozen (paused) — record and wait.
                // Query-builder update (NOT $s->save()) so the datetime casts
                // can't re-serialize started_at/last_heartbeat_at to UTC.
                TrackingSession::where('id', $s->id)->update(['health_probe_seconds' => $cur]);
                continue;
            }

            $ageMin = (int) round($s->started_at->diffInMinutes($now));
            $this->line(sprintf('%-22s live %dm, working but no capture (AV block)', $name, $ageMin));
            $flagged++;

            $this->announce($slack, $user, $s, $last);
            \App\Support\TrackerHealthDiagnostics::capture($s, 'ALERTED: working but no capture (likely AV block)', $last, $now);
            TrackingSession::where('id', $s->id)->update([
                'health_probe_seconds' => $cur,
                'health_alerted_at' => $now,
            ]);
        }

        $this->info(sprintf('%s %d silent tracker(s).', $dry ? 'Would flag' : 'Flagged', $flagged));

        return self::SUCCESS;
    }

    private function announce(SlackBotService $slack, ?User $user, TrackingSession $s, ?Carbon $last): void
    {
        $channel = config('services.attendance.tracker_health_channel')
            ?: config('services.attendance.clockin_channel');

        if (! $channel) {
            return;
        }

        $lastTxt = $last ? $last->format('g:i A') : 'never';
        $slack->postToChannel($channel, sprintf(
            ":warning: *%s*'s tracker is live and *actively counting time* (clocked in, not on break) but has captured *no screenshots/activity* since %s — likely an antivirus block on that machine. Device: %s. Session started %s.",
            $user?->name ?? 'Someone',
            $lastTxt,
            $s->device_name ?: 'unknown',
            $s->started_at->format('g:i A'),
        ));
    }
}
