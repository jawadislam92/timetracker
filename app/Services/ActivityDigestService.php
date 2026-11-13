<?php

namespace App\Services;

use App\Models\TrackingActivitySample;
use App\Models\TrackingSession;
use App\Models\User;
use Carbon\CarbonInterface;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use RuntimeException;

class ActivityDigestService
{
    public function configured(): bool
    {
        return filled(config('services.slack_reports.webhook_url'));
    }

    /**
     * Build the payload for a date range (defaults to "yesterday" when called
     * by the scheduled morning digest).
     *
     * @return array<string, mixed>
     */
    public function buildPayload(CarbonInterface $start, CarbonInterface $end): array
    {
        // Align bounds with the storage timezone (app.timezone).
        $storageTz = config('app.timezone', 'Asia/Karachi');
        $rangeStart = $start->copy()->setTimezone($storageTz);
        $rangeEnd = $end->copy()->setTimezone($storageTz);

        // Load sessions OVERLAPPING the range (not merely started in it) and
        // credit each its in-range share via inDaySeconds — the same
        // calendar-day allocation the dashboard/Timeline/desktop use, so this
        // digest can't report a different "tracked" number for the same day.
        $svc = app(TrackingSessionService::class);
        $sessions = TrackingSession::with('client:id,name')
            ->where('started_at', '<=', $rangeEnd)
            ->where(function ($q) use ($rangeStart) {
                $q->whereNull('stopped_at')->orWhere('stopped_at', '>=', $rangeStart);
            })
            ->get(['id', 'user_id', 'client_id', 'started_at', 'stopped_at', 'total_seconds', 'activity_percent']);

        $samples = TrackingActivitySample::whereBetween('captured_at', [$rangeStart, $rangeEnd])
            ->get(['id', 'user_id', 'tracking_session_id', 'captured_at', 'keyboard_count', 'mouse_count', 'idle_seconds', 'active_app']);

        $userIds = $sessions->pluck('user_id')->merge($samples->pluck('user_id'))->unique();
        $users = User::whereIn('id', $userIds)
            ->staff()
            ->where('include_in_slack_reports', true)
            ->where('tracks_time', true)
            ->where('is_active', true)
            ->orderBy('name')
            ->get(['id', 'name'])
            ->keyBy('id');

        $rows = $users->map(function (User $user) use ($sessions, $samples, $svc, $rangeStart, $rangeEnd) {
            $userSessions = $sessions->where('user_id', $user->id);
            $userSamples = $samples->where('user_id', $user->id);

            $total = (int) $userSessions->sum(fn ($s) => $svc->inDaySeconds($s, $rangeStart, $rangeEnd));
            $active = $userSamples->filter(fn ($s) => ($s->keyboard_count + $s->mouse_count) > 0 && $s->idle_seconds < 60)->count();
            $activityPct = $userSamples->count() > 0 ? (int) round($active / $userSamples->count() * 100) : 0;

            $topClient = $userSessions
                ->groupBy(fn ($s) => $s->client?->name ?: 'Unassigned')
                ->map(fn ($g, $name) => ['name' => $name, 'total_seconds' => (int) $g->sum(fn ($s) => $svc->inDaySeconds($s, $rangeStart, $rangeEnd))])
                ->sortByDesc('total_seconds')
                ->first();

            $topApp = $userSamples
                ->filter(fn ($s) => ! empty($s->active_app))
                ->groupBy('active_app')
                ->map(fn ($g, $name) => ['name' => $name, 'count' => $g->count()])
                ->sortByDesc('count')
                ->first();

            return [
                'user_id' => $user->id,
                'name' => $user->name,
                'total_seconds' => $total,
                'activity_percent' => $activityPct,
                'top_client' => $topClient ? $topClient['name'] : null,
                'top_app' => $topApp ? $topApp['name'] : null,
            ];
        })
            ->filter(fn ($row) => $row['total_seconds'] > 0)
            ->sortByDesc('total_seconds')
            ->values()
            ->all();

        $totals = [
            'people' => count($rows),
            'total_seconds' => array_sum(array_column($rows, 'total_seconds')),
            'avg_activity' => $rows ? (int) round(array_sum(array_column($rows, 'activity_percent')) / count($rows)) : 0,
        ];

        return [
            'range' => [
                'start' => $start->toIso8601String(),
                'end' => $end->toIso8601String(),
                'label' => $start->isSameDay($end) ? $start->translatedFormat('l, F j') : "{$start->toDateString()} → {$end->toDateString()}",
            ],
            'totals' => $totals,
            'rows' => $rows,
        ];
    }

    public function formatSlack(array $payload): array
    {
        $rows = $payload['rows'];
        $totals = $payload['totals'];

        if (empty($rows)) {
            $text = "*Activity digest — {$payload['range']['label']}*\nNo tracked time recorded.";

            return ['text' => $text];
        }

        $lines = [];
        $lines[] = "*Activity digest — {$payload['range']['label']}*";
        $lines[] = sprintf(
            ':bar_chart: %d %s · %s tracked · %d%% avg activity',
            $totals['people'],
            $totals['people'] === 1 ? 'person' : 'people',
            $this->humanSeconds($totals['total_seconds']),
            $totals['avg_activity'],
        );

        // AI narrative — only when an Anthropic key is configured on the
        // Developer page; without it the digest sends exactly as before.
        $narrative = app(AnthropicService::class)->digestNarrative($payload);
        if ($narrative) {
            $lines[] = '';
            $lines[] = ':sparkles: '.$narrative;
        }

        $lines[] = '';
        $lines[] = '```';
        $lines[] = sprintf('%-22s %8s %5s  %-22s %-22s', 'Member', 'Time', 'Act%', 'Top client', 'Top app');
        $lines[] = str_repeat('-', 90);
        foreach ($rows as $row) {
            $lines[] = sprintf(
                '%-22s %8s %4d%%  %-22s %-22s',
                $this->truncate($row['name'], 22),
                $this->humanSeconds($row['total_seconds']),
                $row['activity_percent'],
                $this->truncate($row['top_client'] ?: '—', 22),
                $this->truncate($row['top_app'] ?: '—', 22),
            );
        }
        $lines[] = '```';

        return ['text' => implode("\n", $lines)];
    }

    /**
     * Send the digest. Returns a small summary so callers can log/show it.
     *
     * @return array<string, mixed>
     */
    public function sendRange(CarbonInterface $start, CarbonInterface $end): array
    {
        if (! $this->configured()) {
            throw new RuntimeException('Slack reporting is not configured.');
        }

        $payload = $this->buildPayload($start, $end);
        $message = $this->formatSlack($payload);

        $response = Http::asJson()->post(config('services.slack_reports.webhook_url'), $message);

        if ($response->failed()) {
            Log::warning('Activity digest Slack push failed', [
                'status' => $response->status(),
                'body' => $response->body(),
            ]);
            throw new RuntimeException('Slack accepted the request but returned an error: '.$response->status());
        }

        return [
            'range' => $payload['range'],
            'people' => $payload['totals']['people'],
            'total_seconds' => $payload['totals']['total_seconds'],
        ];
    }

    private function humanSeconds(int $seconds): string
    {
        $h = intdiv($seconds, 3600);
        $m = intdiv($seconds % 3600, 60);
        if ($h === 0) {
            return $m.'m';
        }

        return "{$h}h ".str_pad((string) $m, 2, '0', STR_PAD_LEFT).'m';
    }

    private function truncate(string $value, int $max): string
    {
        if (mb_strlen($value) <= $max) {
            return $value;
        }

        return mb_substr($value, 0, $max - 1).'…';
    }
}
