<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class ManualAttendanceAudit extends Model
{
    use HasFactory;

    public const UPDATED_AT = null;

    protected $fillable = [
        'bulk_action_id',
        'old_note',
        'user_id',
        'attendance_date',
        'old_status_code',
        'new_status_code',
        'changed_by_user_id',
        'changed_at',
        'reason',
    ];

    protected $casts = [
        'attendance_date' => 'date',
        'changed_at' => 'datetime',
    ];

    public function user()
    {
        return $this->belongsTo(User::class);
    }

    public function changedBy()
    {
        return $this->belongsTo(User::class, 'changed_by_user_id');
    }
}
