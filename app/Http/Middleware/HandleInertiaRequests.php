<?php

namespace App\Http\Middleware;

use App\Models\MonitoringSetting;
use App\Models\TimeEntry;
use App\Models\UserMonitoringSetting;
use Carbon\Carbon;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;
use Inertia\Middleware;

class HandleInertiaRequests extends Middleware
{
    /**
     * The root template that is loaded on the first page visit.
     *
     * @var string
     */
    protected $rootView = 'app';

    /**
     * Determine the current asset version.
     */
    public function version(Request $request): ?string
    {
        return parent::version($request);
    }

    /**
     * An Inertia visit returns application/json. If a browser or a proxy caches
     * that response and later serves it to a NORMAL page navigation to the same
     * URL, the user sees RAW JSON instead of the app — the "from time to time it
     * shows the JSON screen" bug. Inertia already sets `Vary: X-Inertia`, but
     * some shared caches and back/forward navigations ignore it, so we mark the
     * Inertia JSON responses no-store outright (they're authenticated and must
     * never be cached anyway).
     */
    public function handle(Request $request, Closure $next)
    {
        $response = parent::handle($request, $next);

        if ($request->headers->has('X-Inertia') && isset($response->headers)) {
            $response->headers->set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
            $response->headers->set('Pragma', 'no-cache');
        }

        return $response;
    }

    /**
     * Define the props that are shared by default.
     *
     * @return array<string, mixed>
     */
    public function share(Request $request): array
    {
        $user = $request->user();
        $lastActionToday = null;
        $authUser = null;

        if ($user) {
            $authUser = [
                'id' => $user->id,
                'name' => $user->name,
                'email' => $user->email,
                'role' => $user->role,
                'role_label' => $user->role_label,
                'avatar' => $user->avatar,
                'avatar_url' => $user->avatar_url,
                'designation' => $user->designation,
                'permissions' => $user->effectivePermissions(),
                'is_super_admin' => $user->isSuperAdmin(),
                'is_owner' => $user->isOwner(),
            ];

            try {
                // The current clock state follows the GLOBAL most-recent action,
                // not just today's: an open clock-in carried past midnight (e.g.
                // someone who clocked in last night and never clocked out) must
                // read as "still clocked in" with Clock Out available — not
                // "Not Started" — until they (or auto-close) close it.
                $last = TimeEntry::query()
                    ->where('user_id', $user->id)
                    ->orderByDesc('action_timestamp')->orderByDesc('id')
                    ->first();
                if ($last && in_array($last->action_type, ['clock_in', 'break_start', 'break_end'], true)) {
                    $lastActionToday = $last->action_type;
                } else {
                    // Closed or never started: scope to today so yesterday's
                    // clock-out doesn't bleed into a fresh day's "Not Started".
                    $today = $user->attendanceDateFor(Carbon::now('Asia/Karachi'));
                    $lastActionToday = TimeEntry::query()
                        ->where('user_id', $user->id)
                        ->whereDate('action_date', $today)
                        ->orderByDesc('action_timestamp')->orderByDesc('id')
                        ->value('action_type');
                }
            } catch (\Throwable $e) {
                Log::warning('Inertia share: clock-state lookup failed', ['user_id' => $user->id, 'exception' => $e->getMessage()]);
                $lastActionToday = null;
            }
        }

        // Only fetch team settings for authenticated pages; guests don't render
        // anything that needs them, so this skips a DB hit on /login and other
        // public routes. Cached for 60s so repeated authenticated requests
        // don't re-query the monitoring_settings table.
        $teamSettings = null;
        $display = ['timezone' => 'Asia/Karachi', 'format' => '12'];
        if ($user) {
            try {
                $teamSettings = Cache::remember('monitoring_settings.shared', 60, function () {
                    $row = MonitoringSetting::current();

                    return [
                        'allow_offline_time' => (bool) $row->allow_offline_time,
                        'currency_symbol' => $row->currency_symbol,
                        'week_starts_on' => $row->week_starts_on,
                        'display_timezone' => $row->display_timezone ?: 'Asia/Karachi',
                        'time_format' => $row->time_format ?: '12',
                    ];
                });

                // Team default, then apply this user's display override if any.
                $display = [
                    'timezone' => $teamSettings['display_timezone'] ?? 'Asia/Karachi',
                    'format' => $teamSettings['time_format'] ?? '12',
                ];
                $override = UserMonitoringSetting::where('user_id', $user->id)
                    ->where('override_display', true)
                    ->first(['display_timezone', 'time_format']);
                if ($override) {
                    if ($override->display_timezone) {
                        $display['timezone'] = $override->display_timezone;
                    }
                    if ($override->time_format) {
                        $display['format'] = $override->time_format;
                    }
                }
            } catch (\Throwable $e) {
                Log::warning('Inertia share: team/display settings lookup failed', ['user_id' => $user->id, 'exception' => $e->getMessage()]);
                $teamSettings = null;
            }
        }

        $canCreateManualWorkHour = false;
        if ($user) {
            $canCreateManualWorkHour = ! $user->isOwner() && ($user->isSuperAdmin()
                || $user->hasPermission('work_hours.manage_all')
                || ($teamSettings['allow_offline_time'] ?? false));
        }

        if ($authUser) {
            $authUser['can_create_manual_work_hour'] = $canCreateManualWorkHour;
        }

        // Shared with guests too — the login/welcome pages render the logo.
        // The ?v= cache-buster changes with the stored path so a freshly
        // uploaded logo replaces the browser-cached one immediately.
        $branding = ['logo_url' => null];
        try {
            $branding = Cache::remember('branding.shared', 300, function () {
                $path = MonitoringSetting::current()->branding_logo_path;

                return [
                    'logo_url' => $path ? route('branding.logo').'?v='.substr(md5($path), 0, 8) : null,
                ];
            });
        } catch (\Throwable $e) {
            // Keep rendering with the bundled logo if the table is missing.
            Log::warning('Inertia share: branding lookup failed', ['exception' => $e->getMessage()]);
        }

        // Feedback inbox: a small badge for managers (open requests awaiting
        // triage) and a flag the nav uses to show the inbox link. One cheap
        // COUNT, only for people who can actually manage the inbox.
        $feedback = ['can_manage' => false, 'open_count' => 0, 'unseen_count' => 0];
        if ($user) {
            $feedback['can_manage'] = $user->isSuperAdmin() || $user->hasPermission('feedback.manage');
            try {
                if ($feedback['can_manage']) {
                    $feedback['open_count'] = \App\Models\FeedbackItem::open()->count();
                }
                // Submitter badge: this person's own requests with a reply they
                // haven't seen yet (cleared when they open the inbox).
                $feedback['unseen_count'] = \App\Models\FeedbackItem::unseenFor($user->id)->count();
            } catch (\Throwable $e) {
                Log::warning('Inertia share: feedback counts failed', ['user_id' => $user->id, 'exception' => $e->getMessage()]);
            }
        }

        return [
            ...parent::share($request),
            'auth' => [
                'user' => $authUser,
                'lastActionToday' => $lastActionToday,
            ],
            'teamSettings' => $teamSettings,
            'display' => $display,
            'branding' => $branding,
            'feedback' => $feedback,
            'flash' => [
                'success' => $request->session()->get('success'),
                'error' => $request->session()->get('error'),
            ],
        ];
    }
}
