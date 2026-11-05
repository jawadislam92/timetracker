<?php

namespace Tests\Feature;

use App\Jobs\PostClockEventToSlack;
use App\Models\TimeEntry;
use App\Models\User;
use App\Services\AttendanceClockNotifier;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Mockery;
use Tests\TestCase;

class QueueWorkerTest extends TestCase
{
    use RefreshDatabase;

    private function clockIn(User $user): TimeEntry
    {
        return TimeEntry::create([
            'user_id' => $user->id,
            'action_type' => 'clock_in',
            'action_timestamp' => now(),
            'action_date' => now()->toDateString(),
            'action_time' => '09:00:00',
        ]);
    }

    public function test_clock_events_are_queued_after_the_response(): void
    {
        Queue::fake();
        $entry = $this->clockIn(User::factory()->create());

        Queue::assertNothingPushed();

        $this->app->terminate();

        Queue::assertPushed(PostClockEventToSlack::class, fn ($job) => $job->timeEntryId === $entry->id);
    }

    public function test_job_posts_the_entry_and_ignores_one_that_was_deleted(): void
    {
        $entry = $this->clockIn(User::factory()->create());
        $notifier = Mockery::mock(AttendanceClockNotifier::class);
        $notifier->shouldReceive('notify')->once()->withArgs(fn ($given) => $given->id === $entry->id);

        (new PostClockEventToSlack($entry->id))->handle($notifier);
        (new PostClockEventToSlack(999999))->handle($notifier);
    }

    public function test_queued_clock_event_waits_in_the_database_until_the_worker_runs(): void
    {
        config(['queue.default' => 'database']);
        $entry = $this->clockIn(User::factory()->create());

        $this->app->terminate();

        $this->assertSame(1, DB::table('jobs')->count());
        $this->assertStringContainsString('PostClockEventToSlack', DB::table('jobs')->value('payload'));
    }

    public function test_worker_is_scheduled_only_on_the_database_queue(): void
    {
        $hasWorker = fn () => collect(app(Schedule::class)->events())->contains(fn ($event) => str_contains((string) $event->command, 'queue:work'));

        $this->assertFalse($hasWorker());

        config(['queue.default' => 'database']);
        $this->app->forgetInstance(Schedule::class);
        $this->app->make(\Illuminate\Contracts\Console\Kernel::class)->bootstrap();
        $schedule = new Schedule;
        (new \ReflectionMethod(\App\Console\Kernel::class, 'schedule'))->invoke($this->app->make(\Illuminate\Contracts\Console\Kernel::class), $schedule);

        $worker = collect($schedule->events())->first(fn ($event) => str_contains((string) $event->command, 'queue:work'));
        $this->assertNotNull($worker);
        $this->assertStringContainsString('--stop-when-empty', $worker->command);
        $this->assertSame('* * * * *', $worker->expression);
    }
}
