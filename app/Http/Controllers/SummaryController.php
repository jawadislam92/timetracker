<?php

namespace App\Http\Controllers;

use App\Models\Client;
use App\Models\Designation;
use App\Models\User;
use App\Models\WorkHour;
use App\Support\BusinessTime;
use Carbon\Carbon;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Inertia\Inertia;

/**
 * Summary — the dashboard that replaces "download the report, build a pivot
 * table in Excel". The server only aggregates Work Diary hours to one row per
 * person · day · work type · client; every chart, table and department roll-up
 * is computed in the browser so switching scope (company / department /
 * person) is instant and needs no round trip.
 */
class SummaryController extends Controller
{
    /** Hours charged to a client. Everything else is internal. */
    public const BILLABLE_TYPES = ['tracker', 'manual', 'outside_of_upwork', 'fixed'];

    public const RANGES = ['this_week', 'last_week', 'last_4_weeks', 'this_month', 'last_month', 'custom'];

    /** Longest custom range; keeps the payload a few thousand rows. */
    private const MAX_DAYS = 186;

    public function index(Request $request)
    {
        $range = in_array($request->input('range'), self::RANGES, true) ? $request->input('range') : 'last_4_weeks';
        [$start, $end] = $this->resolveRange($range, $request->input('start'), $request->input('end'));

        $days = $start->diffInDays($end) + 1;
        $prevEnd = $start->copy()->subDay();
        $prevStart = $prevEnd->copy()->subDays($days - 1);

        $rows = WorkHour::query()
            ->whereBetween('date', [$start->toDateString(), $end->toDateString()])
            ->where('hours', '>', 0)
            ->selectRaw('user_id, date, work_type, client_id, SUM(hours) as hours')
            ->groupBy('user_id', 'date', 'work_type', 'client_id')
            ->orderBy('date')
            ->get();

        // Previous period of equal length, per person, for the "vs last period" deltas.
        $previous = WorkHour::query()
            ->whereBetween('date', [$prevStart->toDateString(), $prevEnd->toDateString()])
            ->selectRaw('user_id, SUM(hours) as total, SUM(CASE WHEN work_type IN ('.implode(',', array_fill(0, count(self::BILLABLE_TYPES), '?')).') THEN hours ELSE 0 END) as billable', self::BILLABLE_TYPES)
            ->groupBy('user_id')
            ->get()
            ->map(fn ($r) => [(int) $r->user_id, round((float) $r->total, 2), round((float) $r->billable, 2)])
            ->values();

        $departments = Designation::departmentMap();
        $loggedIds = $rows->pluck('user_id')->merge($previous->pluck(0))->unique();

        // Everyone active, plus anyone archived who still logged hours in range.
        $users = User::query()
            ->where(fn ($q) => $q->active()->orWhereIn('id', $loggedIds))
            ->orderBy('name')
            ->get(['id', 'name', 'designation', 'avatar', 'is_active'])
            ->map(fn (User $u) => [
                'id' => $u->id,
                'name' => $u->name,
                'designation' => $u->designation ?: null,
                'department' => $departments[mb_strtolower(trim((string) $u->designation))] ?? Designation::UNASSIGNED,
                'avatar_url' => $u->avatar_url,
                'active' => $u->isActive(),
            ])
            ->values();

        $clients = Client::query()
            ->whereIn('id', $rows->pluck('client_id')->filter()->unique())
            ->get(['id', 'name'])
            ->mapWithKeys(fn ($c) => [$c->id => $c->name]);

        return Inertia::render('Summary/Index', [
            'range' => $range,
            'start' => $start->toDateString(),
            'end' => $end->toDateString(),
            'previous' => ['start' => $prevStart->toDateString(), 'end' => $prevEnd->toDateString(), 'people' => $previous],
            'rows' => $rows->map(fn ($r) => [
                (int) $r->user_id,
                Carbon::parse($r->date)->toDateString(),
                $r->work_type ?: 'office_work',
                $r->client_id ? (int) $r->client_id : null,
                round((float) $r->hours, 2),
            ])->values(),
            'users' => $users,
            'clients' => $clients,
            'billableTypes' => self::BILLABLE_TYPES,
            'designations' => $this->designationRows(),
            'layout' => $request->user()->summary_layout,
            'canEditDepartments' => $request->user()->hasPermission('users.manage'),
        ]);
    }

