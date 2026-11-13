<?php

namespace App\Services;

use App\Models\User;
use App\Models\WorkHour;
use App\Services\Concerns\FormatsSlackBlocks;
use Carbon\CarbonInterface;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Http;
use RuntimeException;
use Throwable;

class SlackReportService
{
    use FormatsSlackBlocks;

    private const MAX_TABLE_DATA_ROWS = 98;

    public function configured(): bool
    {
        return filled(config('services.slack_reports.webhook_url'));
    }

    public function sendRange(CarbonInterface $start, CarbonInterface $end, array $filters = []): array
    {
        if (! $this->configured()) {
            throw new RuntimeException('Slack reporting is not configured.');
        }

        $startDate = $start->toDateString();
        $endDate = $end->toDateString();
        $query = WorkHour::query()->whereBetween('date', [$startDate, $endDate]);

        if (empty($filters['userIds'])) {
            $query->whereHas('user', fn ($userQuery) => $userQuery->where('include_in_slack_reports', true));
        }

        $this->applyFilters($query, $filters);

        $entries = $query
            ->with(['client:id,name'])
            ->orderBy('user_id')
            ->orderBy('date')
            ->get(['id', 'user_id', 'client_id', 'work_type', 'tracker', 'hours']);

        $users = User::query()
            ->staff()
            ->when(
                ! empty($filters['userIds']),
                fn ($userQuery) => $userQuery->whereIn('id', $filters['userIds']),
                fn ($userQuery) => $userQuery
                    ->where('include_in_slack_reports', true)
                    ->whereIn('id', $entries->pluck('user_id')->unique())
            )
            ->orderBy('name')
            ->get(['id', 'name']);

        $includeFields = array_values(array_intersect(
            $filters['includeFields'] ?? ['hours'],
            ['client', 'work_type', 'tracker', 'hours', 'user_total']
        ));

        if ($includeFields === []) {
            $includeFields = ['hours'];
        }

        $columns = array_merge(['user'], $includeFields);
        $reportRows = $this->buildReportRows($users, $entries, $includeFields);
        $visibleRows = $reportRows->take(self::MAX_TABLE_DATA_ROWS);
        $omittedRows = max(0, $reportRows->count() - $visibleRows->count());
        $teamTotal = (float) $entries->sum('hours');
        $period = $start->format('M j, Y').' - '.$end->format('M j, Y');
        $tableRows = collect([
            collect($columns)
                ->map(fn (string $column) => $this->tableBoldCell($this->fieldLabel($column)))
                ->all(),
        ]);

        $visibleRows->each(function (array $row) use ($tableRows, $columns) {
            $tableRows->push(
                collect($columns)
                    ->map(fn (string $column) => $this->tableTextCell($row[$column] ?? '-'))
                    ->all()
            );
        });

        if (in_array('hours', $includeFields, true)) {
            $tableRows->push(
                collect($columns)
                    ->map(function (string $column) use ($teamTotal) {
                        if ($column === 'user') {
                            return $this->tableBoldCell('Total');
                        }

                        if ($column === 'hours') {
                            return $this->tableBoldCell($this->formatHours($teamTotal));
                        }

                        return $this->tableTextCell('-');
                    })
                    ->all()
            );
        }

        $contextParts = [
            sprintf('*Users:* %d', $users->count()),
            sprintf('*Entries:* %d', $entries->count()),
        ];

        if ($omittedRows > 0) {
            $contextParts[] = sprintf('*%d additional table rows omitted*', $omittedRows);
        }

        $blocks = [
            [
                'type' => 'header',
                'text' => [
                    'type' => 'plain_text',
                    'text' => 'Work Hours Report',
                ],
            ],
            [
                'type' => 'section',
                'text' => [
                    'type' => 'mrkdwn',
                    'text' => "*Period:* {$period}",
                ],
            ],
            [
                'type' => 'table',
                'column_settings' => collect($columns)
                    ->map(fn (string $column) => [
                        'align' => in_array($column, ['hours', 'user_total'], true) ? 'right' : 'left',
                        'is_wrapped' => ! in_array($column, ['hours', 'user_total'], true),
                    ])
                    ->all(),
                'rows' => $tableRows->all(),
            ],
            [
                'type' => 'context',
                'elements' => [[
                    'type' => 'mrkdwn',
                    'text' => implode(' | ', $contextParts),
                ]],
            ],
        ];

        $fallbackText = sprintf(
            'Work Hours Report | %s | %d users | %d entries%s',
            $period,
            $users->count(),
            $entries->count(),
            in_array('hours', $includeFields, true)
                ? ' | Total hours: '.$this->formatHours($teamTotal)
                : ''
        );

        try {
            $response = Http::asJson()
                ->timeout(10)
                ->retry(2, 250)
                ->post(config('services.slack_reports.webhook_url'), [
                    'text' => $fallbackText,
                    'blocks' => $blocks,
                ]);
        } catch (Throwable) {
            throw new RuntimeException('The app could not connect to Slack.');
        }

        if ($response->failed()) {
            throw new RuntimeException('Slack did not accept the report.');
        }

        return [
            'start_date' => $startDate,
            'end_date' => $endDate,
            'user_count' => $users->count(),
            'total_hours' => round($teamTotal, 2),
        ];
    }

