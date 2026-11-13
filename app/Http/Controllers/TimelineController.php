<?php

namespace App\Http\Controllers;

use App\Models\MonitoringSetting;
use App\Models\TrackingActivitySample;
use App\Models\TrackingAuditLog;
use App\Models\TrackingScreenshot;
use App\Models\TrackingSession;
use App\Models\User;
use App\Support\BusinessTime;
use App\Support\InputPattern;
use App\Support\WebDomain;
use Carbon\Carbon;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Inertia\Inertia;
use Inertia\Response;

class TimelineController extends Controller
{
    public function index(Request $request): Response
    {
        $authUser = $request->user();
        $canViewOthers = $authUser->hasPermission('timeline.view_others');

        $targetUser = $this->resolveTargetUser($request, $authUser, $canViewOthers);
        $date = $this->resolveDate($request, $targetUser->workTimezone());

        $users = $canViewOthers
            ? User::active()->staff()->orderBy('name')->get(['id', 'name', 'email', 'role'])
            : collect([['id' => $authUser->id, 'name' => $authUser->name, 'email' => $authUser->email, 'role' => $authUser->role]]);

        return Inertia::render('Timeline/Index', [
            'targetUser' => [
                'id' => $targetUser->id,
                'name' => $targetUser->name,
                'email' => $targetUser->email,
                'role' => $targetUser->role,
            ],
            'date' => $date->toDateString(),
            'users' => $users,
            'permissions' => [
                'view_screenshots' => $authUser->hasPermission('monitoring.view_screenshots') || $targetUser->id === $authUser->id,
                'view_others' => $canViewOthers,
                'add_offline_time' => (bool) ($authUser->can_create_manual_work_hour ?? false),
                'manage_screenshots' => $authUser->id === $targetUser->id || $authUser->hasPermission('monitoring.manage'),
                'delete_screenshots' => $authUser->hasPermission('monitoring.delete_screenshots'),
            ],
            'initialData' => $this->buildDayPayload($targetUser, $date, $authUser),
            'weekStartsOn' => MonitoringSetting::current()->week_starts_on,
            'aiEnabled' => app(\App\Services\AnthropicService::class)->configured()
                && $authUser->hasPermission('ai.assistant'),
        ]);
    }

    public function data(Request $request): JsonResponse
    {
        $authUser = $request->user();
        $canViewOthers = $authUser->hasPermission('timeline.view_others');

        $targetUser = $this->resolveTargetUser($request, $authUser, $canViewOthers);
        $date = $this->resolveDate($request, $targetUser->workTimezone());

        return response()->json($this->buildDayPayload($targetUser, $date, $authUser));
    }

    /**
     * AI summary of one person's day. Cached per user+date so repeat clicks
     * (and several admins viewing the same day) cost one API call.
     */
    public function aiSummary(Request $request): JsonResponse
    {
        $authUser = $request->user();
        abort_unless($authUser->hasPermission('ai.assistant'), 403, 'AI access has not been granted to this account.');
        $canViewOthers = $authUser->hasPermission('timeline.view_others');

        $targetUser = $this->resolveTargetUser($request, $authUser, $canViewOthers);
        $date = $this->resolveDate($request, $targetUser->workTimezone());

        $ai = app(\App\Services\AnthropicService::class);
        if (! $ai->configured()) {
            return response()->json(['message' => 'AI is not configured.'], 422);
        }

        $summary = \Illuminate\Support\Facades\Cache::remember(
            "ai-day-summary:{$targetUser->id}:{$date->toDateString()}",
            now()->addHours(6),
            function () use ($ai, $targetUser, $date, $authUser) {
                $payload = $this->buildDayPayload($targetUser, $date, $authUser);

                if (($payload['totals']['day'] ?? 0) <= 0 && empty($payload['sessions'])) {
                    return 'No tracked work on this day.';
                }

                return $ai->daySummary($targetUser->name, $payload)
                    ?? 'The AI summary could not be generated right now — try again in a minute.';
            }
        );

        return response()->json(['summary' => $summary]);
    }

