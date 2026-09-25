<?php

namespace Tests\Feature;

use App\Models\ManualAttendanceMark;
use App\Models\TimeEntry;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class PayrollApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        config(['services.payroll.token' => 'test-payroll-token']);
    }

    private function punch(User $user, string $date, string $type, string $time): void
    {
        TimeEntry::create([
            'user_id' => $user->id,
            'action_type' => $type,
            'action_timestamp' => Carbon::parse("{$date} {$time}", 'Asia/Karachi'),
            'action_date' => $date,
            'action_time' => $time,
        ]);
    }

    public function test_endpoints_need_the_token_and_are_disabled_without_one(): void
    {
        $this->getJson('/api/payroll/ping')->assertStatus(401);
        $this->withToken('wrong')->getJson('/api/payroll/ping')->assertStatus(401);
        $this->withToken('test-payroll-token')->getJson('/api/payroll/ping')->assertOk()->assertJson(['ok' => true]);

        config(['services.payroll.token' => null]);
        $this->withToken('test-payroll-token')->getJson('/api/payroll/ping')->assertStatus(404);
    }

    public function test_attendance_export_resolves_days_like_the_grid(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-06-30 20:00', 'Asia/Karachi'));

        $user = User::factory()->create([
            'name' => 'Bilal Ahmed',
            'shift_start_time' => '10:00:00',
            'shift_grace_minutes' => 15,
            'shift_hours' => 9,
            'joining_date' => '2026-06-16',
        ]);

        // 15 Jun: before joining -> LI. 16 Jun: on time. 17 Jun: 26 min late -> LC. 18 Jun: manual leave. 19 Jun: nothing -> A. 21 Jun is a Sunday -> H.
        $this->punch($user, '2026-06-16', 'clock_in', '10:05:00');
        $this->punch($user, '2026-06-16', 'clock_out', '19:05:00');
        $this->punch($user, '2026-06-17', 'clock_in', '10:26:00');
        $this->punch($user, '2026-06-17', 'break_start', '14:00:00');
        $this->punch($user, '2026-06-17', 'break_end', '14:30:00');
        $this->punch($user, '2026-06-17', 'clock_out', '19:00:00');
        ManualAttendanceMark::create(['user_id' => $user->id, 'marked_by_user_id' => $user->id, 'attendance_date' => '2026-06-18', 'status_code' => 'L', 'note' => 'Sick']);

        $res = $this->withToken('test-payroll-token')->getJson('/api/payroll/attendance?month=2026-06&user_ids='.$user->id)->assertOk();
        $payload = $res->json();

        $this->assertSame('2026-06', $payload['month']);
        $this->assertCount(1, $payload['users']);
        $days = collect($payload['users'][0]['days'])->keyBy('date');

        $this->assertSame('LI', $days['2026-06-15']['code']);
        $this->assertSame('P', $days['2026-06-16']['code']);
        $this->assertFalse($days['2026-06-16']['late']);
        $this->assertSame(9 * 3600, $days['2026-06-16']['in_office_seconds']);

        $this->assertSame('LC', $days['2026-06-17']['code']);
        $this->assertTrue($days['2026-06-17']['late']);
        $this->assertSame(26, $days['2026-06-17']['late_minutes']);
        // 10:26→19:00 minus a 30 min break = 8h04m; the grid rounds hours to 2 decimals, so allow a minute.
        $this->assertEqualsWithDelta((8 * 60 + 4) * 60, $days['2026-06-17']['in_office_seconds'], 60);

        $this->assertSame('L', $days['2026-06-18']['code']);
        $this->assertSame('manual', $days['2026-06-18']['source']);
        $this->assertSame('Sick', $days['2026-06-18']['note']);

        $this->assertSame('A', $days['2026-06-19']['code']);
        $this->assertSame('H', $days['2026-06-21']['code']);

        $summary = $payload['users'][0]['summary'];
        $this->assertSame(2, $summary['present']);
        $this->assertSame(1, $summary['late_coming']);
        $this->assertSame(1, $summary['leave']);

        Carbon::setTestNow();
    }

    public function test_users_export_lists_shift_and_timezone(): void
    {
        User::factory()->create(['name' => 'Night Owl', 'shift_start_time' => '00:00:00', 'shift_hours' => 8]);

        $res = $this->withToken('test-payroll-token')->getJson('/api/payroll/users')->assertOk();
        $owl = collect($res->json('users'))->firstWhere('name', 'Night Owl');
        $this->assertSame('00:00', $owl['shift_start']);
        $this->assertSame('Asia/Karachi', $owl['work_timezone']);
        $this->assertTrue($owl['is_active']);
    }
}