    /** Save the viewer's own widget layout so it follows them between computers. */
    public function saveLayout(Request $request)
    {
        $data = $request->validate([
            'layout' => ['present', 'nullable', 'array'],
        ]);

        $json = json_encode($data['layout']);
        abort_if($json !== false && strlen($json) > 20000, 422, 'Layout is too large.');

        $request->user()->forceFill(['summary_layout' => $data['layout']])->save();

        return response()->json(['saved' => true]);
    }

    /** Re-map designations to departments. */
    public function saveDepartments(Request $request)
    {
        $data = $request->validate([
            'designations' => ['required', 'array', 'max:200'],
            'designations.*.name' => ['required', 'string', 'max:255'],
            'designations.*.department' => ['nullable', 'string', 'max:60', Rule::notIn([Designation::UNASSIGNED])],
        ]);

        foreach ($data['designations'] as $item) {
            $name = trim($item['name']);
            $department = trim((string) ($item['department'] ?? '')) ?: null;

            $existing = Designation::query()->whereRaw('LOWER(name) = ?', [mb_strtolower($name)])->first();
            if ($existing) {
                $existing->update(['department' => $department]);
            } else {
                Designation::create(['name' => $name, 'department' => $department]);
            }
        }

        return back()->with('success', 'Departments updated.');
    }

    /** Every designation in use or on file, with its department and head-count. */
    private function designationRows(): array
    {
        $counts = User::query()->active()
            ->whereNotNull('designation')->where('designation', '!=', '')
            ->get(['designation'])
            ->groupBy(fn ($u) => mb_strtolower(trim($u->designation)))
            ->map(fn ($group) => ['name' => trim($group->first()->designation), 'people' => $group->count()]);

        $rows = [];
        foreach (Designation::query()->orderBy('name')->get(['name', 'department']) as $d) {
            $key = mb_strtolower(trim($d->name));
            $rows[$key] = ['name' => $d->name, 'department' => $d->department, 'people' => $counts[$key]['people'] ?? 0];
        }
        foreach ($counts as $key => $c) {
            $rows[$key] ??= ['name' => $c['name'], 'department' => null, 'people' => $c['people']];
        }

        return collect($rows)->sortBy('name', SORT_NATURAL | SORT_FLAG_CASE)->values()->all();
    }

    private function resolveRange(string $range, ?string $start, ?string $end): array
    {
        $today = BusinessTime::today()->startOfDay();
        $monday = $today->copy()->startOfWeek(Carbon::MONDAY);

        return match ($range) {
            'this_week' => [$monday, $today],
            'last_week' => [$monday->copy()->subWeek(), $monday->copy()->subDay()],
            'this_month' => [$today->copy()->startOfMonth(), $today],
            'last_month' => [$today->copy()->subMonthNoOverflow()->startOfMonth(), $today->copy()->subMonthNoOverflow()->endOfMonth()->startOfDay()],
            'custom' => $this->customRange($start, $end, $today),
            default => [$monday->copy()->subWeeks(4), $monday->copy()->subDay()],
        };
    }

    private function customRange(?string $start, ?string $end, Carbon $today): array
    {
        try {
            $s = $start ? Carbon::createFromFormat('Y-m-d', $start, $today->getTimezone())->startOfDay() : $today->copy()->subDays(27);
            $e = $end ? Carbon::createFromFormat('Y-m-d', $end, $today->getTimezone())->startOfDay() : $today->copy();
        } catch (\Throwable) {
            return [$today->copy()->subDays(27), $today->copy()];
        }
        if ($e->lt($s)) {
            [$s, $e] = [$e, $s];
        }
        if ($s->diffInDays($e) + 1 > self::MAX_DAYS) {
            $s = $e->copy()->subDays(self::MAX_DAYS - 1);
        }

        return [$s, $e];
    }
}
