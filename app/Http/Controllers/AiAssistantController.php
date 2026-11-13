<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Models\WorkHour;
use App\Services\AnthropicService;
use App\Support\BusinessTime;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Validation\Rule;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Manager chat over the team's recent work data. The model only ever sees
 * an aggregated 14-day data pack (no screenshots, no raw timestamps), and
 * access mirrors the Reports permission.
 */
class AiAssistantController extends Controller
{
    private const DEFAULT_QUESTIONS = [
        'Give me a report for the night team this week',
        'Who tracked the most hours in the last 7 days?',
        'Which clients took the most time this week?',
        'Anyone with unusually low hours recently?',
    ];

    public function index(Request $request): Response
    {
        return Inertia::render('AiAssistant', [
            'aiEnabled' => app(AnthropicService::class)->configured(),
            'questions' => $this->questions(),
            'canManageQuestions' => $this->canManageQuestions($request->user()),
        ]);
    }

    /** Widget bootstrap: enabled flag + suggested questions. */
    public function config(Request $request): JsonResponse
    {
        return response()->json([
            'enabled' => app(AnthropicService::class)->configured(),
            'questions' => $this->questions(),
            'canManageQuestions' => $this->canManageQuestions($request->user()),
        ]);
    }

    public function saveQuestions(Request $request): JsonResponse
    {
        abort_unless($this->canManageQuestions($request->user()), 403);

        $data = $request->validate([
            'questions' => ['present', 'array', 'max:12'],
            'questions.*' => ['string', 'max:200'],
        ]);

        $questions = collect($data['questions'])
            ->map(fn ($q) => trim($q))
            ->filter()
            ->unique()
            ->values()
            ->all();

        $settings = \App\Models\MonitoringSetting::current();
        $settings->update(['ai_suggested_questions' => $questions ?: null]);
        Cache::forget('monitoring_settings.shared');

        return response()->json(['questions' => $questions ?: self::DEFAULT_QUESTIONS]);
    }

    /** @return array<int, string> */
    private function questions(): array
    {
        $saved = \App\Models\MonitoringSetting::current()->ai_suggested_questions;

        return is_array($saved) && $saved !== [] ? array_values($saved) : self::DEFAULT_QUESTIONS;
    }

    private function canManageQuestions(?User $user): bool
    {
        return (bool) $user && ($user->isSuperAdmin() || $user->hasPermission('monitoring.settings'));
    }

    public function ask(Request $request): JsonResponse
    {
        $ai = app(AnthropicService::class);

        if (! $ai->configured()) {
            return response()->json(['message' => 'AI is not configured — add the Anthropic key on the Developer page.'], 422);
        }

        $data = $request->validate([
            'messages' => ['required', 'array', 'min:1', 'max:12'],
            'messages.*.role' => ['required', Rule::in(['user', 'assistant'])],
            'messages.*.content' => ['required', 'string', 'max:2000'],
        ]);

        $reply = $ai->chat($data['messages'], $this->systemPrompt(), 1200);

        if ($reply === null) {
            return response()->json(['message' => 'The assistant could not answer right now — try again in a minute.'], 503);
        }

        return response()->json(['reply' => $reply]);
    }

    private function systemPrompt(): string
    {
        $pack = Cache::remember('ai-assistant-datapack', now()->addMinutes(10), fn () => $this->dataPack());

        return "You are the SA Track analytics assistant for managers at Sparking Asia, a digital agency. "
            ."Answer questions about the team's tracked work using ONLY the data below (the last 14 days, "
            ."hours from the work diary). If asked about anything outside this window or data, say so plainly. "
            ."Times are written as decimal hours; present them as e.g. '7h 30m'. Dates are Y-m-d in Asia/Karachi. "
            ."Each person line reads: Name (designation, shift): total over the range | days: MM-DD=hours for every "
            ."day they worked (e.g. '06-12=8.2' is 8.2h on June 12 — use these to compute any sub-range like the "
            ."last 7 days) | top: their biggest clients/work types. "
            ."Plain text only — short paragraphs or simple dash lists, no markdown headers or tables. Be concise "
            ."and factual; never invent people, clients, or numbers.\n\n".$pack;
    }

    private function dataPack(): string
    {
        $end = BusinessTime::today();
        $start = $end->copy()->subDays(13);

        $users = User::staff()->orderBy('name')->get(['id', 'name', 'designation', 'shift_start_time']);

        $hours = WorkHour::with('client:id,name')
            ->whereBetween('date', [$start->toDateString(), $end->toDateString()])
            ->get(['id', 'user_id', 'client_id', 'date', 'hours', 'work_type']);

        $byUser = $hours->groupBy('user_id');

        $lines = ["RANGE: {$start->toDateString()} to {$end->toDateString()}"];

        foreach ($users as $user) {
            $rows = $byUser->get($user->id);
            if (! $rows || $rows->isEmpty()) {
                continue;
            }

            $total = round($rows->sum('hours'), 1);
            $days = $rows->groupBy(fn ($r) => substr((string) $r->date, 0, 10))
                ->map(fn ($g) => round($g->sum('hours'), 1))
                ->sortKeys()
                ->map(fn ($h, $d) => substr($d, 5).'='.$h)
                ->implode(' ');
            $clients = $rows->groupBy(fn ($r) => $r->client?->name ?: ucfirst(str_replace('_', ' ', $r->work_type)))
                ->map(fn ($g) => round($g->sum('hours'), 1))
                ->sortDesc()
                ->take(5)
                ->map(fn ($h, $c) => "{$c} {$h}h")
                ->implode(', ');

            $shift = $user->shift_start_time ? $user->shift_start_time->format('H:i') : 'no shift set';
            $lines[] = "{$user->name} ({$user->designation}, shift {$shift}): total {$total}h | days: {$days} | top: {$clients}";
        }

        $clientTotals = $hours->groupBy(fn ($r) => $r->client?->name ?: ucfirst(str_replace('_', ' ', $r->work_type)))
            ->map(fn ($g) => round($g->sum('hours'), 1))
            ->sortDesc()
            ->take(20)
            ->map(fn ($h, $c) => "{$c} {$h}h")
            ->implode(', ');
        $lines[] = "TEAM CLIENT TOTALS: {$clientTotals}";

        // Hard cap so an unexpectedly large team can never blow up the prompt.
        return substr(implode("\n", $lines), 0, 24000);
    }
}
