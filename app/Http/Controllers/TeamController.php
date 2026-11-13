<?php

namespace App\Http\Controllers;

use App\Models\MonitoringSetting;
use App\Models\TimeEntry;
use App\Models\TrackingActivitySample;
use App\Models\TrackingSession;
use App\Models\User;
use App\Services\ActivityDigestService;
use App\Services\TrackingSessionService;
use App\Support\AttendanceHours;
use App\Support\BusinessTime;
use App\Support\WebDomain;
use Carbon\Carbon;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Inertia\Inertia;
use Inertia\Response;
use RuntimeException;

class TeamController extends Controller
{
    public function index(Request $request): Response
    {
        $authUser = $request->user();
        abort_unless($authUser->hasPermission('timeline.view_others'), 403);

        // A range (preset like today/week/month or a custom start+end). The
        // per-session day-clamp below uses these bounds, so a single day and a
        // multi-day range share the same code path.
        [$rangeStart, $rangeEnd] = $this->resolveRange($request, $request->input('range', 'today'));
        [$dayStart, $dayEnd] = BusinessTime::utcRange($rangeStart, $rangeEnd);

        // Only time-tracking staff appear in performance — HR/finance and other
        // non-tracking roles are excluded so they don't read as "0% this week".
        $usersQuery = User::active()->staff()->tracksTime()->with('shift:id,name')->orderBy('name');
        \App\Support\ShiftFilter::apply($usersQuery, $request);
        $users = $usersQuery->get(['id', 'name', 'email', 'role', 'designation', 'avatar', 'shift_id']);

        // Sessions that OVERLAP the selected day — including one that started
        // the previous evening and is still running. Each session's time is
        // clamped to the day below, so a night shift's pre-midnight hours stay
        // on the previous date instead of inflating today.
        $sessions = TrackingSession::with('client:id,name')
            ->where('started_at', '<', $dayEnd)
            ->where(function ($q) use ($dayStart) {
                $q->whereNull('stopped_at')->orWhere('stopped_at', '>', $dayStart);
            })
            // Skip deletion crumbs (sub-minute sessions never mirror to
            // work_hours), but always keep a running session.
            ->where(function ($q) {
                $q->where('total_seconds', '>=', 60)
                    ->orWhere('status', TrackingSession::STATUS_ACTIVE);
            })
            ->get(['id', 'user_id', 'client_id', 'work_type', 'started_at', 'stopped_at', 'last_heartbeat_at', 'total_seconds', 'activity_percent', 'status']);

        $sessionsByUser = $sessions->groupBy('user_id');

        $sampleIntervalSeconds = 60;
        $userIds = $users->pluck('id');

        // Each user's top app, computed with a GROUP BY aggregate instead of
        // hydrating every raw sample row. A week of samples is ~half a million
        // rows; loading them into PHP made this page take ~25s. The aggregate
        // returns only distinct (user, app) pairs.
        // Counting a month of ~10-second samples is the page's slowest work
        // (~1.7s each for two app aggregations). It's a "top apps" breakdown, not
        // live data, so cache it by range + user set — a few minutes stale is
        // invisible, and a fully-past range is immutable (cached for a day). The
        // table's live tracked-seconds and "active now" below stay uncached.
        $rangeKey = md5($dayStart.'|'.$dayEnd.'|'.$userIds->sort()->values()->implode(','));
        $topAppByUser = Cache::remember("team:topapp:$rangeKey", $this->appsCacheTtl($dayEnd), fn () => TrackingActivitySample::query()
            ->whereBetween('captured_at', [$dayStart, $dayEnd])
            ->whereIn('user_id', $userIds)
            ->whereNotNull('active_app')->where('active_app', '!=', '')
            ->selectRaw('user_id, active_app, COUNT(*) as c')
            ->groupBy('user_id', 'active_app')
            ->orderByDesc('c')
            ->get()
            ->groupBy('user_id')
            ->map(fn ($g) => $g->first()->active_app)); // first = highest count (ordered desc)

        // Manually logged work-diary hours for the day (Add Entry / edits —
        // anything not synced from the tracker). They count as valid hours
        // but contribute 0% activity, so a half-manual day dilutes the
        // activity score instead of hiding the manual time entirely.
        $manualByUser = \App\Models\WorkHour::query()
            ->whereBetween('date', [$rangeStart->toDateString(), $rangeEnd->toDateString()])
            ->where(function ($q) {
                $q->whereNull('source')->orWhere('source', '!=', 'tracker');
            })
            ->get(['user_id', 'hours'])
            ->groupBy('user_id');

        // Active sessions snapshot (anyone running right now, regardless of date).
        $activeNow = TrackingSession::active()
            ->with('client:id,name')
            ->get(['id', 'user_id', 'client_id', 'task_note', 'started_at', 'last_heartbeat_at', 'activity_percent', 'total_seconds'])
            ->keyBy('user_id');

        // Seconds a session contributes to THIS range, allocated by wall-clock
        // overlap via the shared helper — the SAME math Timeline and Dashboard
        // use, so the three pages can't disagree. A session fully inside the
        // range keeps its idle-adjusted total; one that straddles the edges (or
        // is still running) gets its proportional share.
        $svc = app(\App\Services\TrackingSessionService::class);
        $daySeconds = fn ($session): int => $svc->inDaySeconds($session, $dayStart, $dayEnd);

        $rows = $users->map(function (User $u) use ($sessionsByUser, $topAppByUser, $sampleIntervalSeconds, $activeNow, $manualByUser, $daySeconds) {
            $userSessions = $sessionsByUser[$u->id] ?? collect();
            $live = $activeNow[$u->id] ?? null;

            // Tracked = each session's time clamped to THIS day. A running
            // session counts toward today, but a night shift's pre-midnight
            // hours stay on the previous date instead of inflating today.
            $trackedSeconds = (int) $userSessions->sum(fn ($s) => $daySeconds($s));
            $manualSeconds = (int) round((float) ($manualByUser[$u->id] ?? collect())->sum('hours') * 3600);
            $totalSeconds = $trackedSeconds + $manualSeconds;

            // Activity = the tracker's own per-session activity score, weighted
            // by each session's time on this day. Uses the session score (same
            // number shown on each screenshot), which is delivered via
            // heartbeats even when raw samples are sparse.
            $weightedActivity = $userSessions->sum(fn ($s) => (int) $s->activity_percent * $daySeconds($s));
            $trackedActivity = $trackedSeconds > 0 ? $weightedActivity / $trackedSeconds : 0;

            // Manual hours carry 0% activity, so they dilute the score in
            // proportion to their share of the day.
            $activityPercent = $totalSeconds > 0
                ? (int) round($trackedActivity * ($trackedSeconds / $totalSeconds))
                : 0;

            $topClient = $userSessions
                ->groupBy(fn ($s) => $this->clientLabel($s))
                ->map(fn ($g, $name) => ['name' => $name, 'total_seconds' => (int) $g->sum(fn ($s) => $daySeconds($s))])
                ->sortByDesc('total_seconds')
                ->first();

            $lastHeartbeat = $userSessions
                ->pluck('last_heartbeat_at')
                ->filter()
                ->sortDesc()
                ->first();

            return [
                'id' => $u->id,
                'name' => $u->name,
                'email' => $u->email,
                'role' => $u->role,
                'designation' => $u->designation,
                'shift_name' => $u->shift_name,
                'avatar_url' => $u->avatar_url,
                'total_seconds' => $totalSeconds,
                'tracked_seconds' => $trackedSeconds,
                'manual_seconds' => $manualSeconds,
                'activity_percent' => $activityPercent,
                'top_client' => $topClient,
                'top_app' => $topAppByUser[$u->id] ?? null,
                'last_heartbeat_at' => $lastHeartbeat?->toIso8601String(),
                'is_live' => (bool) $live,
                'live' => $live ? [
                    'client' => $live->client?->name,
                    'task_note' => $live->task_note,
                    'started_at' => $live->started_at?->toIso8601String(),
                    'activity_percent' => (int) $live->activity_percent,
                ] : null,
            ];
        })->sort(function ($a, $b) {
            // Live workers first, then most tracked time, then name — so the
            // people working right now sit at the top regardless of how much
            // others logged earlier in the day.
            return [$b['is_live'], $b['total_seconds'], $a['name']]
                <=> [$a['is_live'], $a['total_seconds'], $b['name']];
        })->values();

        $totals = [
            'day' => (int) $rows->sum('total_seconds'),
            'people_with_time' => $rows->filter(fn ($r) => $r['total_seconds'] > 0)->count(),
            'people_live' => $rows->filter(fn ($r) => $r['is_live'])->count(),
            'team_size' => $users->count(),
        ];

        // Charts share the SAME in-memory $sessions + inDaySeconds as the table
        // (so a chart can't disagree with a row total); top-apps is aggregated in
        // SQL inside, not from raw sample rows. Composition-by-member is derived
        // on the client from $rows.
        // Same deal: the charts include the team-wide top-apps aggregation (the
        // other ~1.8s query) plus the per-day hours/activity loop. Cache the whole
        // computed payload by range so repeat views (and other managers) are
        // instant; live per-user rows above are recomputed each request.
        $charts = Cache::remember("team:charts:$rangeKey", $this->appsCacheTtl($dayEnd), fn () => $this->buildTeamCharts($rangeStart, $rangeEnd, $sessions, $userIds, $sampleIntervalSeconds, $svc));

        return Inertia::render('Team/Index', [
            'start' => $rangeStart->toDateString(),
            'end' => $rangeEnd->toDateString(),
            'range' => $request->input('range', $rangeStart->toDateString() === $rangeEnd->toDateString() ? 'today' : 'custom'),
            'shiftOptions' => \App\Models\Shift::orderBy('sort_order')->orderBy('name')->get(['id', 'name']),
            'shiftIds' => \App\Support\ShiftFilter::parse($request)[0],
            'rows' => $rows,
            'totals' => $totals,
            'charts' => $charts,
            'permissions' => [
                'view_screenshots' => $authUser->hasPermission('monitoring.view_screenshots'),
                'send_slack' => $authUser->hasPermission('reports.send_slack'),
            ],
            'slack' => [
                'configured' => app(ActivityDigestService::class)->configured(),
                'daily_enabled' => (bool) config('services.slack_reports.daily_digest_enabled'),
                'daily_time' => config('services.slack_reports.daily_digest_time', '09:00'),
            ],
        ]);
    }

