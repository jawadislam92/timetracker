<?php

namespace App\Http\Controllers;

use App\Models\TrackingAuditLog;
use App\Models\TrackingScreenshot;
use App\Models\TrackingSession;
use App\Models\User;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Inertia\Inertia;
use Symfony\Component\HttpFoundation\StreamedResponse;

class MonitoringController extends Controller
{
    public function sessions(Request $request)
    {
        $user = $request->user();
        $canViewAll = $user->hasPermission('monitoring.view');

        $query = TrackingSession::with(['user:id,name,email', 'client:id,name'])
            ->orderBy('started_at', 'desc');

        if (! $canViewAll) {
            $query->where('user_id', $user->id);
        } elseif ($request->filled('user_id')) {
            $query->where('user_id', (int) $request->input('user_id'));
        }

        $sessions = $query->paginate(25)->withQueryString();

        return Inertia::render('Monitoring/SessionsList', [
            'sessions' => $sessions,
            'users' => $canViewAll
                ? User::active()->staff()->orderBy('name')->get(['id', 'name'])
                : [],
            'filters' => [
                'user_id' => $request->input('user_id'),
            ],
            'permissions' => [
                'view_screenshots' => $user->hasPermission('monitoring.view_screenshots'),
                'manage' => $user->hasPermission('monitoring.manage'),
            ],
        ]);
    }

    public function showSession(Request $request, TrackingSession $session)
    {
        $user = $request->user();

        if ($session->user_id !== $user->id) {
            abort_unless($user->hasPermission('monitoring.view'), 403);
        }

        $canViewScreenshots = $session->user_id === $user->id
            || $user->hasPermission('monitoring.view_screenshots');

        $session->load(['user:id,name,email', 'client:id,name']);

        $screenshots = $canViewScreenshots
            ? $session->screenshots()->orderBy('captured_at', 'asc')->get([
                'id', 'tracking_session_id', 'captured_at', 'thumbnail_path', 'image_path',
                'activity_percent', 'active_app', 'active_window_title', 'url_domain', 'is_flagged',
            ])->map(function (TrackingScreenshot $s) {
                return [
                    'id' => $s->id,
                    'captured_at' => $s->captured_at?->toIso8601String(),
                    'thumbnail_url' => $s->thumbnail_url,
                    'image_url' => $s->image_url,
                    'activity_percent' => $s->activity_percent,
                    'active_app' => $s->active_app,
                    'active_window_title' => $s->active_window_title,
                    'url_domain' => $s->url_domain,
                    'is_flagged' => $s->is_flagged,
                ];
            })
            : [];

        return Inertia::render('Monitoring/SessionDetail', [
            'session' => $session,
            'screenshots' => $screenshots,
            'permissions' => [
                'view_screenshots' => $canViewScreenshots,
                'delete_screenshots' => $user->hasPermission('monitoring.delete_screenshots'),
            ],
        ]);
    }

    public function screenshotImage(Request $request, TrackingScreenshot $screenshot): StreamedResponse
    {
        $this->authorizeScreenshotAccess($request, $screenshot);

        abort_unless($screenshot->image_path && Storage::disk('screenshots')->exists($screenshot->image_path), 404);

        return Storage::disk('screenshots')->response($screenshot->image_path);
    }

    public function screenshotThumbnail(Request $request, TrackingScreenshot $screenshot): StreamedResponse
    {
        $this->authorizeScreenshotAccess($request, $screenshot);

        $path = $screenshot->thumbnail_path && Storage::disk('screenshots')->exists($screenshot->thumbnail_path)
            ? $screenshot->thumbnail_path
            : $screenshot->image_path;

        abort_unless($path && Storage::disk('screenshots')->exists($path), 404);

        return Storage::disk('screenshots')->response($path);
    }

    private function authorizeScreenshotAccess(Request $request, TrackingScreenshot $screenshot): void
    {
        $user = $request->user();

        if ($screenshot->user_id === $user->id) {
            return;
        }

        abort_unless($user->hasPermission('monitoring.view_screenshots'), 403);
    }

