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
 * Work Hours Report "Display settings" and "Filter by": roll-ups by person /
 * client / department split by day-week-month, a department filter, true
 * grand totals across every page, and the saved per-viewer choice.
 */
class ReportDisplaySettingsTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;

    private User $designer;

    private User $va;

    private Client $acme;

    protected function setUp(): void
    {
        parent::setUp();
        $this->travelTo(Carbon::parse('2026-11-01 12:00:00', 'Asia/Karachi'));
        Designation::updateOrCreate(['name' => 'Graphic Designer'], ['department' => 'Graphic Design']);
        Designation::updateOrCreate(['name' => 'Admin assistant'], ['department' => 'Virtual Assistants']);

        $this->admin = User::factory()->create(['role' => 'admin', 'permissions' => ['reports.view']]);
        $this->designer = User::factory()->create(['name' => 'Dina', 'designation' => 'Graphic Designer']);
        $this->va = User::factory()->create(['name' => 'Vik', 'designation' => 'admin assistant']);
        $this->acme = Client::create(['name' => 'Acme']);

        $this->log($this->designer, '2026-10-20', 'manual', 3, $this->acme->id);   // Tue, week of 19 Oct
        $this->log($this->designer, '2026-10-27', 'tracker', 2, $this->acme->id);  // Tue, week of 26 Oct
        $this->log($this->designer, '2026-10-27', 'office_work', 1);
        $this->log($this->va, '2026-10-28', 'office_work', 4);
    }

    private function log(User $u, string $date, string $type, float $h, ?int $client = null): void
    {
        WorkHour::create(['user_id' => $u->id, 'date' => $date, 'work_type' => $type, 'hours' => $h, 'client_id' => $client, 'source' => 'manual']);
    }

    public function test_totals_cover_every_page_not_just_the_first(): void
    {
        $this->actingAs($this->admin)->get(route('work-hours.report', ['perPage' => 10, 'page' => 1]))
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page
                ->where('show', 'entries')
                ->where('totals.hours', 10)
                ->where('totals.billable', 5)
                ->where('totals.entries', 4)
                ->where('summary', null));
    }

    public function test_people_grouped_by_week_roll_up_per_week(): void
    {
        $this->actingAs($this->admin)->get(route('work-hours.report', ['show' => 'person', 'group' => 'week']))
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page
                ->where('show', 'person')
                ->where('group', 'week')
                ->where('workHours', null)
                ->where('summary.rows', function ($rows) {
                    $rows = collect($rows)->map(fn ($r) => [$r['period'], $r['label'], (float) $r['hours'], (float) $r['billable']])->all();

                    return $rows === [
                        ['2026-10-19', 'Dina', 3.0, 3.0],
                        ['2026-10-26', 'Vik', 4.0, 0.0],
                        ['2026-10-26', 'Dina', 3.0, 2.0],
                    ];
                }));
    }

    public function test_department_view_and_department_filter(): void
    {
        $this->actingAs($this->admin)->get(route('work-hours.report', ['show' => 'department']))
            ->assertInertia(fn (Assert $page) => $page->where('summary.rows', fn ($rows) => collect($rows)->pluck('hours', 'label')->map(fn ($h) => (float) $h)->all() === ['Graphic Design' => 6.0, 'Virtual Assistants' => 4.0]));

        $this->actingAs($this->admin)->get(route('work-hours.report', ['departments' => ['Virtual Assistants']]))
            ->assertInertia(fn (Assert $page) => $page->where('totals.hours', 4)->where('workHours.total', 1));

        $this->actingAs($this->admin)->get(route('work-hours.report', ['departments' => ['No Such Team']]))
            ->assertInertia(fn (Assert $page) => $page->where('totals.hours', 0));
    }

    public function test_entry_view_gets_full_period_totals_when_grouped(): void
    {
        $this->actingAs($this->admin)->get(route('work-hours.report', ['group' => 'month']))
            ->assertInertia(fn (Assert $page) => $page->where('periodTotals', fn ($t) => collect($t)->map(fn ($v) => (float) $v)->all() === ['2026-10' => 10.0]));
    }

    public function test_saved_display_choice_is_used_and_kept_apart_from_the_summary_layout(): void
    {
        $this->actingAs($this->admin)->putJson('/summary/layout', ['layout' => ['settings' => ['lowShare' => 40]]])->assertOk();
        $this->actingAs($this->admin)->putJson('/summary/layout', ['section' => 'report', 'layout' => ['show' => 'client', 'group' => 'none']])->assertOk();
        $this->actingAs($this->admin)->putJson('/summary/layout', ['layout' => ['settings' => ['lowShare' => 30]]])->assertOk();

        $saved = $this->admin->fresh()->summary_layout;
        $this->assertSame(30, $saved['settings']['lowShare']);
        $this->assertSame('client', $saved['report']['show']);

        $this->actingAs($this->admin)->get(route('work-hours.report'))
            ->assertInertia(fn (Assert $page) => $page->where('show', 'client')->where('summary.rows', fn ($rows) => collect($rows)->pluck('hours', 'label')->map(fn ($h) => (float) $h)->sortKeys()->all() === ['Acme' => 5.0, 'No client' => 5.0]));

        // The Summary page never sees the report's section.
        $this->actingAs($this->admin)->get('/summary')
            ->assertInertia(fn (Assert $page) => $page->missing('layout.report'));
    }
}