    private function applyFilters($query, array $filters): void
    {
        if (! empty($filters['userIds'])) {
            $query->whereIn('user_id', $filters['userIds']);
        }

        if (! empty($filters['workTypes'])) {
            $query->whereIn('work_type', $filters['workTypes']);
        }

        if (! empty($filters['trackers'])) {
            $query->whereIn('tracker', $filters['trackers']);
        }

        if (! empty($filters['clients'])) {
            $query->whereHas('client', fn ($clientQuery) => $clientQuery->whereIn('name', $filters['clients']));
        }

        if (! empty($filters['designations'])) {
            $query->whereHas('user', fn ($userQuery) => $userQuery->whereIn('designation', $filters['designations']));
        }
    }

    private function buildReportRows(Collection $users, Collection $entries, array $includeFields): Collection
    {
        $groupFields = array_values(array_diff($includeFields, ['hours', 'user_total']));

        return $users->flatMap(function (User $user) use ($entries, $groupFields, $includeFields) {
            $userEntries = $entries->where('user_id', $user->id)->values();
            $userTotal = $this->formatHours((float) $userEntries->sum('hours'));

            if ($userEntries->isEmpty()) {
                return [[
                    'user' => $user->name,
                    ...collect($includeFields)
                        ->mapWithKeys(fn (string $field) => [
                            $field => in_array($field, ['hours', 'user_total'], true) ? '0' : '-',
                        ])
                        ->all(),
                ]];
            }

            if ($groupFields === []) {
                $row = [
                    'user' => $user->name,
                ];

                if (in_array('hours', $includeFields, true)) {
                    $row['hours'] = $userTotal;
                }

                if (in_array('user_total', $includeFields, true)) {
                    $row['user_total'] = $userTotal;
                }

                return [$row];
            }

            return $userEntries
                ->groupBy(fn (WorkHour $entry) => json_encode(
                    collect($groupFields)->mapWithKeys(
                        fn (string $field) => [$field => $this->fieldValue($entry, $field)]
                    )->all()
                ))
                ->sortKeys()
                ->map(function (Collection $group) use ($user, $groupFields, $includeFields, $userTotal) {
                    $entry = $group->first();
                    $row = ['user' => $user->name];

                    foreach ($groupFields as $field) {
                        $row[$field] = $this->fieldValue($entry, $field);
                    }

                    if (in_array('hours', $includeFields, true)) {
                        $row['hours'] = $this->formatHours((float) $group->sum('hours'));
                    }

                    if (in_array('user_total', $includeFields, true)) {
                        $row['user_total'] = $userTotal;
                    }

                    return $row;
                })
                ->values();
        })->values();
    }

    private function fieldValue(WorkHour $entry, string $field): string
    {
        return match ($field) {
            'client' => $entry->client?->name ?? 'No client',
            'work_type' => $this->formatWorkType($entry->work_type),
            'tracker' => filled($entry->tracker) ? $entry->tracker : 'Not specified',
            default => '',
        };
    }

    private function fieldLabel(string $field): string
    {
        return match ($field) {
            'user' => 'User',
            'client' => 'Client',
            'work_type' => 'Work Type',
            'tracker' => 'Tracker',
            'hours' => 'Hours',
            'user_total' => 'User Total',
            default => ucfirst($field),
        };
    }

    private function formatWorkType(?string $workType): string
    {
        return match ($workType) {
            'tracker' => 'Tracker',
            'manual' => 'Manual Time',
            'test_task' => 'Test Task',
            'upwork_bidding' => 'Upwork Bidding',
            'fixed' => 'Fixed Project',
            'office_work' => 'Office Work',
            'outside_of_upwork' => 'Outside of Upwork',
            null, '' => 'Not specified',
            default => ucwords(str_replace('_', ' ', $workType)),
        };
    }
}
