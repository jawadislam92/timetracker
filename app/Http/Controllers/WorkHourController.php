<?php

namespace App\Http\Controllers;

use App\Models\Client;
use App\Models\Designation;
use App\Models\MonitoringSetting;
use App\Models\TrackingAuditLog;
use App\Models\TrackingSession;
use App\Models\UpworkProfile;
use App\Models\User;
use App\Models\WorkHour;
use App\Services\ReportSummaryService;
use App\Services\SlackReportService;
use App\Services\TrackingSessionService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;

class WorkHourController extends Controller
{
    use Concerns\RedirectsToReturnPath;

    private const WORK_TYPES = [
        'tracker',
        'manual',
        'fixed',
        'outside_of_upwork',
        'office_work',
        'test_task',
        'upwork_bidding',
    ];

    private function authorizeWorkHourAccess(WorkHour $workHour): void
    {
        $user = auth()->user();

        if (! $user->hasPermission('work_hours.manage_all') && $workHour->user_id !== $user->id) {
            abort(403, 'You can only manage your own work hour entries.');
        }
    }

    /**
     * Manual work-hour entry is always available to Admin/Super Admin (anyone
     * who can manage all entries). For regular Members it depends on the team
     * `allow_offline_time` setting from the new Settings page.
     */
    private function ensureCanCreateManual(): void
    {
        $user = auth()->user();

        if ($user->isSuperAdmin() || $user->hasPermission('work_hours.manage_all')) {
            return;
        }

        if (! MonitoringSetting::current()->allow_offline_time) {
            abort(403, 'Manual work-hour entry is disabled by your administrator.');
        }
    }

    private function filterValues(Request $request, string $key, ?string $legacyKey = null): array
    {
        $value = $request->input($key);

        if ($value === null && $legacyKey) {
            $value = $request->input($legacyKey);
        }

        if ($value === null) {
            return [];
        }

        if (! is_array($value)) {
            $value = [$value];
        }

        return collect($value)
            ->flatten()
            ->map(fn ($item) => trim((string) $item))
            ->filter(fn ($item) => $item !== '' && $item !== 'all')
            ->unique()
            ->values()
            ->all();
    }

    private function applyCommonFilters($query, array $filters): void
    {
        // Columns are table-qualified because the Report query joins `clients`
        // (and `users`), and `clients` also has a `work_type` column — an
        // unqualified `work_type` is ambiguous there and throws SQL 1052 (500).
        if (! empty($filters['workTypes'])) {
            $query->whereIn('work_hours.work_type', $filters['workTypes']);
        }

        if (! empty($filters['trackers'])) {
            $query->whereIn('work_hours.tracker', $filters['trackers']);
        }

        if (! empty($filters['clients'])) {
            // Filter by client ID, not name: prod has duplicate client names
            // ("Brad Pugh" x3), so a name filter silently mixed different
            // clients' hours into one report. Numeric values are ids; anything
            // non-numeric is a legacy name (old bookmarked URLs) and still works.
            $ids = array_values(array_filter($filters['clients'], 'is_numeric'));
            $names = array_values(array_filter($filters['clients'], fn ($v) => ! is_numeric($v)));
            $query->whereHas('client', function ($q) use ($ids, $names) {
                $q->where(function ($qq) use ($ids, $names) {
                    if ($ids) {
                        $qq->whereIn('id', $ids);
                    }
                    if ($names) {
                        $qq->orWhereIn('name', $names);
                    }
                });
            });
        }

        if (! empty($filters['userIds'])) {
            $query->whereIn('work_hours.user_id', $filters['userIds']);
        }

        if (! empty($filters['designations'])) {
            $query->whereHas('user', function ($q) use ($filters) {
                $q->whereIn('designation', $filters['designations']);
            });
        }
    }

