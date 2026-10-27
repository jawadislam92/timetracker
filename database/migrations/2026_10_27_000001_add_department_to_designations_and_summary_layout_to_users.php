<?php

use App\Models\Designation;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Departments for the Summary page.
 *
 * A department hangs off the designation (job title), so everyone with the
 * same title lands in the same team without editing each person. Designations
 * people actually carry but that were never added to the designations table
 * ("BDE", "Admin assistant", "Developer") are created here so the Summary's
 * department editor can see and re-map them.
 *
 * users.summary_layout keeps each viewer's chosen Summary widgets, so the
 * layout follows them to any computer.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasColumn('designations', 'department')) {
            Schema::table('designations', function (Blueprint $table) {
                $table->string('department')->nullable()->after('name');
            });
        }

        if (! Schema::hasColumn('users', 'summary_layout')) {
            Schema::table('users', function (Blueprint $table) {
                $table->json('summary_layout')->nullable();
            });
        }

        $existing = DB::table('designations')->get(['id', 'name', 'department'])
            ->keyBy(fn ($row) => mb_strtolower(trim($row->name)));

        $inUse = DB::table('users')->whereNotNull('designation')->where('designation', '!=', '')
            ->distinct()->pluck('designation')
            ->map(fn ($name) => trim($name))
            ->unique(fn ($name) => mb_strtolower($name));

        foreach ($inUse as $name) {
            if (! $existing->has(mb_strtolower($name))) {
                $id = DB::table('designations')->insertGetId(['name' => $name, 'created_at' => now(), 'updated_at' => now()]);
                $existing->put(mb_strtolower($name), (object) ['id' => $id, 'name' => $name, 'department' => null]);
            }
        }

        foreach ($existing as $key => $row) {
            $department = Designation::DEFAULT_DEPARTMENTS[$key] ?? null;
            if ($department && ! $row->department) {
                DB::table('designations')->where('id', $row->id)->update(['department' => $department]);
            }
        }
    }

    public function down(): void
    {
        if (Schema::hasColumn('designations', 'department')) {
            Schema::table('designations', fn (Blueprint $table) => $table->dropColumn('department'));
        }
        if (Schema::hasColumn('users', 'summary_layout')) {
            Schema::table('users', fn (Blueprint $table) => $table->dropColumn('summary_layout'));
        }
    }
};