    /**
     * Per-day team trend + top clients/apps for the range, built from the SAME
     * sessions/samples + inDaySeconds the table uses (so charts can't disagree).
     * hours_per_day[i] = team total hours on labels[i]; activity_per_day[i] =
     * time-weighted activity % (manual hours dilute at 0%, like the table).
     *
     * @return array<string, mixed>
     */
    /**
     * Cache TTL for the heavy activity-sample aggregations. A range that has
     * fully ended is immutable → cache a day; one that includes today is still
     * filling → keep it short (the apps/day charts a few minutes stale is
     * invisible; the live table numbers aren't cached).
     */
    private function appsCacheTtl(Carbon $end): int
    {
        return $end->isPast() ? 86400 : 300;
    }

    private function buildTeamCharts(Carbon $rangeStart, Carbon $rangeEnd, $sessions, $userIds, int $sampleInterval, $svc): array
    {
        // Manual (non-tracker) work-diary hours per calendar day in the range.
        $manualByDate = \App\Models\WorkHour::query()
            ->whereBetween('date', [$rangeStart->toDateString(), $rangeEnd->toDateString()])
            ->where(function ($q) {
                $q->whereNull('source')->orWhere('source', '!=', 'tracker');
            })
            ->get(['date', 'hours'])
            ->groupBy(fn ($w) => substr((string) $w->date, 0, 10))
            ->map(fn ($g) => (float) $g->sum('hours'));

        $labels = [];
        $hoursPerDay = [];
        $activityPerDay = [];

        for ($d = $rangeStart->copy()->startOfDay(); $d->lte($rangeEnd); $d->addDay()) {
            $key = $d->toDateString();
            [$dStart, $dEnd] = BusinessTime::utcRange($d->copy()->startOfDay(), $d->copy()->endOfDay());

            $trackedSec = 0;
            $weightedAct = 0;
            foreach ($sessions as $s) {
                $sec = $svc->inDaySeconds($s, $dStart, $dEnd);
                if ($sec <= 0) {
                    continue;
                }
                $trackedSec += $sec;
                $weightedAct += (int) $s->activity_percent * $sec;
            }
            $manualSec = (int) round(($manualByDate[$key] ?? 0) * 3600);
            $totalSec = $trackedSec + $manualSec;

            $trackedAct = $trackedSec > 0 ? $weightedAct / $trackedSec : 0;
            $activity = $totalSec > 0 ? (int) round($trackedAct * ($trackedSec / $totalSec)) : 0;

            $labels[] = $key;
            $hoursPerDay[] = round($totalSec / 3600, 2);
            $activityPerDay[] = $activity;
        }

        // Top clients across the whole range (clamped to range bounds — the same
        // total the table's tracked column sums to).
        [$rStart, $rEnd] = BusinessTime::utcRange($rangeStart, $rangeEnd);
        $topClients = collect($sessions)
            ->groupBy(fn ($s) => $this->clientLabel($s))
            ->map(fn ($g, $name) => [
                'label' => $name,
                'value' => round($g->sum(fn ($s) => $svc->inDaySeconds($s, $rStart, $rEnd)) / 3600, 2),
            ])
            ->filter(fn ($c) => $c['value'] > 0)
            ->sortByDesc('value')
            ->values()
            ->take(20)
            ->all();

        // Top apps across the range — aggregated in SQL (GROUP BY) rather than
        // hydrating every sample row (a week is ~500k rows). sample count ×
        // interval → hours.
        $topApps = TrackingActivitySample::query()
            ->whereBetween('captured_at', [$rStart, $rEnd])
            ->whereIn('user_id', $userIds)
            ->whereNotNull('active_app')->where('active_app', '!=', '')
            ->selectRaw('active_app, COUNT(*) as c')
            ->groupBy('active_app')
            ->orderByDesc('c')
            ->limit(20)
            ->get()
            ->map(fn ($r) => [
                'label' => $r->active_app,
                'value' => round($r->c * $sampleInterval / 3600, 2),
            ])
            ->all();

        return [
            'labels' => $labels,
            'hours_per_day' => $hoursPerDay,
            'activity_per_day' => $activityPerDay,
            'top_clients' => $topClients,
            'top_apps' => $topApps,
        ];
    }