    /**
     * Departments hang off designations (case-insensitive), so a department
     * filter becomes "designation is one of these". "Unassigned" matches
     * people whose designation is blank or belongs to no department.
     */
    private function applyDepartmentFilter($query, array $departments): void
    {
        if (! $departments) {
            return;
        }
        $map = Designation::departmentMap();
        $wanted = array_keys(array_filter($map, fn ($d) => in_array($d, $departments, true)));
        $unassigned = in_array(Designation::UNASSIGNED, $departments, true);

        if (! $wanted && ! $unassigned) {
            $query->whereRaw('1 = 0');

            return;
        }

        $query->whereHas('user', function ($u) use ($wanted, $unassigned, $map) {
            $u->where(function ($q) use ($wanted, $unassigned, $map) {
                if ($wanted) {
                    $q->whereIn(DB::raw('LOWER(TRIM(designation))'), $wanted);
                }
                if ($unassigned) {
                    $q->orWhere(function ($qq) use ($map) {
                        $qq->whereNull('designation')->orWhere('designation', '');
                        if ($map) {
                            $qq->orWhereNotIn(DB::raw('LOWER(TRIM(designation))'), array_keys($map));
                        }
                    });
                }
            });
        });
    }

    /** user id => department, for the entry view's Department column. */
    private function userDepartments(): array
    {
        $map = Designation::departmentMap();

        return User::query()->get(['id', 'designation'])
            ->mapWithKeys(fn ($u) => [$u->id => $map[mb_strtolower(trim((string) $u->designation))] ?? Designation::UNASSIGNED])
            ->all();
    }

    private function firstLegacyValue(array $values): string
    {
        return $values[0] ?? 'all';
    }

    public function index(Request $request)
    {
        $user = auth()->user();
        $query = WorkHour::with('user', 'client');

        // WorkHoursList is for personal work diary - everyone sees only their own entries
        $query->where('user_id', $user->id);

        $filter = $request->input('filter', 'all');
        $startDate = $request->input('startDate');
        $endDate = $request->input('endDate');
        $selectedWorkTypes = $this->filterValues($request, 'workTypes', 'workType');
        $selectedTrackers = $this->filterValues($request, 'trackers', 'tracker');
        $selectedClients = $this->filterValues($request, 'clients', 'client');
        $perPage = $request->input('perPage', 15);

        // Validate perPage to prevent abuse
        $allowedPerPage = [15, 25, 50, 100];
        if (! in_array($perPage, $allowedPerPage)) {
            $perPage = 15;
        }

        // Apply date filter
        if ($filter !== 'all' && $startDate && $endDate) {
            $query->whereBetween('date', [$startDate, $endDate]);
        }

        $this->applyCommonFilters($query, [
            'workTypes' => $selectedWorkTypes,
            'trackers' => $selectedTrackers,
            'clients' => $selectedClients,
        ]);

        // Server-side search across all pages — the search box previously
        // only filtered the rows already on screen, silently hiding matches
        // that lived on other pages.
        $search = trim((string) $request->input('search', ''));
        if ($search !== '') {
            $query->where(function ($q) use ($search) {
                $q->where('description', 'like', "%{$search}%")
                    ->orWhere('tracker', 'like', "%{$search}%")
                    ->orWhereHas('user', fn ($u) => $u->where('name', 'like', "%{$search}%"))
                    ->orWhereHas('client', fn ($c) => $c->where('name', 'like', "%{$search}%"));
            });
        }

        // Grand total of hours across ALL matching rows (every page), so the
        // table footer can show a true total instead of only the current page.
        // Taken from a clone BEFORE paginate() adds limit/offset/order to the
        // builder, so the SUM covers the whole filtered set, not one page.
        $filteredTotalHours = (float) (clone $query)->sum('work_hours.hours');

        // Implement pagination with dynamic per page
        $workHours = $query->orderByDesc('date')->orderByDesc('id')->paginate($perPage);

        // Preserve query parameters in pagination links
        $workHours->appends($request->query());

        // id + name pairs (same shape as the report page) so duplicate client
        // names stay distinguishable, and one indexed query instead of
        // hydrating every work_hours row just to list the client names.
        // Active only — archived (finished-contract) clients stay out of the
        // filter; their historical rows still render in the table.
        $availableClients = Client::query()
            ->active()
            ->whereIn('id', WorkHour::where('user_id', $user->id)
                ->whereNotNull('client_id')->select('client_id')->distinct())
            ->orderBy('name')
            ->get(['id', 'name'])
            ->values();

        $availableTrackers = WorkHour::where('user_id', $user->id)
            ->whereNotNull('tracker')
            ->distinct()
            ->pluck('tracker')
            ->filter()
            ->sort()
            ->values();

        return Inertia::render('WorkHoursList', [
            'workHours' => $workHours,
            'search' => $search,
            'filteredTotalHours' => $filteredTotalHours,
            'filter' => $filter,
            'startDate' => $startDate,
            'endDate' => $endDate,
            'workType' => $this->firstLegacyValue($selectedWorkTypes),
            'tracker' => $this->firstLegacyValue($selectedTrackers),
            'client' => $this->firstLegacyValue($selectedClients),
            'perPage' => $perPage,
            'selectedFilters' => [
                'workTypes' => $selectedWorkTypes,
                'trackers' => $selectedTrackers,
                'clients' => $selectedClients,
            ],
            'filterOptions' => [
                'workTypes' => self::WORK_TYPES,
                'trackers' => $availableTrackers,
                'clients' => $availableClients,
            ],
            'flash' => [
                'success' => $request->session()->get('success') ?? '',
                'error' => $request->session()->get('error') ?? '',
            ],
        ]);
    }

