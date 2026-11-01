<?php

namespace App\Services;

use App\Http\Controllers\SummaryController;
use App\Models\Client;
use App\Models\Designation;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Database\Eloquent\Builder;

/**
 * Roll-ups for the Work Hours Report's "Display settings": one row per
 * person / client / work type / tracker / department, optionally split by
 * day, week or month. Works on an already-filtered WorkHour query so the
 * report's filters and search apply unchanged.
 */
class ReportSummaryService
{
    public const SHOWS = ['entries', 'person', 'client', 'work_type', 'tracker', 'department'];

    public const GROUPS = ['none', 'day', 'week', 'month'];

    /** Hard ceiling on returned rows so an unbounded range can't hang the page. */
    private const MAX_ROWS = 5000;

    public static function periodKey(string $date, string $group): string
    {
        return match ($group) {
            'day' => $date,
            'week' => Carbon::parse($date)->startOfWeek(Carbon::MONDAY)->toDateString(),
            'month' => substr($date, 0, 7),
            default => 'all',
        };
    }

    /** Grand totals across every matching row (not just one page). */
    public function totals(Builder $query): array
    {
        $placeholders = implode(',', array_fill(0, count(SummaryController::BILLABLE_TYPES), '?'));
        $row = (clone $query)
            ->selectRaw("COALESCE(SUM(work_hours.hours), 0) as total, COALESCE(SUM(CASE WHEN work_hours.work_type IN ($placeholders) THEN work_hours.hours ELSE 0 END), 0) as billable, COUNT(*) as entries", SummaryController::BILLABLE_TYPES)
            ->toBase()
            ->first();

        return ['hours' => round((float) $row->total, 2), 'billable' => round((float) $row->billable, 2), 'entries' => (int) $row->entries];
    }

    /** Hours per period for the whole filtered set (entry view's group subtotals). */
    public function periodTotals(Builder $query, string $group): array
    {
        $out = [];
        $rows = (clone $query)->selectRaw('work_hours.date as d, SUM(work_hours.hours) as h')->groupBy('work_hours.date')->toBase()->get();
        foreach ($rows as $r) {
            $key = self::periodKey(substr((string) $r->d, 0, 10), $group);
            $out[$key] = round(($out[$key] ?? 0) + (float) $r->h, 2);
        }

        return $out;
    }

    /**
     * @return array{rows: array<int, array>, truncated: bool}
     */
    public function summarize(Builder $query, string $show, string $group): array
    {
        $raw = (clone $query)
            ->selectRaw('work_hours.user_id, work_hours.client_id, work_hours.tracker, work_hours.work_type, work_hours.date, SUM(work_hours.hours) as h, COUNT(*) as n')
            ->groupBy('work_hours.user_id', 'work_hours.client_id', 'work_hours.tracker', 'work_hours.work_type', 'work_hours.date')
            ->toBase()
            ->get();

        $users = User::query()->whereIn('id', $raw->pluck('user_id')->unique())->get(['id', 'name', 'designation'])->keyBy('id');
        $clients = Client::query()->whereIn('id', $raw->pluck('client_id')->filter()->unique())->pluck('name', 'id');
        $departments = Designation::departmentMap();
        $billable = array_flip(SummaryController::BILLABLE_TYPES);

        $rows = [];
        foreach ($raw as $r) {
            $user = $users[$r->user_id] ?? null;
            [$key, $label] = match ($show) {
                'person' => ['u'.$r->user_id, $user?->name ?? 'Deleted user'],
                'client' => $r->client_id ? ['c'.$r->client_id, $clients[$r->client_id] ?? 'Client #'.$r->client_id] : ['none', 'No client'],
                'work_type' => ['t'.($r->work_type ?: 'office_work'), $r->work_type ?: 'office_work'],
                'tracker' => $r->tracker ? ['p'.mb_strtolower($r->tracker), $r->tracker] : ['none', 'No tracker'],
                default => (function () use ($user, $departments) {
                    $d = $departments[mb_strtolower(trim((string) $user?->designation))] ?? Designation::UNASSIGNED;

                    return ['d'.$d, $d];
                })(),
            };
            $date = substr((string) $r->date, 0, 10);
            $period = self::periodKey($date, $group);
            $id = $period.'|'.$key;
            $type = $r->work_type ?: 'office_work';
            $h = (float) $r->h;

            $row = $rows[$id] ?? ['period' => $period, 'key' => $key, 'label' => $label, 'hours' => 0.0, 'billable' => 0.0, 'by_type' => [], 'entries' => 0, 'people' => [], 'clients' => [], 'days' => []];
            $row['hours'] += $h;
            if (isset($billable[$type])) {
                $row['billable'] += $h;
            }
            $row['by_type'][$type] = ($row['by_type'][$type] ?? 0) + $h;
            $row['entries'] += (int) $r->n;
            $row['people'][$r->user_id] = true;
            if ($r->client_id) {
                $row['clients'][$r->client_id] = true;
            }
            $row['days'][$date] = true;
            $rows[$id] = $row;
        }

        $out = array_map(fn ($row) => [
            'period' => $row['period'],
            'key' => $row['key'],
            'label' => $row['label'],
            'hours' => round($row['hours'], 2),
            'billable' => round($row['billable'], 2),
            'by_type' => array_map(fn ($v) => round($v, 2), $row['by_type']),
            'entries' => $row['entries'],
            'people' => count($row['people']),
            'clients' => count($row['clients']),
            'days' => count($row['days']),
        ], array_values($rows));

        usort($out, fn ($a, $b) => strcmp($a['period'], $b['period']) ?: $b['hours'] <=> $a['hours']);

        return ['rows' => array_slice($out, 0, self::MAX_ROWS), 'truncated' => count($out) > self::MAX_ROWS];
    }
}
