<?php

namespace App\Http\Controllers;

use App\Models\MonitoringSetting;
use App\Models\User;
use App\Models\UserMonitoringSetting;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Validation\Rule;
use Inertia\Inertia;
use Inertia\Response;

class SettingsController extends Controller
{
    private const CATEGORIES = [
        'screenshots',
        'activity',
        'app_url',
        'weekly_limit',
        'auto_pause',
        'offline_time',
        'notify_screenshot',
        'week_starts_on',
        'currency',
        'desktop_app',
        'display',
    ];

    public function index(): Response
    {
        $team = MonitoringSetting::current();

        // Everyone is listed and editable, including Super Admins — they are
        // tracked too and the desktop honours their per-user overrides
        // (effectiveForUser), so the owner can configure individual settings for
        // anyone on the roster.
        $users = User::staff()->orderBy('name')
            ->get(['id', 'name', 'email', 'role']);

        $overrides = UserMonitoringSetting::whereIn('user_id', $users->pluck('id'))
            ->get()
            ->keyBy('user_id');

        $perUser = $users->map(fn (User $u) => [
            'id' => $u->id,
            'name' => $u->name,
            'email' => $u->email,
            'role' => $u->role,
            'overrides' => $this->serializeOverride($overrides->get($u->id)),
        ]);

        return Inertia::render('Settings/Index', [
            'team' => $team->teamPayload(),
            'users' => $perUser,
        ]);
    }

    public function updateTeam(Request $request): RedirectResponse|JsonResponse
    {
        $data = $request->validate([
            'screenshots_per_hour' => ['required', 'integer', 'min:0', 'max:60'],
            'blur_screenshots' => ['required', 'boolean'],
            'capture_enabled' => ['required', 'boolean'],
            'activity_tracking_enabled' => ['required', 'boolean'],
            'app_url_tracking_enabled' => ['required', 'boolean'],
            'weekly_time_limit_hours' => ['nullable', 'integer', 'min:0', 'max:168'],
            'auto_pause_minutes' => ['required', 'integer', 'min:0', 'max:120'],
            'allow_offline_time' => ['required', 'boolean'],
            'notify_on_screenshot' => ['required', 'boolean'],
            'week_starts_on' => ['required', Rule::in(['monday', 'sunday'])],
            'currency_symbol' => ['required', 'string', 'max:8'],
            'desktop_auto_start' => ['required', 'boolean'],
            'desktop_force_quit_on_idle' => ['required', 'boolean'],
            'display_timezone' => ['required', 'timezone'],
            'time_format' => ['required', Rule::in(['12', '24'])],
            'slack_clockin_enabled' => ['required', 'boolean'],
            'slack_clockout_enabled' => ['required', 'boolean'],
            'slack_attendance_channel' => ['nullable', 'string', 'max:100'],
            // 'present' not 'required': an empty array (= show every warning)
            // must pass validation; 'required' rejects [].
            'attention_hidden_types' => ['present', 'array'],
            'attention_hidden_types.*' => ['string', Rule::in(MonitoringSetting::ATTENTION_TYPES)],
        ]);

        $team = MonitoringSetting::current();

        // Keep the desktop's min/max seconds in sync with screenshots_per_hour
        // so the existing tracker code keeps working unchanged.
        $perHour = (int) $data['screenshots_per_hour'];
        if ($perHour > 0) {
            $avg = (int) round(3600 / $perHour);
            $data['screenshot_interval_min_seconds'] = max(30, (int) round($avg * 0.5));
            $data['screenshot_interval_max_seconds'] = max(60, (int) round($avg * 1.5));
            $data['capture_enabled'] = $data['capture_enabled'] && true;
        } else {
            $data['capture_enabled'] = false;
        }

        $team->update($data);
        Cache::forget('monitoring_settings.shared');

        // Toggles save in the background (axios) — a tiny JSON ack keeps the
        // page from re-rendering all settings props on every flip.
        if ($request->wantsJson()) {
            return response()->json(['ok' => true]);
        }

        return back()->with('success', 'Team settings updated.');
    }