    public function create(Request $request)
    {
        $this->ensureCanCreateManual();

        $clients = Client::with(['upworkProfile', 'upworkProfiles'])
            ->active()
            ->select('id', 'name', 'work_type', 'upwork_profile_id')
            ->orderBy('name')
            ->get();

        $trackers = UpworkProfile::active()
            ->orderBy('name')
            ->pluck('name')
            ->toArray();

        return Inertia::render('WorkHourCreate', [
            'returnTo' => $request->input('return_to'),
            'trackers' => $trackers,
            'clients' => $clients,
        ]);
    }

    public function store(Request $request)
    {
        $this->ensureCanCreateManual();

        $validated = $request->validate([
            'date' => 'required|date',
            'hours' => 'required|integer|min:0|max:24',
            'minutes' => 'required|integer|min:0|max:59',
            'description' => 'required|string|max:5000',
            'work_type' => ['required', Rule::in(self::WORK_TYPES)],
            'client_id' => ['nullable', 'integer', Rule::exists('clients', 'id')->where('is_active', true)],
            'tracker' => 'nullable|string|max:255',
        ]);

        $this->assertClientMatchesWorkType($validated['client_id'] ?? null, $validated['work_type']);

        if ((int) $validated['hours'] === 0 && (int) $validated['minutes'] === 0) {
            return back()->withErrors(['hours' => 'Please enter at least some time.']);
        }

        $validated['user_id'] = $request->user()->id;
        $validated['hours'] = $validated['hours'] + ($validated['minutes'] / 60);
        $validated['source'] = 'manual';
        unset($validated['minutes']);
        WorkHour::create($validated);

        // Back to the list view the user came from (page, filters, search).
        return $this->redirectToReturnPath($request, 'work-hours.index', [
            'success' => 'Work hour entry created successfully.',
        ]);
    }

    public function edit(Request $request, WorkHour $workHour)
    {
        $this->authorizeWorkHourAccess($workHour);

        // Load the client relationship
        $workHour->load('client');

        // Same shape as create(): work_type + profiles let the Edit form filter
        // the client/tracker dropdowns by work type (so it can't offer an
        // invalid combo). Active clients only, PLUS this entry's own client even
        // if it has since been archived — so editing an old entry never loses or
        // is forced to change its (now-archived) client.
        $clients = Client::with(['upworkProfile', 'upworkProfiles'])
            ->where(fn ($q) => $q->where('is_active', true)->orWhere('id', $workHour->client_id))
            ->select('id', 'name', 'work_type', 'upwork_profile_id')
            ->orderBy('name')
            ->get();

        $trackers = UpworkProfile::active()
            ->orderBy('name')
            ->pluck('name')
            ->toArray();

        return Inertia::render('WorkHourEdit', [
            'returnTo' => $request->input('return_to'),
            'workHour' => $workHour,
            'trackers' => $trackers,
            'clients' => $clients,
        ]);
    }

