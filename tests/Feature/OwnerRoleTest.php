<?php

namespace Tests\Feature;

use App\Models\TimeEntry;
use App\Models\User;
use App\Models\WorkHour;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class OwnerRoleTest extends TestCase
{
    use RefreshDatabase;

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function clockIn(User $user, string $date = '2026-11-14'): void
    {
        TimeEntry::create([
            'user_id' => $user->id,
            'action_type' => 'clock_in',
            'action_timestamp' => Carbon::parse("$date 09:00:00", 'Asia/Karachi'),
            'action_date' => $date,
            'action_time' => '09:00:00',
        ]);
    }

    public function test_owner_has_every_power_but_is_not_tracked(): void
    {
        $owner = User::factory()->create(['role' => 'owner']);

        $this->assertTrue($owner->isOwner());
        $this->assertTrue($owner->isSuperAdmin());
        $this->assertTrue($owner->hasPermission('attendance.view'));
        $this->assertFalse($owner->isTracked());
    }

    public function test_owner_is_left_out_of_attendance_but_super_admin_is_not(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-11-14 12:00:00', 'Asia/Karachi'));
        $owner = User::factory()->create(['role' => 'owner', 'name' => 'Olivia Owner']);
        $super = User::factory()->create(['role' => 'super_admin', 'name' => 'Sam Super']);
        $this->clockIn($owner);
        $this->clockIn($super);

        $names = collect(
            $this->actingAs($owner)->getJson(route('employee-attendance.summary', ['date' => '2026-11-14']))
                ->assertOk()->json('employees')
        )->pluck('user_name');

        $this->assertContains('Sam Super', $names);
        $this->assertNotContains('Olivia Owner', $names);

        $detailed = collect(
            $this->actingAs($super)->getJson(route('employee-attendance.detailed', ['date' => '2026-11-14']))
                ->assertOk()->json('activities')
        )->pluck('user_name');
        $this->assertNotContains('Olivia Owner', $detailed);
    }

    public function test_owner_work_hours_stay_out_of_the_summary_page(): void
    {
        $owner = User::factory()->create(['role' => 'owner', 'name' => 'Olivia Owner']);
        $member = User::factory()->create(['name' => 'Mia Member']);
        foreach ([$owner, $member] as $u) {
            WorkHour::create(['user_id' => $u->id, 'date' => now()->subWeek()->toDateString(), 'hours' => 2, 'description' => 'x', 'work_type' => 'admin', 'source' => 'manual']);
        }

        $props = $this->actingAs($owner)->get(route('summary.index'))->assertOk()->viewData('page')['props'];
        $names = collect($props['users'])->pluck('name');
        $rowUsers = collect($props['rows'])->map(fn ($r) => $r[0])->unique()->values();

        $this->assertContains('Mia Member', $names);
        $this->assertNotContains('Olivia Owner', $names);
        $this->assertContains($member->id, $rowUsers);
        $this->assertNotContains($owner->id, $rowUsers);
    }

    public function test_owner_cannot_clock_in_or_log_hours(): void
    {
        $owner = User::factory()->create(['role' => 'owner']);
        $super = User::factory()->create(['role' => 'super_admin']);

        $this->actingAs($owner)->postJson('/time-entries', ['action_type' => 'clock_in'])->assertStatus(422);
        $this->assertSame(0, TimeEntry::where('user_id', $owner->id)->count());

        $this->actingAs($super)->postJson('/time-entries', ['action_type' => 'clock_in'])->assertOk();

        $this->actingAs($owner)->post(route('work-hours.store'), [
            'date' => now()->toDateString(), 'hours' => 1, 'minutes' => 0, 'description' => 'x', 'work_type' => 'admin',
        ])->assertForbidden();
    }

    public function test_owner_cannot_use_the_desktop_tracker(): void
    {
        $owner = User::factory()->create(['role' => 'owner', 'password' => 'correct-horse-battery']);

        $this->postJson('/api/desktop/login', [
            'email' => $owner->email, 'password' => 'correct-horse-battery', 'device_name' => 'pc',
        ])->assertStatus(422);

        // A token issued before the promotion stops working on its next call.
        $token = $owner->createToken('pc')->plainTextToken;
        $this->withHeader('Authorization', "Bearer $token")->getJson('/api/desktop/me')->assertForbidden();
        $this->assertSame(0, $owner->tokens()->count());
    }

    public function test_only_an_owner_can_make_or_change_an_owner(): void
    {
        $owner = User::factory()->create(['role' => 'owner']);
        $super = User::factory()->create(['role' => 'super_admin']);
        $member = User::factory()->create();

        $payload = fn (User $u, string $role) => ['name' => $u->name, 'email' => $u->email, 'role' => $role];

        // Super Admin can't promote to Owner...
        $this->actingAs($super)->put(route('users.update', $member), $payload($member, 'owner'))
            ->assertSessionHasErrors('role');
        $this->assertSame('member', $member->fresh()->role);

        // ...or touch an Owner at all.
        $this->actingAs($super)->put(route('users.update', $owner), $payload($owner, 'member'))->assertForbidden();
        $this->actingAs($super)->postJson(route('users.bulk-update'), ['user_ids' => [$owner->id], 'set_role' => true, 'role' => 'member']);
        $this->assertSame('owner', $owner->fresh()->role);

        // An Owner can.
        $this->actingAs($owner)->put(route('users.update', $member), $payload($member, 'owner'))->assertSessionHasNoErrors();
        $this->assertSame('owner', $member->fresh()->role);

        // An Owner can't drop their own Owner role.
        $this->actingAs($owner)->put(route('users.update', $owner), $payload($owner, 'super_admin'))
            ->assertSessionHasErrors('role');
        $this->assertSame('owner', $owner->fresh()->role);
    }

    public function test_make_owner_command_promotes_and_signs_out_the_tracker(): void
    {
        $user = User::factory()->create(['role' => 'super_admin', 'email' => 'boss@example.test']);
        $user->createToken('pc');

        $this->artisan('user:make-owner', ['email' => ['boss@example.test', 'nobody@example.test']])
            ->assertFailed();

        $this->assertSame('owner', $user->fresh()->role);
        $this->assertSame(0, $user->tokens()->count());
    }
}