    public function history(Request $request): JsonResponse
    {
        $authUser = $request->user();
        $canViewOthers = $authUser->hasPermission('timeline.view_others');

        $targetUser = $this->resolveTargetUser($request, $authUser, $canViewOthers);
        $date = $this->resolveDate($request, $targetUser->workTimezone());

        [$utcStart, $utcEnd] = BusinessTime::utcRange($date->copy()->startOfDay(), $date->copy()->endOfDay());

        $logs = TrackingAuditLog::with(['actor:id,name'])
            ->where('subject_user_id', $targetUser->id)
            ->where(function ($q) use ($date, $utcStart, $utcEnd) {
                $q->whereDate('event_date', $date->toDateString())
                    ->orWhereBetween('created_at', [$utcStart, $utcEnd]);
            })
            ->orderByDesc('created_at')
            ->limit(200)
            ->get();

        return response()->json([
            'logs' => $logs->map(fn (TrackingAuditLog $log) => [
                'id' => $log->id,
                'action' => $log->action,
                'action_label' => $this->humanizeAction($log->action),
                'reason' => $log->reason,
                'old_value' => $log->old_value,
                'new_value' => $log->new_value,
                'actor_name' => $log->actor?->name ?? 'System',
                'created_at' => $log->created_at?->toIso8601String(),
                'tracking_screenshot_id' => $log->tracking_screenshot_id,
                'tracking_session_id' => $log->tracking_session_id,
            ])->values(),
        ]);
    }

    private function humanizeAction(string $action): string
    {
        return [
            'screenshot.flag' => 'Flagged screenshot',
            'screenshot.unflag' => 'Removed flag from screenshot',
            'screenshot.delete' => 'Deleted screenshot',
            'session.note_edit' => 'Edited session note',
            'session.abandon' => 'Marked session abandoned',
        ][$action] ?? $action;
    }