    public function update(Request $request, WorkHour $workHour)
    {
        $this->authorizeWorkHourAccess($workHour);

        $validated = $request->validate([
            'date' => 'required|date',
            'hours' => 'required|integer|min:0|max:24',
            'minutes' => 'required|integer|min:0|max:59',
            'description' => 'required|string|max:5000',
            'work_type' => ['required', Rule::in(self::WORK_TYPES)],
            'client_id' => 'nullable|integer|exists:clients,id',
            'tracker' => 'nullable|string|max:255',
        ]);

        $this->assertClientMatchesWorkType($validated['client_id'] ?? null, $validated['work_type']);

        // Tracker-recorded time is LOCKED: the hours always reflect what the
        // desktop tracker measured, so an entry can't be edited to show more (or
        // different) hours than were actually tracked. Description / client /
        // work type can still be corrected; the submitted hours are ignored.
        // Manual entries (no tracking session) remain fully editable.
        $isTracked = $workHour->tracking_session_id !== null || $workHour->source === 'tracker';

        if ($isTracked) {
            $validated['hours'] = $workHour->hours;
        } else {
            if ((int) $validated['hours'] === 0 && (int) $validated['minutes'] === 0) {
                return back()->withErrors(['hours' => 'Please enter at least some time.']);
            }
            $validated['hours'] = $validated['hours'] + ($validated['minutes'] / 60);
        }

        unset($validated['minutes']);
        $workHour->update($validated);

        return $this->redirectToReturnPath($request, 'work-hours.index', [
            'success' => 'Work hour entry updated successfully.',
        ]);
    }

    /**
     * A manual entry's work_type constrains which clients are valid: tracker/
     * manual attaches a 'tracker_manual' client, fixed → 'fixed', and
     * outside_of_upwork → 'outside_of_upwork'. (office_work / test_task /
     * upwork_bidding aren't client-filtered — same as the Create form, which
     * only narrows these four.) Mirrors getFilteredClients() in
     * WorkHourCreate.jsx so Edit can't persist a combo Create would block.
     */
    private function assertClientMatchesWorkType($clientId, string $workType): void
    {
        $allowed = [
            'tracker' => ['tracker_manual'],
            'manual' => ['tracker_manual'],
            'fixed' => ['fixed'],
            'outside_of_upwork' => ['outside_of_upwork'],
        ];

        $clientId = $clientId ? (int) $clientId : null;
        if (! $clientId || ! isset($allowed[$workType])) {
            return; // no client, or a work type the form doesn't client-filter
        }

        $clientWorkType = Client::whereKey($clientId)->value('work_type');
        if (! in_array($clientWorkType, $allowed[$workType], true)) {
            throw ValidationException::withMessages([
                'client_id' => 'The selected client is not valid for this work type.',
            ]);
        }
    }

    public function destroy(Request $request, WorkHour $workHour)
    {
        $this->authorizeWorkHourAccess($workHour);

        $cascaded = $this->deleteWorkHourAndSource($workHour, $request->user());

        return $this->redirectToReturnPath($request, 'work-hours.index', [
            'success' => $cascaded
                ? 'Work entry deleted — its tracking session, screenshots, and activity data were removed too.'
                : 'Work hour entry deleted.',
        ]);
    }

    /**
     * Delete a work entry and, when it mirrors a tracker session, tear down
     * that whole session (screenshots, activity samples) so it also vanishes
     * from the Timeline and Team Performance. Manual entries have no source
     * session and are simply removed. Returns true when a session cascaded.
     */
    private function deleteWorkHourAndSource(WorkHour $workHour, ?User $actor): bool
    {
        $session = $workHour->tracking_session_id
            ? TrackingSession::find($workHour->tracking_session_id)
            : null;

        if (! $session) {
            $workHour->delete();

            return false;
        }

        TrackingAuditLog::record([
            'tracking_session_id' => $session->id,
            'subject_user_id' => $session->user_id,
            'actor_user_id' => $actor?->id,
            'action' => 'session.delete',
            'event_date' => optional($session->started_at)->toDateString(),
            'old_value' => [
                'via' => 'work_diary',
                'total_seconds' => (int) $session->total_seconds,
                'screenshots' => $session->screenshots()->count(),
            ],
            'new_value' => null,
            'reason' => 'Work-diary entry deleted',
        ]);

        // purge() removes the mirrored work-hours row as well.
        app(TrackingSessionService::class)->purge($session);

        return true;
    }