    public function apps(Request $request): Response
    {
        $authUser = $request->user();
        abort_unless($authUser->hasPermission('timeline.view_others'), 403);

        $range = $request->input('range', '7d');
        [$start, $end] = $this->resolveRange($request, $range);
        $userId = (int) $request->input('user_id', 0);

        $sampleInterval = MonitoringSetting::current()->activity_sample_interval_seconds ?: 60;

        $base = TrackingActivitySample::query()
            ->whereBetween('captured_at', BusinessTime::utcRange($start, $end));

        if ($userId > 0) {
            $base->where('user_id', $userId);
        }

        // Roll up per (app/url, user) with a GROUP BY aggregate instead of
        // hydrating every raw sample row (a week is ~500k) — same fix as the team
        // page. $column is one of two fixed literals, never user input.
        $rollup = function (string $column) use ($base, $sampleInterval) {
            $rows = (clone $base)
                ->whereNotNull($column)->where($column, '!=', '')
                ->selectRaw("$column as k, user_id, COUNT(*) as c")
                ->groupBy($column, 'user_id')
                ->get();

            $names = User::whereIn('id', $rows->pluck('user_id')->unique())->pluck('name', 'id');

            return $rows
                // Merge www./bare domain variants — over the small aggregate, not raw rows.
                ->groupBy(fn ($r) => $column === 'url_domain' ? WebDomain::normalize($r->k) : $r->k)
                ->map(function ($group, $name) use ($sampleInterval, $names) {
                    $byUser = $group->groupBy('user_id')->map(fn ($g) => (int) $g->sum('c'))->sortDesc();

                    return [
                        'name' => $name,
                        'total_seconds' => (int) $group->sum('c') * $sampleInterval,
                        'user_count' => $byUser->count(),
                        'top_user' => $names[$byUser->keys()->first()] ?? null,
                    ];
                })
                ->sortByDesc('total_seconds')
                ->values()
                ->take(30)
                ->all();
        };

        return Inertia::render('Team/Apps', [
            'range' => $range,
            'start' => $start->toDateString(),
            'end' => $end->toDateString(),
            'userId' => $userId ?: null,
            'users' => User::active()->staff()->orderBy('name')->get(['id', 'name']),
            'apps' => $rollup('active_app'),
            'urls' => $rollup('url_domain'),
            'totals' => [
                'tracked_seconds' => (clone $base)->count() * $sampleInterval,
                'people' => (clone $base)->distinct()->count('user_id'),
            ],
        ]);
    }