    /** @return array<string, mixed> */
    private function buildDayPayload(User $targetUser, Carbon $date, User $authUser): array
    {
        $canViewScreenshots = $authUser->id === $targetUser->id
            || $authUser->hasPermission('monitoring.view_screenshots');

        // The target worker's own timezone defines their day boundaries; defaults
        // to Asia/Karachi so local staff render identically to before.
        $tz = $targetUser->workTimezone();

        // $date arrives in the worker's timezone; queries need storage-tz bounds
        // because rows are stored in the app timezone.
        $dayStart = $date->copy()->startOfDay();
        $dayEnd = $date->copy()->endOfDay();
        $weekStartsOn = MonitoringSetting::current()->week_starts_on;
        $weekStart = $weekStartsOn === 'sunday'
            ? $date->copy()->startOfWeek(Carbon::SUNDAY)
            : $date->copy()->startOfWeek(Carbon::MONDAY);
        $weekEnd = $weekStart->copy()->addDays(6)->endOfDay();
        $monthStart = $date->copy()->startOfMonth();
        $monthEnd = $date->copy()->endOfMonth();

        // Sessions that OVERLAP the day, not just those that started on it —
        // a night shift running past midnight must show up on both calendar
        // days, each day with only its own screenshots/activity. The 2-day
        // started_at floor keeps an orphaned "running" session from older
        // days out (the stale sweep closes those anyway).
        [$rangeStart, $rangeEnd] = BusinessTime::utcRange($dayStart, $dayEnd);
        $sessions = TrackingSession::with(['client:id,name', 'upworkProfile:id,name'])
            ->where('user_id', $targetUser->id)
            ->where('started_at', '<=', $rangeEnd)
            ->where('started_at', '>=', $rangeStart->copy()->subDays(2))
            ->where(function ($q) use ($rangeStart) {
                $q->whereNull('stopped_at')->orWhere('stopped_at', '>=', $rangeStart);
            })
            ->orderBy('started_at')
            ->get();

        $sessionIds = $sessions->pluck('id');

        $screenshots = $canViewScreenshots
            ? TrackingScreenshot::whereIn('tracking_session_id', $sessionIds)
                ->whereBetween('captured_at', [$rangeStart, $rangeEnd])
                ->orderBy('captured_at')
                ->get([
                    'id', 'tracking_session_id', 'captured_at', 'thumbnail_path', 'image_path',
                    'activity_percent', 'active_app', 'active_window_title', 'url_domain', 'is_flagged',
                ])
            : collect();

        $shotsBySession = $screenshots->groupBy('tracking_session_id');

        $samples = TrackingActivitySample::whereIn('tracking_session_id', $sessionIds)
            ->whereBetween('captured_at', [$rangeStart, $rangeEnd])
            ->orderBy('captured_at')
            ->get(['id', 'tracking_session_id', 'captured_at', 'keyboard_count', 'mouse_count', 'mouse_clicks', 'idle_seconds', 'active_app', 'url_domain']);

        $samplesBySession = $samples->groupBy('tracking_session_id');
        $sampleIntervalSeconds = MonitoringSetting::current()->activity_sample_interval_seconds ?: 60;

        // Drop ghost sessions that screenshot deletion gutted down to crumbs
        // (sub-minute with no screenshots and no samples left). They would
        // otherwise leave residue in the day total, the Tasks box, and the
        // month-strip dots even though the session list already hides them.
        $sessions = $sessions->filter(function (TrackingSession $session) use ($shotsBySession, $samplesBySession) {
            return (int) $session->total_seconds >= 60
                || ($shotsBySession[$session->id] ?? collect())->isNotEmpty()
                || ($samplesBySession[$session->id] ?? collect())->isNotEmpty();
        })->values();

        $dateKey = $date->toDateString();

        // A session is split into one block per continuous active period —
        // when the tracker idle-pauses (sampling stops) and later resumes, the
        // resumed work shows as its own block from the resume time, instead of
        // one block merged across the break. Display-only; the underlying
        // session is untouched.
        $sessionPayload = $sessions->flatMap(fn (TrackingSession $session) => $this->sessionBlocks(
            $session,
            $shotsBySession[$session->id] ?? collect(),
            $samplesBySession[$session->id] ?? collect(),
            $canViewScreenshots,
            $sampleIntervalSeconds,
            $dayStart,
            $dayEnd,
            $dateKey,
            $tz,
        ))
            // Hide ghost rows: sessions that merely brush the day with under
            // a minute and left no screenshots or activity here only confuse
            // the view (e.g. a stale orphan closed just after midnight).
            ->filter(fn (array $s) => $s['day_seconds'] >= 60
                || count($s['screenshots']) > 0
                || $s['screenshot_count_hidden'] > 0
                || ! empty($s['apps']))
            ->values();

        // Sub-minute sessions never reach work_hours (syncWorkHour skips
        // them), so excluding them here keeps the Timeline week/month totals
        // in step with Reports and ignores any deletion crumbs.
        $totalsScope = fn (Carbon $from, Carbon $to) => (int) TrackingSession::where('user_id', $targetUser->id)
            ->whereBetween('started_at', BusinessTime::utcRange($from, $to))
            ->where('total_seconds', '>=', 60)
            ->sum('total_seconds');

        $clientBreakdown = $sessions
            ->groupBy(fn (TrackingSession $s) => $this->breakdownLabel($s))
            ->map(fn ($group, $name) => [
                'client' => $name,
                'total_seconds' => (int) $group->sum(fn (TrackingSession $s) => $this->inDaySeconds($s, $dayStart, $dayEnd)),
            ])
            ->values();

        return [
            'date' => $date->toDateString(),
            'day_label' => $date->translatedFormat('l, F j'),
            'sessions' => $sessionPayload,
            'totals' => [
                'day' => (int) $sessions->sum(fn (TrackingSession $s) => $this->inDaySeconds($s, $dayStart, $dayEnd)),
                'week' => $totalsScope($weekStart, $weekEnd),
                'month' => $totalsScope($monthStart, $monthEnd),
            ],
            'week_range' => [
                'start' => $weekStart->toDateString(),
                'end' => $weekEnd->toDateString(),
            ],
            'month_strip' => $this->monthStrip($date, $targetUser->id, $tz),
            'client_breakdown' => $clientBreakdown,
            'day_apps' => $this->rollupBy($samples, 'active_app', $sampleIntervalSeconds, 10),
            'day_urls' => $this->rollupBy($samples, 'url_domain', $sampleIntervalSeconds, 10),
            'activity_bands' => $this->activityBands($samples, $sampleIntervalSeconds, $tz),
            'sample_interval_seconds' => (int) $sampleIntervalSeconds,
        ];
    }

