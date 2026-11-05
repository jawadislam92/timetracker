<?php

namespace Tests\Feature;

use App\Models\TimeEntry;
use App\Models\User;
use App\Support\ClockSource;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ClockSourceTest extends TestCase
{
    use RefreshDatabase;

    private const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1';

    private const ANDROID_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36';

    private const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

    private const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    public function test_user_agents_map_to_devices(): void
    {
        $this->assertSame('mobile', ClockSource::fromUserAgent(self::IPHONE));
        $this->assertSame('mobile', ClockSource::fromUserAgent(self::ANDROID_PHONE));
        $this->assertSame('tablet', ClockSource::fromUserAgent(self::ANDROID_TABLET));
        $this->assertSame('web', ClockSource::fromUserAgent(self::WINDOWS));
        $this->assertSame('system', ClockSource::fromUserAgent(null));
    }

    public function test_web_clock_in_records_the_device_and_attendance_shows_it(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-11-06 09:00:00', 'Asia/Karachi'));
        $user = User::factory()->create(['role' => 'super_admin']);

        $this->actingAs($user)->withHeader('User-Agent', self::IPHONE)
            ->postJson('/time-entries', ['action_type' => 'clock_in'])->assertOk();
        Carbon::setTestNow(Carbon::parse('2026-11-06 17:00:00', 'Asia/Karachi'));
        $this->actingAs($user)->withHeader('User-Agent', self::WINDOWS)
            ->postJson('/time-entries', ['action_type' => 'clock_out'])->assertOk();

        $this->assertSame(['mobile', 'web'], TimeEntry::orderBy('id')->pluck('clock_source')->all());

        $this->actingAs($user)->getJson(route('employee-attendance.summary', ['date' => '2026-11-06']))
            ->assertJsonPath('employees.0.clock_in_via', 'Phone')
            ->assertJsonPath('employees.0.clock_out_via', 'Website');

        $this->actingAs($user)->getJson(route('employee-attendance.detailed', ['date' => '2026-11-06']))
            ->assertJsonPath('activities.0.entries.0.source_label', 'Phone');
    }

    public function test_desktop_admin_and_automatic_events_are_labelled(): void
    {
        $user = User::factory()->create();
        $make = fn (?string $notes) => TimeEntry::create([
            'user_id' => $user->id,
            'action_type' => 'clock_out',
            'action_timestamp' => now(),
            'action_date' => now()->toDateString(),
            'action_time' => '17:00:00',
            'notes' => $notes,
        ]);

        $this->assertSame('admin', $make('Admin clock-out')->clock_source);
        $this->assertSame('system', $make('Auto clock-out: no activity')->clock_source);
        $this->assertSame('system', $make(null)->clock_source);

        $this->get('/api/desktop/nothing');
        $this->assertSame('desktop_app', $make('Desktop app')->clock_source);
    }

    public function test_entries_from_before_this_existed_show_no_source(): void
    {
        $this->assertNull(ClockSource::label(null));
    }
}
