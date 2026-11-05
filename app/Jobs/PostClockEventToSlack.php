<?php

namespace App\Jobs;

use App\Models\TimeEntry;
use App\Services\AttendanceClockNotifier;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;

/** Announces one clock event in the person's Slack thread for the day. */
class PostClockEventToSlack implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, SerializesModels;

    public int $tries = 3;

    public int $backoff = 60;

    public function __construct(public int $timeEntryId) {}

    public function handle(AttendanceClockNotifier $notifier): void
    {
        $entry = TimeEntry::find($this->timeEntryId);

        if ($entry) {
            $notifier->notify($entry);
        }
    }
}
