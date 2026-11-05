<?php

namespace App\Support;

use Illuminate\Support\Facades\Schema;

/**
 * Where a clock event came from, worked out once when it is recorded. The
 * browser reports its own device, so this is reliable for normal use but not
 * proof: a phone in "desktop site" mode, or an iPad, reads as Website.
 */
class ClockSource
{
    public const LABELS = [
        'web' => 'Website',
        'mobile' => 'Phone',
        'tablet' => 'Tablet',
        'desktop_app' => 'Desktop app',
        'admin' => 'Admin',
        'system' => 'Automatic',
    ];

    private static ?bool $available = null;

    /** Hostinger deploys code before migrations run, so writes must tolerate the gap. */
    public static function available(): bool
    {
        return self::$available ??= Schema::hasColumn('time_entries', 'clock_source');
    }

    public static function detect(?string $notes = null): string
    {
        $request = request();

        if ($request->is('api/desktop/*')) {
            return 'desktop_app';
        }
        if (str_starts_with((string) $notes, 'Admin')) {
            return 'admin';
        }
        if (str_starts_with((string) $notes, 'Auto')) {
            return 'system';
        }

        return self::fromUserAgent($request->userAgent());
    }

    public static function fromUserAgent(?string $agent): string
    {
        // Artisan commands run with no browser behind them.
        if ($agent === null || $agent === '' || $agent === 'Symfony') {
            return 'system';
        }
        if (preg_match('/Electron/i', $agent)) {
            return 'desktop_app';
        }
        if (preg_match('/iPad|Tablet|Silk|PlayBook|Android(?!.*Mobile)/i', $agent)) {
            return 'tablet';
        }
        if (preg_match('/Mobi|iPhone|iPod|Android|BlackBerry|Opera Mini|IEMobile/i', $agent)) {
            return 'mobile';
        }

        return 'web';
    }

    public static function label(?string $source): ?string
    {
        return self::LABELS[$source] ?? null;
    }
}
