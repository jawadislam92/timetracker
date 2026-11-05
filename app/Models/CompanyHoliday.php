<?php

namespace App\Models;

use Carbon\CarbonInterface;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Schema;

/** One row per day off for everyone, including people who join later. */
class CompanyHoliday extends Model
{
    public const STATUS_CODES = ['H', 'PH'];

    protected $fillable = ['date', 'name', 'status_code', 'created_by_user_id'];

    protected $casts = ['date' => 'date'];

    private static ?bool $available = null;

    public static function available(): bool
    {
        return self::$available ??= Schema::hasTable('company_holidays');
    }

    /** @return array<string, self> keyed by Y-m-d */
    public static function between(CarbonInterface|string $start, CarbonInterface|string $end): array
    {
        if (! self::available()) {
            return [];
        }

        $start = is_string($start) ? $start : $start->toDateString();
        $end = is_string($end) ? $end : $end->toDateString();

        return self::query()
            ->whereDate('date', '>=', $start)
            ->whereDate('date', '<=', $end)
            ->get()
            ->keyBy(fn (self $holiday) => $holiday->date->toDateString())
            ->all();
    }

    public function createdBy()
    {
        return $this->belongsTo(User::class, 'created_by_user_id');
    }
}