    /**
     * Per-person analytics over a date range — gated by analytics.view (charts
     * only; the screenshot-level timeline stays behind timeline.view_others).
     * Reuses resolveRange + inDaySeconds so the numbers match the team table,
     * and overlays in-office hours (the tracked-vs-present gap) per day.
     */
    public function member(Request $request, User $user): Response
    {
        $authUser = $request->user();
        abort_unless($authUser->hasPermission('analytics.view'), 403);

        [$rangeStart, $rangeEnd] = $this->resolveRange($request, $request->input('range', '7d'));
        [$dayStart, $dayEnd] = BusinessTime::utcRange($rangeStart, $rangeEnd);
        $svc = app(TrackingSessionService::class);

        $sessions = TrackingSession::with('client:id,name')
            ->where('user_id', $user->id)
            ->where('started_at', '<', $dayEnd)
            ->where(function ($q) use ($dayStart) {
                $q->whereNull('stopped_at')->orWhere('stopped_at', '>', $dayStart);
            })
            ->where(function ($q) {
                $q->where('total_seconds', '>=', 60)->orWhere('status', TrackingSession::STATUS_ACTIVE);
            })
            ->get(['id', 'user_id', 'client_id', 'work_type', 'started_at', 'stopped_at', 'total_seconds', 'activity_percent', 'status']);

        $samples = TrackingActivitySample::where('user_id', $user->id)
            ->whereBetween('captured_at', [$dayStart, $dayEnd])
            ->get(['active_app']);

        // In-office hours from the user's own time-clock entries, computed per
        // CALENDAR day (split at midnight) so they sit on the same day axis as
        // tracked time below. Widen the fetch one day earlier so an overnight
        // clock-in that straddles the range start is still paired.
        $clockEntries = TimeEntry::where('user_id', $user->id)
            ->whereBetween('action_timestamp', [$dayStart->copy()->subDay(), $dayEnd])
            ->orderBy('action_timestamp')->orderBy('id')
            ->get();

        $labels = [];
        $trackedHours = [];
        $inOfficeHours = [];
        $activity = [];

        for ($d = $rangeStart->copy()->startOfDay(); $d->lte($rangeEnd); $d->addDay()) {
            $key = $d->toDateString();
            [$ds, $de] = BusinessTime::utcRange($d->copy()->startOfDay(), $d->copy()->endOfDay());

            $trackedSec = 0;
            $weightedAct = 0;
            foreach ($sessions as $s) {
                $sec = $svc->inDaySeconds($s, $ds, $de);
                if ($sec <= 0) {
                    continue;
                }
                $trackedSec += $sec;
                $weightedAct += (int) $s->activity_percent * $sec;
            }

            $labels[] = $key;
            $trackedHours[] = round($trackedSec / 3600, 2);
            $inOfficeHours[] = round(AttendanceHours::inOfficeSecondsInWindow($clockEntries, $ds, $de) / 3600, 2);
            $activity[] = $trackedSec > 0 ? (int) round($weightedAct / $trackedSec) : 0;
        }

        $topClients = collect($sessions)
            ->groupBy(fn ($s) => $this->clientLabel($s))
            ->map(fn ($g, $name) => [
                'label' => $name,
                'value' => round($g->sum(fn ($s) => $svc->inDaySeconds($s, $dayStart, $dayEnd)) / 3600, 2),
            ])
            ->filter(fn ($c) => $c['value'] > 0)
            ->sortByDesc('value')->values()->take(12)->all();

        $topApps = collect($samples)
            ->filter(fn ($s) => ! empty($s->active_app))
            ->groupBy('active_app')
            ->map(fn ($g, $name) => ['label' => $name, 'value' => round($g->count() * 60 / 3600, 2)])
            ->sortByDesc('value')->values()->take(12)->all();

        return Inertia::render('Team/Member', [
            'member' => [
                'id' => $user->id,
                'name' => $user->name,
                'email' => $user->email,
                'designation' => $user->designation,
                'avatar_url' => $user->avatar_url,
            ],
            'start' => $rangeStart->toDateString(),
            'end' => $rangeEnd->toDateString(),
            'range' => $request->input('range', ($request->filled('start') && $request->filled('end')) ? 'custom' : '7d'),
            'charts' => [
                'labels' => $labels,
                'tracked_hours' => $trackedHours,
                'in_office_hours' => $inOfficeHours,
                'activity_per_day' => $activity,
                'top_clients' => $topClients,
                'top_apps' => $topApps,
            ],
            'totals' => [
                'tracked_seconds' => (int) round(array_sum($trackedHours) * 3600),
                'in_office_seconds' => (int) round(array_sum($inOfficeHours) * 3600),
            ],
            'canViewTimeline' => $authUser->hasPermission('timeline.view_others'),
        ]);
    }