    /**
     * Roll up activity samples by a given key (app or domain) into time spent.
     *
     * @return array<int, array<string, mixed>>
     */
    private function rollupBy(Collection $samples, string $key, int $intervalSeconds, int $limit = 12): array
    {
        return $samples
            ->filter(fn ($s) => ! empty($s->{$key}))
            // Normalize domains so www./bare variants roll up together
            // (older samples were stored unnormalized).
            ->groupBy(fn ($s) => $key === 'url_domain'
                ? WebDomain::normalize($s->{$key})
                : $s->{$key})
            ->map(fn ($group, $name) => [
                'name' => $name,
                'samples' => $group->count(),
                'total_seconds' => $group->count() * $intervalSeconds,
            ])
            ->sortByDesc('total_seconds')
            ->values()
            ->take($limit)
            ->all();
    }

    /**
     * Bucket activity samples into 6-minute (10-per-hour) slots and tag each
     * slot active / idle / quiet so the front-end can render bands across the
     * 24h ruler.
     *
     * @return array<int, array<string, mixed>>
     */
    private function activityBands(Collection $samples, int $intervalSeconds, ?string $tz = null): array
    {
        $slotsPerHour = 10;        // 6-minute slots
        $totalSlots = 24 * $slotsPerHour;
        $bands = array_fill(0, $totalSlots, ['active' => 0, 'idle' => 0]);

        // Bucket each sample into the worker's own hour-of-day so the bands line
        // up with their day, not Karachi's.
        $tz = $tz ?: BusinessTime::tz();

        foreach ($samples as $sample) {
            $captured = $sample->captured_at?->copy()->setTimezone($tz);
            if (! $captured) {
                continue;
            }
            $slot = ($captured->hour * $slotsPerHour) + (int) floor($captured->minute / (60 / $slotsPerHour));
            if ($slot < 0 || $slot >= $totalSlots) {
                continue;
            }

            $isActive = ($sample->keyboard_count + $sample->mouse_count) > 0 && $sample->idle_seconds < $intervalSeconds;
            $bands[$slot][$isActive ? 'active' : 'idle']++;
        }

        $out = [];
        foreach ($bands as $i => $counts) {
            if ($counts['active'] === 0 && $counts['idle'] === 0) {
                continue;
            }
            $state = $counts['active'] >= $counts['idle'] ? 'active' : 'idle';
            $out[] = [
                'slot' => $i,
                'hour' => (int) floor($i / $slotsPerHour),
                'minute' => ($i % $slotsPerHour) * (60 / $slotsPerHour),
                'state' => $state,
                'samples' => $counts['active'] + $counts['idle'],
            ];
        }

        return $out;
    }

    /**
     * Portion of a session's tracked seconds that falls inside the given day,
     * allocated proportionally to the wall-clock overlap. An overnight session
     * therefore splits cleanly at midnight: Friday gets the pre-midnight
     * share, Saturday the rest, and the two always sum to total_seconds.
     */
    /**
     * Label for the Tasks breakdown. Client work shows the client; non-client
     * work (office work, bidding, test task) shows the work type instead of a
     * bare "Unassigned", so that time is clearly attributed.
     */
    private function breakdownLabel(TrackingSession $session): string
    {
        if ($session->client?->name) {
            return $session->client->name;
        }

        $labels = [
            'office_work' => 'Office work',
            'test_task' => 'Test task',
            'upwork_bidding' => 'Bidding',
        ];

        if ($session->work_type && isset($labels[$session->work_type])) {
            return $labels[$session->work_type];
        }

        if ($session->work_type) {
            return ucfirst(str_replace('_', ' ', $session->work_type));
        }

        return 'Unassigned';
    }

