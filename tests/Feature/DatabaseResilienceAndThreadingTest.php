<?php

namespace Tests\Feature;

use App\Database\ResilientMySqlConnector;
use App\Models\TimeEntry;
use App\Models\User;
use App\Services\AttendanceClockNotifier;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PDOException;
use ReflectionMethod;
use Tests\TestCase;

/**
 * Two production 500 sources from the 23 Oct 2026 incident.
 *
 * 1. Hostinger's shared MySQL refuses connections in sub-second bursts
 *    ("[2002] Operation not permitted"); the MySQL connector must retry those
 *    and only those — a wrong password should still fail fast.
 * 2. AttendanceClockNotifier::dayThreadTs queried a non-existent `action`
 *    column, so every auto clock-out / still-working lockout crashed after
 *    closing one person and its Slack announcement never went out.
 */
class DatabaseResilienceAndThreadingTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_app_uses_the_retrying_mysql_connector(): void
    {
        $this->assertInstanceOf(ResilientMySqlConnector::class, $this->app->make('db.connector.mysql'));
    }

    public function test_only_transient_connection_failures_are_retried(): void
    {
        $worthRetrying = new ReflectionMethod(ResilientMySqlConnector::class, 'worthRetrying');
        $connector = new ResilientMySqlConnector;

        $refused = new PDOException('SQLSTATE[HY000] [2002] Operation not permitted');
        $badPassword = new PDOException("SQLSTATE[HY000] [1045] Access denied for user 'x'@'localhost'");

        $this->assertTrue($worthRetrying->invoke($connector, $refused));
        $this->assertFalse($worthRetrying->invoke($connector, $badPassword));
    }

    public function test_day_thread_ts_finds_the_first_clock_in_announcement(): void
    {
        $user = User::factory()->create();
        $day = Carbon::parse('2026-10-23 09:00:00', 'Asia/Karachi');

        $entry = TimeEntry::create([
            'user_id' => $user->id,
            'action_type' => 'clock_in',
            'action_timestamp' => $day,
            'action_date' => $day->toDateString(),
            'action_time' => '09:00:00',
        ]);
        TimeEntry::where('id', $entry->id)->update(['slack_thread_ts' => '1729670000.000100']);

        // Callers pass the date-cast attribute (a Carbon), not a plain string.
        $this->assertSame(
            '1729670000.000100',
            AttendanceClockNotifier::dayThreadTs($user->id, $entry->fresh()->action_date)
        );
        $this->assertSame('1729670000.000100', AttendanceClockNotifier::dayThreadTs($user->id, '2026-10-23'));
        $this->assertNull(AttendanceClockNotifier::dayThreadTs($user->id, '2026-10-24'));
    }
}
