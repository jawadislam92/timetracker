<?php

namespace App\Console;

use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Console\Kernel as ConsoleKernel;
use Illuminate\Support\Facades\Artisan;

class Kernel extends ConsoleKernel
{
    /**
     * Define the application's command schedule.
     */
    protected function schedule(Schedule $schedule): void
    {
        $timezone = config('services.slack_reports.timezone', 'Asia/Karachi');

        // One weekly per-person digest (tracked + activity, in-office hours, the
        // in-office-vs-tracked gap, and late days) — replaces the old daily
        // activity-table digest and the client work-hours report on the
        // schedule. The on-demand "Send to Slack" buttons for those still work.
        if (config('services.slack_reports.weekly_enabled')) {
            $schedule->command('reports:weekly-digest')
                ->sundays()
                ->at('10:00')
                ->timezone($timezone)
                ->withoutOverlapping();
        }

        // Enforce the screenshot retention period from monitoring settings.
        $schedule->command('monitoring:prune-screenshots')
            ->dailyAt('02:30')
            ->timezone($timezone)
            ->withoutOverlapping();

        // Close sessions whose desktop app died without sending a stop, so
        // they don't sit "active" forever and their hours still sync.
        $schedule->command('monitoring:close-stale-sessions')
            ->everyTenMinutes()
            ->withoutOverlapping();

        // Safety net for forgotten clock-outs: the clock is fully manual, so a
        // clock-in with no clock-out hangs open forever. Close dangling
        // clock-ins (at last tracker activity, or capped at 12h when never
        // tracked) and record a clock_out with a plain-language reason.
        // Gated by a flag so it can be dry-run/reviewed before going live.
        if (config('services.attendance.auto_clockout_enabled')) {
            $schedule->command('attendance:auto-clock-out')
                ->everyThirtyMinutes()
                ->withoutOverlapping();
        }

        // Interactive "still working?" Slack check: DM people clocked in past
        // the threshold with Yes/No buttons; clock out non-responders. The cap
        // above stays as the final backstop. Gated by its own flag.
        if (config('services.attendance.still_working_slack_enabled')) {
            $schedule->command('attendance:still-working-check')
                ->everyTenMinutes()
                ->withoutOverlapping();
        }

        // Capture-health watchdog: a tracker can send heartbeats (looks "live")
        // while its screenshot/sample helpers are blocked by antivirus, so the
        // person looks tracked but the report is empty. Alert in real time.
        if (config('services.attendance.tracker_health_slack_enabled')) {
            $schedule->command('monitoring:silent-tracker-check')
                ->everyFifteenMinutes()
                ->withoutOverlapping();
        }

        // Hostinger's git auto-deploy re-clones the tree and wipes
        // bootstrap/cache, dropping the config AND route caches (a large chunk
        // of TTFB on shared hosting). Rebuild whichever is missing.
        // route:cache is safe here: verified live 2026-08-09 (exit 0, all
        // routes 200) — an older note claimed closure routes break it, which
        // is no longer true on this Laravel version.
        $schedule->call(function () {
            if (! file_exists(base_path('bootstrap/cache/config.php'))) {
                Artisan::call('config:cache');
            }
            if (! file_exists(base_path('bootstrap/cache/routes-v7.php'))) {
                Artisan::call('route:cache');
            }
        })->name('config-cache-self-heal')->everyFiveMinutes();

        // Shared hosting has no long-running processes, so the cron-driven
        // scheduler drains the database queue once a minute.
        if (config('queue.default') === 'database') {
            $schedule->command('queue:work --stop-when-empty --max-time=50 --tries=3')
                ->everyMinute()
                ->withoutOverlapping(3);
        }

        // Liveness marker: this file's mtime shows when the scheduler last
        // ran, regardless of what drives it (host cron or the HTTP trigger).
        $schedule->call(function () {
            touch(storage_path('framework/schedule-heartbeat'));
        })->name('schedule-heartbeat')->everyMinute();
    }

    /**
     * Register the commands for the application.
     */
    protected function commands(): void
    {
        $this->load(__DIR__.'/Commands');

        require base_path('routes/console.php');
    }
}