    /**
     * Split one session into display blocks at idle gaps. The tracker stops
     * sampling while idle-paused, so a gap between consecutive samples longer
     * than the threshold marks a break: the run after it becomes a new block
     * starting at the resume time. Sessions with no gaps render as one block,
     * exactly as before.
     *
     * @return array<int, array<string, mixed>>
     */
    private function sessionBlocks(TrackingSession $session, Collection $rows, Collection $samples, bool $canViewScreenshots, int $interval, Carbon $dayStart, Carbon $dayEnd, string $dateKey, string $tz = 'Asia/Karachi'): array
    {
        $dayTotal = $this->inDaySeconds($session, $dayStart, $dayEnd);
        $gap = max(150, $interval * 3);
        $segments = $this->activeSegments($samples, $gap);

        // No samples (e.g. capture blocked) or a single active run → one block.
        if (count($segments) <= 1) {
            return [$this->sessionBlock($session, $rows, $samples, $dayTotal, $session->started_at, $session->stopped_at, 0, false, true, true, $canViewScreenshots, $interval, $dateKey, $tz, 0)];
        }

        $totalSamples = max(1, array_sum(array_map(fn ($s) => $s['samples']->count(), $segments)));
        $starts = array_map(fn ($s) => $s['start'], $segments);
        $last = count($segments) - 1;

        $blocks = [];
        $prevEnd = null;
        foreach ($segments as $i => $seg) {
            $isFirst = $i === 0;
            $nextStart = $i < $last ? $starts[$i + 1] : null;

            // Screenshots from this block's start up to the next block's start,
            // so every shot lands in exactly one block.
            $blockShots = $rows->filter(function (TrackingScreenshot $s) use ($isFirst, $seg, $nextStart) {
                $t = $s->captured_at;
                if (! $t) {
                    return false;
                }
                $afterStart = $isFirst || $t->greaterThanOrEqualTo($seg['start']);
                $beforeNext = $nextStart === null || $t->lessThan($nextStart);

                return $afterStart && $beforeNext;
            })->values();

            $blocks[] = $this->sessionBlock(
                $session,
                $blockShots,
                $seg['samples'],
                (int) round($dayTotal * ($seg['samples']->count() / $totalSamples)),
                $isFirst ? $session->started_at : $seg['start'],
                // A finished block ends where its active run ended (the idle
                // gap); only the current/last block keeps the session's own end
                // (null while it's still live).
                $i === $last ? $session->stopped_at : $seg['end'],
                $prevEnd ? (int) $prevEnd->diffInSeconds($seg['start']) : 0,
                ! $isFirst,
                $isFirst,
                $i === $last,
                $canViewScreenshots,
                $interval,
                $dateKey,
                $tz,
                $i,
            );
            $prevEnd = $seg['end'];
        }

        return $blocks;
    }

    /**
     * Group a session's samples into continuous active runs, breaking wherever
     * consecutive samples are more than $gap seconds apart (an idle pause).
     *
     * @return array<int, array{start: Carbon, end: Carbon, samples: Collection}>
     */
    private function activeSegments(Collection $samples, int $gap): array
    {
        $sorted = $samples->filter(fn ($s) => $s->captured_at)
            ->sortBy(fn ($s) => $s->captured_at->getTimestamp())->values();
        if ($sorted->isEmpty()) {
            return [];
        }

        $segments = [];
        $cur = [];
        $curStart = $sorted->first()->captured_at;
        $prev = $sorted->first()->captured_at;
        foreach ($sorted as $s) {
            // Earlier->later so the diff is positive (Carbon 3 diffs are signed).
            if ($prev->diffInSeconds($s->captured_at) > $gap && $cur) {
                $segments[] = ['start' => $curStart, 'end' => $prev, 'samples' => collect($cur)];
                $cur = [];
                $curStart = $s->captured_at;
            }
            $cur[] = $s;
            $prev = $s->captured_at;
        }
        if ($cur) {
            $segments[] = ['start' => $curStart, 'end' => $prev, 'samples' => collect($cur)];
        }

        return $segments;
    }

