<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Schema;

/** One "Attendance calendar" change, however many cells it touched; the unit of Undo. */
class AttendanceBulkAction extends Model
{
    protected $fillable = [
        'operation',
        'status_code',
        'start_date',
        'end_date',
        'people_count',
        'days_count',
        'cells_count',
        'note',
        'changed_by_user_id',
        'undone_at',
        'undone_by_user_id',
    ];

    protected $casts = [
        'start_date' => 'date',
        'end_date' => 'date',
        'undone_at' => 'datetime',
    ];

    private static ?bool $available = null;

    /** Hostinger deploys code before migrations run, so writes must tolerate the gap. */
    public static function available(): bool
    {
        return self::$available ??= Schema::hasTable('attendance_bulk_actions');
    }

    public function audits()
    {
        return $this->hasMany(ManualAttendanceAudit::class, 'bulk_action_id');
    }

    public function changedBy()
    {
        return $this->belongsTo(User::class, 'changed_by_user_id');
    }
}
