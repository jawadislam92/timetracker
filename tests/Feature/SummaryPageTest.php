<?php

namespace Tests\Feature;

use App\Models\Client;
use App\Models\Designation;
use App\Models\User;
use App\Models\WorkHour;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\TestCase;

/**
 * The Summary page: Work Diary hours aggregated per person · day · work type ·
 * client, people tagged with their department (via designation), the
 * previous period for deltas, and per-viewer saved layouts.
 */
class SummaryPageTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        // Tuesday 27 Oct 2026: "last 4 weeks" = Mon 28 Sep .. Sun 25 Oct.
        $this->travelTo(Carbon::parse('2026-10-27 12:00:00', 'Asia/Karachi'));
    }

    private function viewer(array $permissions = ['reports.view']): User
    {
        return User::factory()->create(['role' => 'admin', 'permissions' => $permissions]);
    }

    private function hours(User $user, string $date, string $type, float $hours, ?int $clientId = null): void
    {
        WorkHour::create(['user_id' => $user->id, 'date' => $date, 'work_type' => $type, 'hours' => $hours, 'client_id' => $clientId, 'source' => 'manual']);
    }

    public function test_people_without_report_access_cannot_open_it(): void
    {
        $member = User::factory()->create(['role' => 'member', 'permissions' => []]);

        $this->actingAs($member)->get('/summary')->assertForbidden();
        $this->actingAs($member)->putJson('/summary/layout', ['layout' => []])->assertForbidden();
    }

    public function test_rows_are_aggregated_and_people_carry_their_department(): void
    {
        Designation::updateOrCreate(['name' => 'Graphic Designer'], ['department' => 'Graphic Design']);
        $client = Client::create(['name' => 'Acme']);
        $designer = User::factory()->create(['designation' => 'graphic designer', 'name' => 'Dina']);
        $nobody = User::factory()->create(['designation' => 'Mystery Role', 'name' => 'Zed']);

        $this->hours($designer, '2026-10-05', 'manual', 2, $client->id);
        $this->hours($designer, '2026-10-05', 'manual', 1.5, $client->id); // merges with the row above
        $this->hours($designer, '2026-10-06', 'office_work', 3);
        $this->hours($designer, '2026-10-26', 'manual', 9, $client->id);   // this week: outside the range
        $this->hours($designer, '2026-09-20', 'tracker', 4, $client->id);  // previous period
        $this->hours($designer, '2026-09-21', 'office_work', 4);           // previous period

        $this->actingAs($this->viewer())->get('/summary')
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page
                ->component('Summary/Index')
                ->where('range', 'last_4_weeks')
                ->where('start', '2026-09-28')
                ->where('end', '2026-10-25')
                ->where('rows', fn ($rows) => collect($rows)->values()->all() === [
                    [$designer->id, '2026-10-05', 'manual', $client->id, 3.5],
                    [$designer->id, '2026-10-06', 'office_work', null, 3.0],
                ] || collect($rows)->map(fn ($r) => [$r[0], $r[1], $r[2], $r[3], (float) $r[4]])->all() === [
                    [$designer->id, '2026-10-05', 'manual', $client->id, 3.5],
                    [$designer->id, '2026-10-06', 'office_work', null, 3.0],
                ])
                ->where('clients.'.$client->id, 'Acme')
                ->where('previous.start', '2026-08-31')
                ->where('previous.people', fn ($p) => collect($p)->map(fn ($r) => [$r[0], (float) $r[1], (float) $r[2]])->all() === [[$designer->id, 8.0, 4.0]])
                ->where('users', fn ($users) => collect($users)->firstWhere('id', $designer->id)['department'] === 'Graphic Design'
                    && collect($users)->firstWhere('id', $nobody->id)['department'] === Designation::UNASSIGNED)
                ->where('canEditDepartments', false));
    }

    public function test_presets_and_custom_ranges_resolve_safely(): void
    {
        $viewer = $this->viewer();

        $this->actingAs($viewer)->get('/summary?range=this_week')
            ->assertInertia(fn (Assert $page) => $page->where('start', '2026-10-26')->where('end', '2026-10-27'));

        $this->actingAs($viewer)->get('/summary?range=last_month')
            ->assertInertia(fn (Assert $page) => $page->where('start', '2026-09-01')->where('end', '2026-09-30'));

        // Reversed dates are swapped; an over-long range is clamped to 186 days.
        $this->actingAs($viewer)->get('/summary?range=custom&start=2026-10-10&end=2026-10-01')
            ->assertInertia(fn (Assert $page) => $page->where('start', '2026-10-01')->where('end', '2026-10-10'));

        $this->actingAs($viewer)->get('/summary?range=custom&start=2025-01-01&end=2026-10-27')
            ->assertInertia(fn (Assert $page) => $page->where('start', '2026-04-25')->where('end', '2026-10-27'));

        $this->actingAs($viewer)->get('/summary?range=custom&start=garbage&end=2026-10-27')->assertOk();
    }

    public function test_layout_is_saved_to_the_viewers_own_account(): void
    {
        $viewer = $this->viewer();
        $layout = ['widgets' => ['company' => [['id' => 'kpis', 'size' => 'full', 'on' => true]]], 'settings' => ['lowShare' => 40]];

        $this->actingAs($viewer)->putJson('/summary/layout', ['layout' => $layout])->assertOk();

        $this->assertSame($layout, $viewer->fresh()->summary_layout);
        $this->actingAs($viewer)->get('/summary')->assertInertia(fn (Assert $page) => $page->where('layout.settings.lowShare', 40));
    }

    public function test_departments_are_remapped_case_insensitively_and_only_by_user_managers(): void
    {
        Designation::updateOrCreate(['name' => 'Admin Assistant'], ['department' => 'Virtual Assistants']);
        $payload = ['designations' => [
            ['name' => 'admin assistant', 'department' => 'Operations'],
            ['name' => 'BDE', 'department' => 'Business Development'],
        ]];

        $this->actingAs($this->viewer())->putJson('/summary/departments', $payload)->assertForbidden();

        $this->actingAs($this->viewer(['reports.view', 'users.manage']))->put('/summary/departments', $payload)->assertRedirect();

        $this->assertSame(1, Designation::whereRaw('LOWER(name) = ?', ['admin assistant'])->count());
        $this->assertSame('Operations', Designation::where('name', 'Admin Assistant')->value('department'));
        $this->assertSame('Business Development', Designation::where('name', 'BDE')->value('department'));
        $map = Designation::departmentMap();
        $this->assertSame('Operations', $map['admin assistant']);
        $this->assertSame('Business Development', $map['bde']);
    }

    public function test_unassigned_is_reserved(): void
    {
        $this->actingAs($this->viewer(['reports.view', 'users.manage']))
            ->putJson('/summary/departments', ['designations' => [['name' => 'BDE', 'department' => 'Unassigned']]])
            ->assertUnprocessable();
    }
}