    /** Build a single Timeline block payload (whole session, or one segment). */
    private function sessionBlock(TrackingSession $session, Collection $rows, Collection $samples, int $daySeconds, ?Carbon $blockStart, ?Carbon $blockEnd, int $idleBefore, bool $isResumed, bool $isFirst, bool $isLast, bool $canViewScreenshots, int $interval, string $dateKey, string $tz = 'Asia/Karachi', int $blockIndex = 0): array
    {
        // Honest keystrokes + real clicks per screenshot, summed from the
        // per-minute samples in each shot's window (see screenshotInput).
        $inputByShot = $canViewScreenshots
            ? $this->screenshotInput($rows, $samples, $blockStart ?? $session->started_at)
            : [];

        return [
            'id' => $session->id,
            // Stable UNIQUE React key per display block. A session split at idle
            // gaps emits several blocks that all share the real session id, so
            // keying the frontend list on `id` collided; `block_key` disambiguates
            // them while `id` stays the real DB session id for delete/select.
            'block_key' => $session->id . '-' . $blockIndex,
            'client_name' => $session->client?->name,
            'task_note' => $session->task_note,
            'work_type' => $session->work_type,
            'tracker' => $session->upworkProfile?->name,
            'started_at' => ($blockStart ?? $session->started_at)?->toIso8601String(),
            'stopped_at' => $blockEnd?->toIso8601String(),
            // A resumed block shows only its own slice; a single (un-split) block
            // keeps the session total so the overnight "X of Y" label still works.
            'total_seconds' => $isResumed ? $daySeconds : (int) $session->total_seconds,
            'day_seconds' => $daySeconds,
            'started_before_day' => $isFirst && BusinessTime::dateKey($session->started_at, $tz) < $dateKey,
            'continues_after_day' => $isLast && $session->stopped_at !== null && BusinessTime::dateKey($session->stopped_at, $tz) > $dateKey,
            'is_resumed' => $isResumed,
            'idle_before_seconds' => $idleBefore,
            'activity_percent' => (int) $session->activity_percent,
            'status' => $session->status,
            'screenshots' => $canViewScreenshots
                ? $rows->map(fn (TrackingScreenshot $s) => [
                    'id' => $s->id,
                    'captured_at' => $s->captured_at?->toIso8601String(),
                    'thumbnail_url' => $s->thumbnail_url,
                    'image_url' => $s->image_url,
                    'activity_percent' => (int) $s->activity_percent,
                    'keystrokes' => $inputByShot[$s->id]['keystrokes'] ?? 0,
                    'clicks' => $inputByShot[$s->id]['clicks'] ?? 0,
                    'active_app' => $s->active_app,
                    'active_window_title' => $s->active_window_title,
                    'url_domain' => $s->url_domain,
                    'is_flagged' => (bool) $s->is_flagged,
                ])->values()
                : [],
            'screenshot_count_hidden' => $canViewScreenshots ? 0 : (int) $rows->count(),
            'apps' => $this->rollupBy($samples, 'active_app', $interval),
            'urls' => $this->rollupBy($samples, 'url_domain', $interval),
            // Review-only signal: does the input look machine-generated
            // (jiggler)? Never cuts time — just flags for a human to check.
            'automation' => InputPattern::suspectedAutomation($samples, (int) $session->activity_percent),
        ];
    }

    /**
     * Keystrokes + real mouse clicks for each screenshot, summed from the
     * per-minute activity samples in the window since the previous shot. The
     * count stored on a screenshot itself only covers the last ~minute (the
     * desktop resets the counter every sample), so aggregating the samples for
     * the shot's interval gives an honest figure for the period it represents.
     *
     * @return array<int, array{keystrokes: int, clicks: int}>
     */
    private function screenshotInput(Collection $rows, Collection $samples, ?Carbon $blockStart): array
    {
        // Screenshot windows are contiguous: shot i owns the samples captured
        // after the previous shot (or the block start) up to and including its
        // own time. Rather than scan every sample for every shot (O(shots*samples)
        // — which made dense days take ~13s), sort both once and sweep a single
        // shot pointer forward, giving O(shots + samples).
        $shots = $rows->filter(fn (TrackingScreenshot $s) => $s->captured_at)
            ->sortBy(fn (TrackingScreenshot $s) => $s->captured_at->getTimestamp())
            ->values();

        $out = [];
        foreach ($shots as $shot) {
            $out[$shot->id] = ['keystrokes' => 0, 'clicks' => 0];
        }
        if ($shots->isEmpty()) {
            return $out;
        }

        $sorted = $samples->filter(fn ($s) => $s->captured_at)
            ->sortBy(fn ($s) => $s->captured_at->getTimestamp())
            ->values();

        $startTs = $blockStart?->getTimestamp();
        $shotCount = $shots->count();
        $i = 0;

        foreach ($sorted as $smp) {
            $t = $smp->captured_at->getTimestamp();
            // A sample at or before the first window's lower bound (block start)
            // belongs to no screenshot — matches the old `t > prev` guard.
            if ($startTs !== null && $t <= $startTs) {
                continue;
            }
            // Advance to the first shot whose time is >= this sample (i.e. the
            // shot whose window this sample falls in: prevShot < t <= thisShot).
            while ($i < $shotCount && $shots[$i]->captured_at->getTimestamp() < $t) {
                $i++;
            }
            if ($i >= $shotCount) {
                break; // later samples fall past the last screenshot — unowned
            }
            $id = $shots[$i]->id;
            $out[$id]['keystrokes'] += (int) $smp->keyboard_count;
            $out[$id]['clicks'] += (int) ($smp->mouse_clicks ?? 0);
        }

        return $out;
    }