    public function bulkDelete(Request $request)
    {
        if ($request->has('entry_ids') && ! $request->has('ids')) {
            $request->merge(['ids' => $request->input('entry_ids')]);
        }

        $validated = $request->validate([
            'ids' => 'required|array',
            'ids.*' => 'integer|exists:work_hours,id',
        ]);

        $user = auth()->user();
        $ids = $validated['ids'];

        $query = WorkHour::whereIn('id', $ids);
        if (! $user->hasPermission('work_hours.manage_all')) {
            // Ensure user can only delete their own entries.
            if (WorkHour::whereIn('id', $ids)->where('user_id', $user->id)->count() !== count($ids)) {
                return back()->withErrors([
                    'ids' => 'Some entries could not be deleted. You can only delete your own entries.',
                ]);
            }
            $query->where('user_id', $user->id);
        }

        // Cascade each entry so tracker-synced ones also remove their session,
        // screenshots, and activity data (not just the work_hours row).
        $entries = $query->get();
        foreach ($entries as $entry) {
            $this->deleteWorkHourAndSource($entry, $user);
        }

        return back()->with('success', 'Successfully deleted '.$entries->count().' entries.');
    }

    public function exportPersonal(Request $request)
    {
        $user = auth()->user();
        $query = WorkHour::with('user', 'client');

        // Only show current user's entries
        $query->where('user_id', $user->id);

        $filter = $request->input('filter', 'all');
        $startDate = $request->input('startDate');
        $endDate = $request->input('endDate');
        $selectedWorkTypes = $this->filterValues($request, 'workTypes', 'workType');
        $selectedTrackers = $this->filterValues($request, 'trackers', 'tracker');
        $selectedClients = $this->filterValues($request, 'clients', 'client');
        $idsOnly = $request->input('idsOnly', false);

        // Apply date filter
        if ($filter !== 'all' && $startDate && $endDate) {
            $query->whereBetween('date', [$startDate, $endDate]);
        }

        $this->applyCommonFilters($query, [
            'workTypes' => $selectedWorkTypes,
            'trackers' => $selectedTrackers,
            'clients' => $selectedClients,
        ]);

        // If only IDs are requested, return just ID and minimal data for bulk operations
        if ($idsOnly) {
            $workHours = $query->orderByDesc('date')->orderByDesc('id')->get(['id']);
        } else {
            // Get all data without pagination
            $workHours = $query->orderByDesc('date')->orderByDesc('id')->get();
        }

        return response()->json([
            'data' => $workHours,
        ]);
    }

    public function export(Request $request)
    {
        $query = WorkHour::with('user', 'client');
        $filter = $request->input('filter', 'all');
        $startDate = $request->input('startDate');
        $endDate = $request->input('endDate');
        $selectedWorkTypes = $this->filterValues($request, 'workTypes', 'workType');
        $selectedUserIds = $this->filterValues($request, 'userIds', 'userId');
        $selectedDesignations = $this->filterValues($request, 'designations', 'designation');
        $selectedTrackers = $this->filterValues($request, 'trackers', 'tracker');
        $selectedClients = $this->filterValues($request, 'clients', 'client');

        // Apply date filter - only apply if both dates are provided
        if ($startDate && $endDate) {
            $query->whereBetween('date', [$startDate, $endDate]);
        }

        $this->applyCommonFilters($query, [
            'workTypes' => $selectedWorkTypes,
            'userIds' => $selectedUserIds,
            'designations' => $selectedDesignations,
            'trackers' => $selectedTrackers,
            'clients' => $selectedClients,
        ]);

        // Get all data without pagination
        $workHours = $query->orderByDesc('date')->orderByDesc('id')->get();

        return response()->json([
            'data' => $workHours,
        ]);
    }