    public function flagScreenshot(Request $request, TrackingScreenshot $screenshot): RedirectResponse
    {
        $actor = $request->user();
        $this->authorizeScreenshotManagement($actor, $screenshot);

        $data = $request->validate([
            'is_flagged' => ['required', 'boolean'],
            'reason' => ['nullable', 'string', 'max:500'],
        ]);

        $previous = (bool) $screenshot->is_flagged;
        $next = (bool) $data['is_flagged'];

        if ($previous === $next) {
            return back()->with('success', 'No change.');
        }

        $screenshot->update([
            'is_flagged' => $next,
            'flag_reason' => $next ? ($data['reason'] ?? null) : null,
        ]);

        TrackingAuditLog::record([
            'tracking_session_id' => $screenshot->tracking_session_id,
            'tracking_screenshot_id' => $screenshot->id,
            'subject_user_id' => $screenshot->user_id,
            'actor_user_id' => $actor->id,
            'action' => $next ? 'screenshot.flag' : 'screenshot.unflag',
            'event_date' => optional($screenshot->captured_at)->toDateString(),
            'old_value' => ['is_flagged' => $previous],
            'new_value' => ['is_flagged' => $next, 'reason' => $data['reason'] ?? null],
            'reason' => $data['reason'] ?? null,
        ]);

        return back()->with('success', $next ? 'Screenshot flagged.' : 'Screenshot un-flagged.');
    }

    public function deleteScreenshot(Request $request, TrackingScreenshot $screenshot): RedirectResponse
    {
        $actor = $request->user();
        abort_unless($actor->hasPermission('monitoring.delete_screenshots'), 403);

        $data = $request->validate([
            'reason' => ['nullable', 'string', 'max:500'],
        ]);

        $deducted = $this->deleteShotsAndDeductTime($actor, collect([$screenshot]), $data['reason'] ?? null);

        return back()->with('success', 'Screenshot deleted — '.round($deducted / 60).' minute(s) of tracked time removed.');
    }

    /**
     * Delete several screenshots at once (e.g. a whole "watched YouTube"
     * stretch) and remove the tracked time they represent.
     */
    public function bulkDeleteScreenshots(Request $request): RedirectResponse
    {
        $actor = $request->user();
        abort_unless($actor->hasPermission('monitoring.delete_screenshots'), 403);

        $data = $request->validate([
            'screenshot_ids' => ['required', 'array', 'min:1', 'max:200'],
            'screenshot_ids.*' => ['integer'],
            'reason' => ['nullable', 'string', 'max:500'],
        ]);

        $shots = TrackingScreenshot::whereIn('id', $data['screenshot_ids'])->get();
        if ($shots->isEmpty()) {
            return back()->with('error', 'No matching screenshots found.');
        }

        $deducted = 0;
        foreach ($shots->groupBy('tracking_session_id') as $sessionShots) {
            $deducted += $this->deleteShotsAndDeductTime($actor, $sessionShots, $data['reason'] ?? null);
        }

        return back()->with('success', $shots->count().' screenshot(s) deleted — '.round($deducted / 60).' minute(s) of tracked time removed.');
    }

