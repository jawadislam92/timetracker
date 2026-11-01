<?php

namespace Tests\Feature;

use App\Models\Client;
use App\Models\User;
use App\Models\WorkHour;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class MergeDuplicateClientsTest extends TestCase
{
    use RefreshDatabase;

    private function hours(User $u, Client $c, float $h): void
    {
        WorkHour::create(['user_id' => $u->id, 'date' => '2026-10-01', 'work_type' => 'manual', 'hours' => $h, 'client_id' => $c->id, 'source' => 'manual']);
    }

    private function profile(string $name): int
    {
        return DB::table('upwork_profiles')->insertGetId(['name' => $name, 'created_at' => now(), 'updated_at' => now()]);
    }

    public function test_dry_run_changes_nothing(): void
    {
        Client::create(['name' => 'Vishal Sardana']);
        Client::create(['name' => 'Vishal sardana']);

        $this->artisan('clients:merge-duplicates')->assertSuccessful();

        $this->assertSame(2, Client::count());
    }

    public function test_apply_moves_hours_combines_profiles_and_keeps_the_busiest_record(): void
    {
        Storage::fake('local');
        $u = User::factory()->create();
        $big = Client::create(['name' => 'Vishal Sardana', 'is_active' => false]);
        $small = Client::create(['name' => "Vishal\tsardana ", 'is_active' => true, 'email' => 'v@example.com']);
        $other = Client::create(['name' => 'Someone Else']);
        $this->hours($u, $big, 5);
        $this->hours($u, $big, 2);
        $this->hours($u, $small, 1);
        $p1 = $this->profile('P1');
        $p2 = $this->profile('P2');
        DB::table('client_upwork_profile')->insert([
            ['client_id' => $big->id, 'upwork_profile_id' => $p1],
            ['client_id' => $small->id, 'upwork_profile_id' => $p1],
            ['client_id' => $small->id, 'upwork_profile_id' => $p2],
        ]);

        $this->artisan('clients:merge-duplicates', ['--apply' => true])->assertSuccessful();

        $this->assertNull(Client::find($small->id));
        $kept = Client::find($big->id);
        $this->assertSame('Vishal Sardana', $kept->name);
        $this->assertTrue((bool) $kept->is_active);
        $this->assertSame('v@example.com', $kept->email);
        $this->assertSame(3, WorkHour::where('client_id', $big->id)->count());
        $this->assertEquals(8.0, (float) WorkHour::where('client_id', $big->id)->sum('hours'));
        $this->assertEqualsCanonicalizing([$p1, $p2], DB::table('client_upwork_profile')->where('client_id', $big->id)->pluck('upwork_profile_id')->all());
        $this->assertNotNull(Client::find($other->id));
        $this->assertCount(1, Storage::disk('local')->files('client-merge-backups'));
    }
}