    public function report(Request $request, SlackReportService $slack, ReportSummaryService $summaries)
    {
        $query = WorkHour::query();
        $filter = $request->input('filter', 'all');
        $startDate = $request->input('startDate');
        $endDate = $request->input('endDate');
        $selectedWorkTypes = $this->filterValues($request, 'workTypes', 'workType');
        $selectedUserIds = $this->filterValues($request, 'userIds', 'userId');
        $selectedDesignations = $this->filterValues($request, 'designations', 'designation');
        $selectedTrackers = $this->filterValues($request, 'trackers', 'tracker');
        $selectedClients = $this->filterValues($request, 'clients', 'client');
        $selectedDepartments = $this->filterValues($request, 'departments');

        // Display settings: URL first (shareable links), then the viewer's saved choice.
        $saved = $request->user()->summary_layout['report'] ?? [];
        $show = in_array($request->input('show'), ReportSummaryService::SHOWS, true) ? $request->input('show')
            : (in_array($saved['show'] ?? null, ReportSummaryService::SHOWS, true) ? $saved['show'] : 'entries');
        $group = in_array($request->input('group'), ReportSummaryService::GROUPS, true) ? $request->input('group')
            : (in_array($saved['group'] ?? null, ReportSummaryService::GROUPS, true) ? $saved['group'] : 'none');
        $perPageInput = (string) $request->input('perPage', 15);

        // Fetch all available designation filter options.
        $availableDesignations = User::whereNotNull('designation')
            ->distinct()
            ->pluck('designation')
            ->filter()
            ->sort()
            ->values();

        $availableTrackers = UpworkProfile::active()
            ->orderBy('name')
            ->pluck('name')
            ->toArray();

        // One indexed query for the dropdown. id + name pairs, not bare names:
        // duplicate client names exist in prod, and a name can only ever select
        // "all clients called that", which mixed unrelated clients in reports.
        // ACTIVE only: ~935 finished-contract clients are archived (owner's
        // 2026-08-16 cleanup) — offering them here would defeat it. Restoring a
        // client from the Clients page puts it straight back in this dropdown;
        // existing rows for archived clients still render in the table.
        $availableClients = Client::query()
            ->active()
            ->whereIn('id', WorkHour::whereNotNull('client_id')->select('client_id')->distinct())
            ->orderBy('name')
            ->get(['id', 'name'])
            ->values();

        // Page size. "all" shows everything on one page, capped so a huge
        // unfiltered report can't hang the browser; otherwise validate against
        // the allowed sizes (default 15).
        $allowedPerPage = [10, 15, 20, 30, 40, 50, 100];
        $allRowsCap = 1000;
        if ($perPageInput === 'all') {
            $perPage = $allRowsCap;
        } elseif (in_array((int) $perPageInput, $allowedPerPage, true)) {
            $perPage = (int) $perPageInput;
        } else {
            $perPage = 15;
            $perPageInput = '15';
        }

        // Apply date filter - only apply if both dates are provided
        if ($startDate && $endDate) {
            $query->whereBetween('date', [$startDate, $endDate]);
        }

        $this->applyCommonFilters($query, [
            'workTypes' => $selectedWorkTypes,
            'userIds' => $selectedUserIds,
            'designations' => $selectedDesignations,
            'trackers' => $selectedTrackers,
            'clients' => $selectedClients,
        ]);

        $this->applyDepartmentFilter($query, $selectedDepartments);

        // Server-side search across all pages — the search box previously
        // only filtered the rows already on screen, silently hiding matches
        // that lived on other pages.
        $search = trim((string) $request->input('search', ''));
        if ($search !== '') {
            $query->where(function ($q) use ($search) {
                $q->where('description', 'like', "%{$search}%")
                    ->orWhere('tracker', 'like', "%{$search}%")
                    ->orWhereHas('user', fn ($u) => $u->where('name', 'like', "%{$search}%"))
                    ->orWhereHas('client', fn ($c) => $c->where('name', 'like', "%{$search}%"));
            });
        }

        // True totals for every matching row — the footer used to add up only
        // the rows on the current page.
        $totals = $summaries->totals($query);
        $summary = $show === 'entries' ? null : $summaries->summarize($query, $show, $group);
        $periodTotals = $show === 'entries' && $group !== 'none' ? $summaries->periodTotals($query, $group) : null;

        // Merge identical entries (same person · date · client · work type ·
        // tracker · source) into one totalled row, so a client logged three
        // times in a day shows once with the summed hours and an "×3" badge.
        // `?detailed=1` falls back to one row per raw entry.
        if ($summary !== null) {
            $workHours = null;
        } elseif ($request->boolean('detailed')) {
            $workHours = $query->with('user', 'client')
                ->orderByDesc('date')->orderByDesc('id')
                ->paginate($perPage);
        } else {
            $workHours = $query
                ->leftJoin('users', 'work_hours.user_id', '=', 'users.id')
                ->leftJoin('clients', 'work_hours.client_id', '=', 'clients.id')
                ->selectRaw(sprintf(
                    "MIN(work_hours.id) as id, work_hours.date, work_hours.user_id, users.name as user_name, work_hours.client_id, clients.name as client_name, work_hours.work_type, work_hours.tracker, work_hours.source, SUM(work_hours.hours) as hours, COUNT(*) as entry_count, %s as description",
                    // SEPARATOR is MySQL-only syntax; SQLite (the in-memory test
                    // database) takes the separator as a second argument. Without
                    // this split the report page could never be covered by a test.
                    DB::connection()->getDriverName() === 'sqlite'
                        ? "GROUP_CONCAT(NULLIF(work_hours.description, ''), ' · ')"
                        : "GROUP_CONCAT(NULLIF(work_hours.description, '') SEPARATOR ' · ')"
                ))
                ->groupBy('work_hours.date', 'work_hours.user_id', 'users.name', 'work_hours.client_id', 'clients.name', 'work_hours.work_type', 'work_hours.tracker', 'work_hours.source')
                ->orderByDesc('work_hours.date')->orderBy('users.name')->orderBy('clients.name')
                ->paginate($perPage);

            $workHours->through(fn ($r) => [
                'id' => (int) $r->id,
                'date' => substr((string) $r->date, 0, 10),
                'user' => ['id' => (int) $r->user_id, 'name' => $r->user_name],
                // id included so rows are attributable to ONE client even when
                // two clients share a display name (they do, in production).
                'client' => $r->client_id ? ['id' => (int) $r->client_id, 'name' => $r->client_name] : null,
                'work_type' => $r->work_type,
                'tracker' => $r->tracker,
                'source' => $r->source,
                'hours' => (float) $r->hours,
                'entry_count' => (int) $r->entry_count,
                'description' => $r->description,
            ]);
        }

        // Preserve query parameters in pagination links
        $workHours?->appends($request->query());

        $users = User::orderBy('name')->get(['id', 'name', 'include_in_slack_reports']);

        return Inertia::render('WorkHoursReport', [
            'search' => $search,
            'workHours' => $workHours,
            'show' => $show,
            'group' => $group,
            'totals' => $totals,
            'summary' => $summary,
            'periodTotals' => $periodTotals,
            'reportLayout' => $saved,
            'today' => \App\Support\BusinessTime::today()->toDateString(),
            'userDepartments' => $this->userDepartments(),
            'users' => $users,
            'filter' => $filter,
            'startDate' => $startDate,
            'endDate' => $endDate,
            'workType' => $this->firstLegacyValue($selectedWorkTypes),
            'userId' => $this->firstLegacyValue($selectedUserIds),
            'designation' => $this->firstLegacyValue($selectedDesignations),
            'tracker' => $this->firstLegacyValue($selectedTrackers),
            'client' => $this->firstLegacyValue($selectedClients),
            'perPage' => $perPageInput,
            'availableDesignations' => $availableDesignations,
            'availableTrackers' => $availableTrackers,
            'availableClients' => $availableClients,
            'selectedFilters' => [
                'workTypes' => $selectedWorkTypes,
                'userIds' => $selectedUserIds,
                'designations' => $selectedDesignations,
                'trackers' => $selectedTrackers,
                'clients' => $selectedClients,
                'departments' => $selectedDepartments,
            ],
            'filterOptions' => [
                'workTypes' => self::WORK_TYPES,
                'users' => $users,
                'designations' => $availableDesignations,
                'trackers' => $availableTrackers,
                'clients' => $availableClients,
                'departments' => collect(Designation::departmentMap())->values()->unique()->sort()->values()->push(Designation::UNASSIGNED)->all(),
            ],
            'slackConfigured' => $slack->configured(),
            'slackWeeklyEnabled' => (bool) config('services.slack_reports.weekly_enabled'),
            'flash' => [
                'success' => $request->session()->get('success') ?? '',
                'error' => $request->session()->get('error') ?? '',
            ],
        ]);
    }
}