    private function inDaySeconds(TrackingSession $session, Carbon $dayStart, Carbon $dayEnd): int
    {
        return app(\App\Services\TrackingSessionService::class)
            ->inDaySeconds($session, $dayStart, $dayEnd);
    }

    /** @return array<int, array<string, mixed>> */
    private function monthStrip(Carbon $date, int $userId, string $tz = 'Asia/Karachi'): array
    {
        $start = $date->copy()->startOfMonth();
        $end = $date->copy()->endOfMonth();

        // Bucket in PHP by business-tz date: SQL DATE() would group by the
        // stored UTC date and shift late-evening sessions onto the wrong day.
        // Overnight sessions are split at midnight (same allocation as the
        // day view) so each dot reflects the work done on that calendar day.
        [$rangeStart, $rangeEnd] = BusinessTime::utcRange($start, $end->copy()->endOfDay());
        $rows = TrackingSession::query()
            ->where('user_id', $userId)
            ->where('started_at', '<=', $rangeEnd)
            ->where('started_at', '>=', $rangeStart->copy()->subDays(2))
            // Skip deletion crumbs so the day dots match the real day totals.
            ->where('total_seconds', '>=', 60)
            ->where(function ($q) use ($rangeStart) {
                $q->whereNull('stopped_at')->orWhere('stopped_at', '>=', $rangeStart);
            })
            ->get(['started_at', 'stopped_at', 'total_seconds']);

        $perDay = [];
        foreach ($rows as $session) {
            $firstDay = BusinessTime::dateKey($session->started_at, $tz);
            $lastDay = BusinessTime::dateKey($session->stopped_at, $tz) ?? BusinessTime::today($tz)->toDateString();
            for ($day = Carbon::parse($firstDay, $tz); $day->toDateString() <= $lastDay; $day->addDay()) {
                $seconds = $this->inDaySeconds($session, $day->copy()->startOfDay(), $day->copy()->endOfDay());
                if ($seconds >= 30) {
                    $perDay[$day->toDateString()] = ($perDay[$day->toDateString()] ?? 0) + $seconds;
                }
            }
        }

        $today = BusinessTime::today($tz);

        $out = [];
        for ($cursor = $start->copy(); $cursor->lte($end); $cursor->addDay()) {
            $iso = $cursor->toDateString();
            $out[] = [
                'date' => $iso,
                'day' => (int) $cursor->day,
                'weekday' => $cursor->translatedFormat('D'),
                'total_seconds' => (int) ($perDay[$iso] ?? 0),
                'is_today' => $cursor->isSameDay($today),
                'is_selected' => $cursor->isSameDay($date),
            ];
        }

        return $out;
    }

    private function resolveTargetUser(Request $request, User $authUser, bool $canViewOthers): User
    {
        $requested = (int) $request->input('user_id', 0);

        if (! $canViewOthers || ! $requested || $requested === $authUser->id) {
            return $authUser;
        }

        return User::query()->findOrFail($requested);
    }

    private function resolveDate(Request $request, ?string $tz = null): Carbon
    {
        // Parse the selected day in the TARGET worker's timezone so the timeline's
        // day/week/month boundaries are the worker's midnight, not Karachi's.
        return BusinessTime::parseDate($request->input('date'), $tz);
    }
}
