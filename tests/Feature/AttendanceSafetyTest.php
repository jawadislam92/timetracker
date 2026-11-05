<?php

namespace Tests\Feature;

use App\Models\AttendanceBulkAction;
use App\Models\CompanyHoliday;
use App\Models\ManualAttendanceMark;
use App\Models\TimeEntry;
use App\Models\User;
use App\Services\PayrollExportService;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Guards against a repeat of the Oct 2026 mistake, where one bulk "Holiday"
 * across the wrong days wrote 244 cells with no way back.
 */
class AttendanceSafetyTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;

    private User $amna;

    private User $bilal;

    protected function setUp(): void
    {
        parent::setUp();
        Carbon::setTestNow(Carbon::parse('2026-10-14 12:00:00', 'Asia/Karachi'));
        $this->admin = User::factory()->create(['role' => 'super_admin', 'name' => 'Admin', 'joining_date' => '2026-01-01']);
        $this->amna = User::factory()->create(['name' => 'Amna', 'joining_date' => '2026-01-01']);
        $this->bilal = User::factory()->create(['name' => 'Bilal', 'joining_date' => '2026-01-01']);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function clockIn(User $user, string $date): void
    {
        TimeEntry::create([
            'user_id' => $user->id,
            'action_type' => 'clock_in',
            'action_timestamp' => Carbon::parse("{$date} 09:00:00", 'Asia/Karachi'),
            'action_date' => $date,
            'action_time' => '09:00:00',
        ]);
    }

    private function mark(User $user, string $date, string $code, ?string $note = null): ManualAttendanceMark
    {
        return ManualAttendanceMark::create(['user_id' => $user->id, 'attendance_date' => $date, 'status_code' => $code, 'note' => $note]);
    }

    private function markFor(User $user, string $date): ?ManualAttendanceMark
    {
        return ManualAttendanceMark::where('user_id', $user->id)->whereDate('attendance_date', $date)->first();
    }

    private function holiday(array $overrides = []): array
    {
        return $overrides + [
            'operation' => 'apply',
            'scope' => 'selected',
            'user_ids' => [$this->amna->id, $this->bilal->id],
            'start_date' => '2026-10-12',
            'end_date' => '2026-10-13',
            'status_code' => 'H',
            'note' => 'Eid',
        ];
    }

    private function apply(array $payload): int
    {
        return $this->actingAs($this->admin)
            ->postJson(route('employee-attendance.calendar'), $payload)
            ->assertOk()
            ->json('bulk_action_id');
    }

    private function gridCell(User $user, string $date, array $params = ['month' => '2026-10']): array
    {
        $grid = $this->actingAs($this->admin)->getJson(route('employee-attendance.monthly', $params))->assertOk()->json();
        $row = collect($grid['employees'])->firstWhere('user_id', $user->id);

        return collect($row['days'])->firstWhere('date', $date);
    }

    public function test_preview_names_the_days_warns_about_clock_ins_and_changes_nothing(): void
    {
        $this->clockIn($this->amna, '2026-10-12');
        $this->clockIn($this->bilal, '2026-10-12');
        $this->clockIn($this->bilal, '2026-10-13');
        $this->mark($this->amna, '2026-10-13', 'L');

        $response = $this->actingAs($this->admin)
            ->postJson(route('employee-attendance.calendar-preview'), $this->holiday())
            ->assertOk()
            ->assertJsonPath('people', 2)
            ->assertJsonPath('cells', 4)
            ->assertJsonPath('replaced', 1)
            ->assertJsonPath('status_label', 'Holiday');

        $days = $response->json('days');
        $this->assertSame(['Mon 12 Oct', 'Tue 13 Oct'], array_column($days, 'label'));
        $this->assertSame([2, 1], array_column($days, 'clocked_in'));
        $this->assertSame([0, 1], array_column($days, 'replaced'));

        $this->assertSame(1, ManualAttendanceMark::count());
        $this->assertSame(0, AttendanceBulkAction::count());
    }

    public function test_preview_validates_like_the_real_change(): void
    {
        $this->actingAs($this->admin)
            ->postJson(route('employee-attendance.calendar-preview'), $this->holiday(['end_date' => '2026-10-01']))
            ->assertStatus(422);

        $this->actingAs($this->amna)
            ->postJson(route('employee-attendance.calendar-preview'), $this->holiday())
            ->assertForbidden();
    }

    public function test_undo_restores_exactly_what_was_there_including_notes(): void
    {
        $this->mark($this->amna, '2026-10-12', 'L', 'Sick');

        $id = $this->apply($this->holiday());
        $this->assertSame('H', $this->markFor($this->amna, '2026-10-12')->status_code);
        $this->assertSame(4, ManualAttendanceMark::count());
        $this->assertSame(4, AttendanceBulkAction::find($id)->cells_count);

        $this->actingAs($this->admin)->postJson(route('employee-attendance.bulk-undo', $id))
            ->assertOk()
            ->assertJsonPath('restored', 4)
            ->assertJsonPath('skipped', 0);

        $restored = $this->markFor($this->amna, '2026-10-12');
        $this->assertSame('L', $restored->status_code);
        $this->assertSame('Sick', $restored->note);
        $this->assertSame(1, ManualAttendanceMark::count());
    }

    public function test_undo_leaves_cells_changed_afterwards_alone(): void
    {
        $id = $this->apply($this->holiday());

        $this->actingAs($this->admin)->patchJson(route('employee-attendance.manual-status'), [
            'user_id' => $this->amna->id,
            'date' => '2026-10-12',
            'status_code' => 'WFH',
        ])->assertOk();

        $this->actingAs($this->admin)->postJson(route('employee-attendance.bulk-undo', $id))
            ->assertOk()
            ->assertJsonPath('restored', 3)
            ->assertJsonPath('skipped', 1);

        $this->assertSame('WFH', $this->markFor($this->amna, '2026-10-12')->status_code);
        $this->assertSame(1, ManualAttendanceMark::count());
    }

    public function test_undo_brings_back_marks_that_a_clear_removed(): void
    {
        $this->mark($this->amna, '2026-10-12', 'L', 'Sick');
        $this->mark($this->bilal, '2026-10-13', 'WFH');

        $id = $this->apply($this->holiday(['operation' => 'clear', 'status_code' => null, 'note' => null]));
        $this->assertSame(0, ManualAttendanceMark::count());

        $this->actingAs($this->admin)->postJson(route('employee-attendance.bulk-undo', $id))->assertOk();

        $this->assertSame('Sick', $this->markFor($this->amna, '2026-10-12')->note);
        $this->assertSame('WFH', $this->markFor($this->bilal, '2026-10-13')->status_code);
    }

    public function test_undo_only_works_once_and_needs_permission(): void
    {
        $id = $this->apply($this->holiday());

        $this->actingAs($this->amna)->postJson(route('employee-attendance.bulk-undo', $id))->assertForbidden();
        $this->assertSame(4, ManualAttendanceMark::count());

        $this->actingAs($this->admin)->postJson(route('employee-attendance.bulk-undo', $id))->assertOk();
        $this->actingAs($this->admin)->postJson(route('employee-attendance.bulk-undo', $id))->assertStatus(422);
    }

    public function test_reapplying_the_same_status_is_not_an_undoable_change(): void
    {
        $this->apply($this->holiday());

        $response = $this->actingAs($this->admin)->postJson(route('employee-attendance.calendar'), $this->holiday())->assertOk();

        $this->assertNull($response->json('bulk_action_id'));
        $this->assertSame(1, AttendanceBulkAction::count());
    }

    public function test_history_lists_each_bulk_change_as_one_line(): void
    {
        $id = $this->apply($this->holiday());

        $this->actingAs($this->admin)->getJson(route('employee-attendance.manual-history', ['month' => '2026-10']))
            ->assertOk()
            ->assertJsonCount(1, 'bulk_actions')
            ->assertJsonPath('bulk_actions.0.id', $id)
            ->assertJsonPath('bulk_actions.0.status_label', 'Holiday')
            ->assertJsonPath('bulk_actions.0.people', 2)
            ->assertJsonPath('bulk_actions.0.days', 2)
            ->assertJsonPath('bulk_actions.0.range', 'Mon 12 Oct to Tue 13 Oct')
            ->assertJsonPath('bulk_actions.0.undone', false);
    }

    public function test_company_holiday_applies_to_everyone_but_never_hides_real_attendance(): void
    {
        CompanyHoliday::create(['date' => '2026-10-12', 'name' => 'Founders day', 'status_code' => 'PH']);
        $this->clockIn($this->amna, '2026-10-12');

        $this->assertSame('PH', $this->gridCell($this->bilal, '2026-10-12')['status_code']);
        $this->assertSame('P', $this->gridCell($this->amna, '2026-10-12')['status_code']);
    }

    public function test_company_holiday_covers_new_joiners_and_future_days_and_a_manual_mark_wins(): void
    {
        CompanyHoliday::create(['date' => '2026-10-12', 'name' => 'Founders day', 'status_code' => 'H']);
        CompanyHoliday::create(['date' => '2026-10-20', 'name' => 'Next week', 'status_code' => 'PH']);
        $joiner = User::factory()->create(['name' => 'Joiner', 'joining_date' => '2026-10-01']);
        $late = User::factory()->create(['name' => 'Late', 'joining_date' => '2026-10-13']);
        $this->mark($this->bilal, '2026-10-12', 'L');

        $this->assertSame('H', $this->gridCell($joiner, '2026-10-12')['status_code']);
        $this->assertSame('PH', $this->gridCell($joiner, '2026-10-20')['status_code']);
        $this->assertSame('LI', $this->gridCell($late, '2026-10-12')['status_code']);
        $this->assertSame('L', $this->gridCell($this->bilal, '2026-10-12')['status_code']);
    }

    public function test_payroll_export_sees_the_same_holiday_as_the_grid(): void
    {
        CompanyHoliday::create(['date' => '2026-10-12', 'name' => 'Founders day', 'status_code' => 'PH']);

        $rows = collect(app(PayrollExportService::class)->attendance('2026-10', [$this->bilal->id]));
        $this->assertStringContainsString('"PH"', json_encode($rows));
    }

    public function test_holiday_list_add_duplicate_and_remove(): void
    {
        $this->clockIn($this->amna, '2026-10-12');

        $id = $this->actingAs($this->admin)->postJson(route('employee-attendance.holidays.store'), [
            'date' => '2026-10-12', 'name' => 'Founders day', 'status_code' => 'H',
        ])->assertCreated()
            ->assertJsonPath('message', 'Holiday added. 1 person clocked in that day and will stay Present.')
            ->json('id');

        $this->actingAs($this->admin)->postJson(route('employee-attendance.holidays.store'), [
            'date' => '2026-10-12', 'name' => 'Again', 'status_code' => 'H',
        ])->assertStatus(422);

        $this->actingAs($this->admin)->getJson(route('employee-attendance.holidays', ['year' => 2026]))
            ->assertOk()
            ->assertJsonPath('holidays.0.label', 'Mon 12 Oct 2026');

        $this->actingAs($this->amna)->deleteJson(route('employee-attendance.holidays.destroy', $id))->assertForbidden();
        $this->actingAs($this->admin)->deleteJson(route('employee-attendance.holidays.destroy', $id))->assertOk();
        $this->assertSame(0, CompanyHoliday::count());
    }

    public function test_week_view_is_monday_to_sunday_even_across_a_month_end(): void
    {
        $grid = $this->actingAs($this->admin)
            ->getJson(route('employee-attendance.monthly', ['week' => '2026-10-01']))
            ->assertOk()
            ->json();

        $this->assertSame(
            ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'],
            array_column($grid['days'], 'date')
        );
        $this->assertSame('Mon', $grid['days'][0]['weekday']);
        $this->assertCount(7, $grid['employees'][0]['days']);
    }

    public function test_week_view_carries_holiday_names_and_month_view_is_unchanged(): void
    {
        CompanyHoliday::create(['date' => '2026-10-12', 'name' => 'Founders day', 'status_code' => 'H']);

        $week = $this->actingAs($this->admin)->getJson(route('employee-attendance.monthly', ['week' => '2026-10-14']))->json();
        $this->assertSame('Founders day', collect($week['days'])->firstWhere('date', '2026-10-12')['holiday']);

        $month = $this->actingAs($this->admin)->getJson(route('employee-attendance.monthly', ['month' => '2026-10']))->json();
        $this->assertCount(31, $month['days']);
        $this->assertSame('2026-10-31', end($month['days'])['date']);
    }
}