    /**
     * Each screenshot stands for the interval since the previous one in its
     * session (capped at 10 minutes, session start for the first). Deleting
     * it removes that interval from the session's tracked seconds and
     * re-syncs the mirrored work-hours row, so wrongly tracked time stops
     * counting anywhere the moment the evidence is removed.
     *
     * @param  \Illuminate\Support\Collection<int, TrackingScreenshot>  $shots  all in the same session
     * @return int seconds deducted
     */
    private function deleteShotsAndDeductTime(User $actor, $shots, ?string $reason): int
    {
        $session = $shots->first()->trackingSession;

        // Ordered full set for interval math (before anything is deleted).
        $all = TrackingScreenshot::where('tracking_session_id', $shots->first()->tracking_session_id)
            ->orderBy('captured_at')
            ->get();

        $deleteIds = $shots->pluck('id')->all();
        $deducted = 0;
        $previousAt = $session?->started_at;

        foreach ($all as $shot) {
            $windowStart = $previousAt;
            $gap = $previousAt && $shot->captured_at
                ? min(max(0, $previousAt->diffInSeconds($shot->captured_at)), 600)
                : 0;
            $previousAt = $shot->captured_at ?? $previousAt;

            if (! in_array($shot->id, $deleteIds, true)) {
                continue;
            }

            $deducted += $gap;

            // The apps & URLs samples captured in the same interval go with
            // it — otherwise deleted YouTube time would keep showing in the
            // activity rollups.
            if ($windowStart && $shot->captured_at) {
                \App\Models\TrackingActivitySample::where('tracking_session_id', $shot->tracking_session_id)
                    ->where('captured_at', '>', $windowStart)
                    ->where('captured_at', '<=', $shot->captured_at)
                    ->delete();
            }

            TrackingAuditLog::record([
                'tracking_session_id' => $shot->tracking_session_id,
                'tracking_screenshot_id' => $shot->id,
                'subject_user_id' => $shot->user_id,
                'actor_user_id' => $actor->id,
                'action' => 'screenshot.delete',
                'event_date' => optional($shot->captured_at)->toDateString(),
                'old_value' => [
                    'image_path' => $shot->image_path,
                    'captured_at' => optional($shot->captured_at)->toIso8601String(),
                ],
                'new_value' => ['deducted_seconds' => $gap],
                'reason' => $reason,
            ]);

            // Soft delete the row but keep the actual image file (so the audit
            // record remains meaningful and the action can be reversed by a
            // DBA if needed).
            $shot->delete();
        }

        if ($session && $deducted > 0) {
            $session->update(['total_seconds' => max(0, (int) $session->total_seconds - $deducted)]);
            $session->refresh();

            $remainingShots = TrackingScreenshot::where('tracking_session_id', $session->id)->count();

            if ($session->total_seconds < 60 && $remainingShots === 0) {
                // Gutted down to crumbs — remove the whole session so it
                // leaves no residue on the month strip, day totals, Tasks
                // box, or Team Performance.
                app(\App\Services\TrackingSessionService::class)->purge($session);
            } elseif ($session->total_seconds >= 60) {
                app(\App\Services\TrackingSessionService::class)->syncWorkHour($session);
            } else {
                // Below the sync threshold but still has screenshots — drop
                // the mirrored row so the deleted time can't linger in reports.
                \App\Models\WorkHour::where('tracking_session_id', $session->id)->delete();
            }
        }

        return $deducted;
    }

    /**
     * Delete an entire tracking session: its time, screenshots, activity
     * samples, and the mirrored work-hours row. This is the tool for time
     * blocks with no screenshot evidence (or fully bogus sessions) that
     * per-screenshot deletion can't reach.
     */
    public function deleteSession(Request $request, \App\Models\TrackingSession $session): RedirectResponse
    {
        $actor = $request->user();
        abort_unless($actor->hasPermission('monitoring.delete_screenshots'), 403);

        $data = $request->validate([
            'reason' => ['nullable', 'string', 'max:500'],
        ]);

        TrackingAuditLog::record([
            'tracking_session_id' => $session->id,
            'subject_user_id' => $session->user_id,
            'actor_user_id' => $actor->id,
            'action' => 'session.delete',
            'event_date' => optional($session->started_at)->toDateString(),
            'old_value' => [
                'started_at' => optional($session->started_at)->toIso8601String(),
                'stopped_at' => optional($session->stopped_at)->toIso8601String(),
                'total_seconds' => (int) $session->total_seconds,
                'screenshots' => $session->screenshots()->count(),
            ],
            'new_value' => null,
            'reason' => $data['reason'] ?? null,
        ]);

        $minutes = round((int) $session->total_seconds / 60);

        app(\App\Services\TrackingSessionService::class)->purge($session);

        return back()->with('success', "Session deleted — {$minutes} minute(s) of tracked time and all connected data removed.");
    }

    private function authorizeScreenshotManagement(User $actor, TrackingScreenshot $screenshot): void
    {
        if ($actor->id === $screenshot->user_id) {
            return;
        }

        abort_unless($actor->hasPermission('monitoring.manage'), 403);
    }
}
