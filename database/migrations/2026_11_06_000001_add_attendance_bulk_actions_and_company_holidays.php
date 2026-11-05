<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('attendance_bulk_actions', function (Blueprint $table) {
            $table->id();
            $table->string('operation', 10);
            $table->string('status_code', 10)->nullable();
            $table->date('start_date');
            $table->date('end_date');
            $table->unsignedInteger('people_count');
            $table->unsignedInteger('days_count');
            $table->unsignedInteger('cells_count')->default(0);
            $table->string('note')->nullable();
            $table->foreignId('changed_by_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamp('undone_at')->nullable();
            $table->foreignId('undone_by_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();

            $table->index(['start_date', 'end_date']);
        });

        // old_note makes an undo exact: `reason` alone cannot restore the note a
        // replaced mark carried.
        Schema::table('manual_attendance_audits', function (Blueprint $table) {
            $table->foreignId('bulk_action_id')->nullable()->after('id')->constrained('attendance_bulk_actions')->nullOnDelete();
            $table->string('old_note')->nullable()->after('reason');
        });

        Schema::create('company_holidays', function (Blueprint $table) {
            $table->id();
            $table->date('date')->unique();
            $table->string('name', 120);
            $table->string('status_code', 10)->default('H');
            $table->foreignId('created_by_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('company_holidays');

        Schema::table('manual_attendance_audits', function (Blueprint $table) {
            $table->dropConstrainedForeignId('bulk_action_id');
            $table->dropColumn('old_note');
        });

        Schema::dropIfExists('attendance_bulk_actions');
    }
};
