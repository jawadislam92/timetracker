<?php

namespace App\Services;

use App\Models\TimeEntry;
use App\Models\User;
use App\Support\AttendanceHours;
use Carbon\Carbon;
use Carbon\CarbonInterface;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use RuntimeException;

/**
 * The weekly team digest: one readable Slack message with a bullet per person —
 * tracked hours + activity %, in-office hours, the in-office-vs-tracked gap
 * (so "in office but not tracking" stands out), and how many days they were
 * late. Replaces the cramped daily activity-table digest.
 */
class WeeklyDigestService
{
    public function __construct(private TeamMetricsService $metrics) {}

    public function configured(): bool
    {
        return filled(config('services.slack_reports.webhook_url'));
    }

    /** @return array<string, mixed> */
    public function buildPayload(CarbonInterface $start, CarbonInterface $end): array
    {
        $users = User::query()
            ->staff()
            ->where('include_in_slack_reports', true)
            ->where('tracks_time', true)
            ->where('is_active', true)
            ->with(User::shiftEagerLoads())
            ->orderBy('name')
            ->get(['id', 'name', 'shift_start_time', 'shift_grace_minutes', 'shift_hours']);

        $userIds = $users->pluck('id')->all();
        $metrics = $this->metrics->forRange($userIds, $start, $end);

        $entriesByUser = TimeEntry::query()
            ->whereIn('user_id', $userIds)
            ->whereBetween('action_date', [$start->toDateString(), $end->toDateString()])
            ->orderBy('action_timestamp')
            ->get()
            ->groupBy('user_id');

        $rows = $users->map(function (User $user) use ($metrics, $entriesByUser) {
            $m = $metrics->get($user->id, ['tracked_seconds' => 0, 'activity_percent' => 0]);
            $trackedSeconds = (int) $m['tracked_seconds'];

            $inOfficeHours = 0.0;
            $lateDays = 0;
            foreach (($entriesByUser->get($user->id, collect()))->groupBy(fn ($e) => Carbon::parse($e->action_date)->toDateString()) as $day => $dayEntries) {
                $inOfficeHours += AttendanceHours::dayInOfficeHours($dayEntries);
                $firstClockIn = $dayEntries->firstWhere('action_type', 'clock_in');
                if (AttendanceHours::isLateClockIn($user, Carbon::parse($day), $firstClockIn)) {
                    $lateDays++;
                }
            }

            $trackedHours = round($trackedSeconds / 3600, 2);
            $inOfficeHours = round($inOfficeHours, 2);

            return [
                'user_id' => $user->id,
                'name' => $user->name,
                'tracked_hours' => $trackedHours,
                'activity_percent' => (int) $m['activity_percent'],
                'in_office_hours' => $inOfficeHours,
                'gap_hours' => round(max(0, $inOfficeHours - $trackedHours), 2),
                'late_days' => $lateDays,
            ];
        })
            ->filter(fn ($r) => $r['in_office_hours'] > 0 || $r['tracked_hours'] > 0)
            // Biggest in-office-vs-tracked gap first, so under-trackers surface.
            ->sortByDesc('gap_hours')
            ->values()
            ->all();

        return [
            'range' => [
                'start' => $start->toDateString(),
                'end' => $end->toDateString(),
                'label' => "{$start->translatedFormat('M j')} → {$end->translatedFormat('M j')}",
            ],
            'totals' => [
                'people' => count($rows),
                'tracked_seconds' => (int) array_sum(array_map(fn ($r) => (int) round($r['tracked_hours'] * 3600), $rows)),
            ],
            'rows' => $rows,
        ];
    }

    /** @return array{text: string} */
    public function formatSlack(array $payload): array
    {
        $lines = ["*Weekly digest — {$payload['range']['label']}*"];

        if (empty($payload['rows'])) {
            $lines[] = 'No tracked or in-office time this week.';

            return ['text' => implode("\n", $lines)];
        }

        $lines[] = sprintf(
            ':bar_chart: %d %s · %s tracked this week',
            $payload['totals']['people'],
            $payload['totals']['people'] === 1 ? 'person' : 'people',
            $this->humanHours($payload['totals']['tracked_seconds'] / 3600),
        );
        $lines[] = '';

        foreach ($payload['rows'] as $r) {
            $gap = $r['gap_hours'] >= 1
                ? sprintf(':warning: %s untracked', $this->humanHours($r['gap_hours']))
                : 'tracking on par';
            $late = $r['late_days'] > 0
                ? sprintf('%d late day%s', $r['late_days'], $r['late_days'] === 1 ? '' : 's')
                : 'no late days';

            $lines[] = sprintf(
                '• *%s* — Tracked %s (%d%% activity) · In office %s · %s · %s',
                $r['name'],
                $this->humanHours($r['tracked_hours']),
                $r['activity_percent'],
                $this->humanHours($r['in_office_hours']),
                $gap,
                $late,
            );
        }

        return ['text' => implode("\n", $lines)];
    }

    /** @return array<string, mixed> */
    public function sendRange(CarbonInterface $start, CarbonInterface $end): array
    {
        if (! $this->configured()) {
            throw new RuntimeException('Slack reporting is not configured.');
        }

        $payload = $this->buildPayload($start, $end);
        $response = Http::asJson()->post(config('services.slack_reports.webhook_url'), $this->formatSlack($payload));

        if ($response->failed()) {
            Log::warning('Weekly digest Slack push failed', ['status' => $response->status(), 'body' => $response->body()]);
            throw new RuntimeException('Slack returned an error: '.$response->status());
        }

        return ['range' => $payload['range'], 'people' => $payload['totals']['people']];
    }

    private function humanHours(float $hours): string
    {
        $h = (int) floor($hours);
        $m = (int) round(($hours - $h) * 60);
        if ($m === 60) { $h++; $m = 0; }
        if ($h === 0) {
            return $m.'m';
        }

        return $m === 0 ? "{$h}h" : "{$h}h {$m}m";
    }
}