    /**
     * Chart label for a session's client. Client work shows the client name;
     * sessions with no client are non-billable categories (office work, Upwork
     * bidding, test tasks) — label them by their work type instead of dumping
     * everything into a meaningless "Unassigned" bucket.
     */
    private function clientLabel(TrackingSession $s): string
    {
        if ($s->client?->name) {
            return $s->client->name;
        }

        return match ($s->work_type) {
            'office_work' => 'Office Work',
            'upwork_bidding' => 'Upwork Bidding',
            'test_task' => 'Test Task',
            'fixed' => 'Fixed Project',
            'outside_of_upwork' => 'Outside of Upwork',
            'manual' => 'Manual Time',
            default => 'Other',
        };
    }

    /** @return array{0: Carbon, 1: Carbon} */
    private function resolveRange(Request $request, string $range): array
    {
        $tz = BusinessTime::tz();

        if ($request->filled('start') && $request->filled('end')) {
            try {
                return [
                    Carbon::parse($request->input('start'), $tz)->startOfDay(),
                    Carbon::parse($request->input('end'), $tz)->endOfDay(),
                ];
            } catch (\Throwable $e) {
                // fall through to named ranges
            }
        }

        $today = BusinessTime::today();

        return match ($range) {
            'today' => [$today->copy(), $today->copy()->endOfDay()],
            'yesterday' => [$today->copy()->subDay(), $today->copy()->subDay()->endOfDay()],
            'week' => [$today->copy()->startOfWeek(MonitoringSetting::weekStartDay()), $today->copy()->endOfDay()],
            'month' => [$today->copy()->startOfMonth(), $today->copy()->endOfDay()],
            '30d' => [$today->copy()->subDays(29), $today->copy()->endOfDay()],
            default => [$today->copy()->subDays(6), $today->copy()->endOfDay()],
        };
    }

    public function sendDigest(Request $request, ActivityDigestService $service): RedirectResponse
    {
        $actor = $request->user();
        abort_unless($actor->hasPermission('reports.send_slack'), 403);

        [$rangeStart, $rangeEnd] = $this->resolveRange($request, $request->input('range', 'today'));

        try {
            $summary = $service->sendRange($rangeStart, $rangeEnd);
        } catch (RuntimeException $e) {
            return back()->with('error', $e->getMessage());
        }

        return back()->with('success', sprintf(
            'Slack digest sent for %s (%d people, %sh tracked).',
            $summary['range']['label'],
            $summary['people'],
            number_format($summary['total_seconds'] / 3600, 2),
        ));
    }

    private function resolveDate(Request $request): Carbon
    {
        return BusinessTime::parseDate($request->input('date'));
    }
}