    public function updateUser(Request $request, User $user): RedirectResponse|JsonResponse
    {
        $data = $request->validate([
            'category' => ['required', Rule::in(self::CATEGORIES)],
            'enabled' => ['required', 'boolean'],
            'values' => ['nullable', 'array'],
            'values.screenshots_per_hour' => ['nullable', 'integer', 'min:0', 'max:60'],
            'values.blur_screenshots' => ['nullable', 'boolean'],
            'values.capture_enabled' => ['nullable', 'boolean'],
            'values.activity_tracking_enabled' => ['nullable', 'boolean'],
            'values.app_url_tracking_enabled' => ['nullable', 'boolean'],
            'values.weekly_time_limit_hours' => ['nullable', 'integer', 'min:0', 'max:168'],
            'values.auto_pause_minutes' => ['nullable', 'integer', 'min:0', 'max:120'],
            'values.allow_offline_time' => ['nullable', 'boolean'],
            'values.notify_on_screenshot' => ['nullable', 'boolean'],
            'values.desktop_auto_start' => ['nullable', 'boolean'],
            'values.desktop_force_quit_on_idle' => ['nullable', 'boolean'],
            'values.display_timezone' => ['nullable', 'timezone'],
            'values.time_format' => ['nullable', Rule::in(['12', '24'])],
        ]);

        $override = UserMonitoringSetting::firstOrNew(['user_id' => $user->id]);

        $flagField = $this->flagFieldFor($data['category']);
        $valueFields = $this->valueFieldsFor($data['category']);

        $override->{$flagField} = (bool) $data['enabled'];

        if ($data['enabled']) {
            $team = MonitoringSetting::current()->teamPayload();
            foreach ($valueFields as $field) {
                $incoming = $data['values'][$field] ?? null;
                $override->{$field} = $incoming ?? $team[$field] ?? null;
            }
        } else {
            foreach ($valueFields as $field) {
                $override->{$field} = null;
            }
        }

        $override->user_id = $user->id;
        $override->save();

        if ($request->wantsJson()) {
            return response()->json(['ok' => true]);
        }

        return back()->with('success', 'Individual setting updated.');
    }

    private function flagFieldFor(string $category): string
    {
        return [
            'screenshots' => 'override_screenshots',
            'activity' => 'override_activity',
            'app_url' => 'override_app_url',
            'weekly_limit' => 'override_weekly_limit',
            'auto_pause' => 'override_auto_pause',
            'offline_time' => 'override_offline_time',
            'notify_screenshot' => 'override_notify_screenshot',
            'desktop_app' => 'override_desktop_app',
            'display' => 'override_display',
            'week_starts_on' => 'override_screenshots', // no per-user override
            'currency' => 'override_screenshots',        // no per-user override
        ][$category];
    }

    /** @return string[] */
    private function valueFieldsFor(string $category): array
    {
        return [
            'screenshots' => ['screenshots_per_hour', 'blur_screenshots', 'capture_enabled'],
            'activity' => ['activity_tracking_enabled'],
            'app_url' => ['app_url_tracking_enabled'],
            'weekly_limit' => ['weekly_time_limit_hours'],
            'auto_pause' => ['auto_pause_minutes'],
            'offline_time' => ['allow_offline_time'],
            'notify_screenshot' => ['notify_on_screenshot'],
            'desktop_app' => ['desktop_auto_start', 'desktop_force_quit_on_idle'],
            'display' => ['display_timezone', 'time_format'],
            'week_starts_on' => [],
            'currency' => [],
        ][$category];
    }

    /** @return array<string, mixed> */
    private function serializeOverride(?UserMonitoringSetting $row): array
    {
        if (! $row) {
            return [
                'override_screenshots' => false,
                'override_activity' => false,
                'override_app_url' => false,
                'override_weekly_limit' => false,
                'override_auto_pause' => false,
                'override_offline_time' => false,
                'override_notify_screenshot' => false,
                'override_desktop_app' => false,
                'override_display' => false,
            ];
        }

        return [
            'override_screenshots' => (bool) $row->override_screenshots,
            'override_activity' => (bool) $row->override_activity,
            'override_app_url' => (bool) $row->override_app_url,
            'override_weekly_limit' => (bool) $row->override_weekly_limit,
            'override_auto_pause' => (bool) $row->override_auto_pause,
            'override_offline_time' => (bool) $row->override_offline_time,
            'override_notify_screenshot' => (bool) $row->override_notify_screenshot,
            'override_desktop_app' => (bool) $row->override_desktop_app,
            'override_display' => (bool) $row->override_display,
            'display_timezone' => $row->display_timezone,
            'time_format' => $row->time_format,
            'screenshots_per_hour' => $row->screenshots_per_hour,
            'blur_screenshots' => $row->blur_screenshots,
            'capture_enabled' => $row->capture_enabled,
            'activity_tracking_enabled' => $row->activity_tracking_enabled,
            'app_url_tracking_enabled' => $row->app_url_tracking_enabled,
            'weekly_time_limit_hours' => $row->weekly_time_limit_hours,
            'auto_pause_minutes' => $row->auto_pause_minutes,
            'allow_offline_time' => $row->allow_offline_time,
            'notify_on_screenshot' => $row->notify_on_screenshot,
            'desktop_auto_start' => $row->desktop_auto_start,
            'desktop_force_quit_on_idle' => $row->desktop_force_quit_on_idle,
        ];
    }
}
