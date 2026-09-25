<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Third Party Services
    |--------------------------------------------------------------------------
    |
    | This file is for storing the credentials for third party services such
    | as Mailgun, Postmark, AWS and more. This file provides the de facto
    | location for this type of information, allowing packages to have
    | a conventional file to locate the various service credentials.
    |
    */

    'mailgun' => [
        'domain' => env('MAILGUN_DOMAIN'),
        'secret' => env('MAILGUN_SECRET'),
        'endpoint' => env('MAILGUN_ENDPOINT', 'api.mailgun.net'),
        'scheme' => 'https',
    ],

    'postmark' => [
        'token' => env('POSTMARK_TOKEN'),
    ],

    'ses' => [
        'key' => env('AWS_ACCESS_KEY_ID'),
        'secret' => env('AWS_SECRET_ACCESS_KEY'),
        'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),
    ],

    'slack_reports' => [
        'webhook_url' => env('SLACK_REPORT_WEBHOOK_URL'),
        'weekly_enabled' => (bool) env('SLACK_WEEKLY_REPORT_ENABLED', false),
        'daily_digest_enabled' => (bool) env('SLACK_DAILY_DIGEST_ENABLED', false),
        'daily_digest_time' => env('SLACK_DAILY_DIGEST_TIME', '09:00'),
        'timezone' => env('SLACK_REPORT_TIMEZONE', 'Asia/Karachi'),
    ],

    // Shared token for the HTTP scheduler trigger (SchedulerController). Leave
    // unset to disable the endpoint entirely.
    'scheduler' => [
        'token' => env('SCHEDULER_HTTP_TOKEN'),
    ],

    // Shared bearer token for the READ-ONLY payroll export (/api/payroll/*),
    // consumed by the Tankhwah payroll app. Leave unset to disable.
    'payroll' => [
        'token' => env('PAYROLL_API_TOKEN'),
    ],

    // Slack bot (chat.postMessage + DMs) — one token posts to any channel the
    // bot is in, unlike per-channel incoming webhooks.
    'slack_bot' => [
        'token' => env('SLACK_BOT_TOKEN'),
        'resets_channel' => env('SLACK_RESETS_CHANNEL'),
        'digest_channel' => env('SLACK_DIGEST_CHANNEL'),
        // Verifies interactive button clicks really came from Slack.
        'signing_secret' => env('SLACK_SIGNING_SECRET'),
    ],

    // Claude API for AI summaries/digests. Key is managed from the Developer
    // page; AI features stay dormant while it is unset.
    'anthropic' => [
        'api_key' => env('ANTHROPIC_API_KEY'),
        'model' => env('ANTHROPIC_MODEL', 'claude-opus-4-8'),
    ],

    // Forgotten-clock-out safety net. Off by default so the command can be
    // dry-run and reviewed before the scheduler starts closing live sessions.
    'attendance' => [
        'auto_clockout_enabled' => env('ATTENDANCE_AUTO_CLOCKOUT', false),
        // Forgotten clock-outs are closed at the person's shift end plus this
        // grace buffer (minutes), instead of running to a flat 12h cap.
        'auto_close_buffer_minutes' => (int) env('ATTENDANCE_AUTO_CLOSE_BUFFER_MINUTES', 20),
        // Absolute backstop: never let a single clock-in span beyond this many
        // hours, even for someone actively tracking overtime (prevents ghosts).
        'auto_close_hard_cap_hours' => (int) env('ATTENDANCE_AUTO_CLOSE_HARD_CAP_HOURS', 16),
        // Interactive Slack "still working?" check (DMs people past a threshold).
        'still_working_slack_enabled' => env('ATTENDANCE_STILL_WORKING_SLACK', false),
        'prompt_after_hours' => env('ATTENDANCE_PROMPT_AFTER_HOURS', 8),
        // Clock out after this many unanswered "still working?" nudges.
        'max_unanswered_prompts' => env('ATTENDANCE_MAX_PROMPTS', 4),
        // Channel where "X clocked in" posts go (e.g. "#attendance").
        'clockin_channel' => env('SLACK_CLOCKIN_CHANNEL'),
        // Channel where "X was auto clocked-out" posts go (falls back to the
        // clock-in channel when unset).
        'lockout_channel' => env('SLACK_LOCKOUT_CHANNEL'),
        // Capture-health watchdog: alert when a live tracker sends heartbeats
        // but no screenshots/samples (likely antivirus block).
        'tracker_health_slack_enabled' => env('TRACKER_HEALTH_SLACK', false),
        'tracker_health_channel' => env('SLACK_TRACKER_HEALTH_CHANNEL'),
        // Machine-compliance alerts (a flagged extension / program / VPN found on
        // a PC). Its own channel so it doesn't drown the attendance channels;
        // falls back to the tracker-health then clock-in channel when unset.
        'compliance_channel' => env('SLACK_COMPLIANCE_CHANNEL'),
    ],

];
