<?php

namespace App\Http\Controllers;

use App\Services\ActivityDigestService;
use Carbon\Carbon;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Internal system panel for Super Admins. Shows environment/health state and
 * exposes a fixed whitelist of safe maintenance actions. Never accepts
 * arbitrary commands and never reveals secrets.
 */
class DeveloperController extends Controller
{
    private const ACTIONS = [
        'optimize',
        'optimize_clear',
        'slack_test',
        's3_test',
        'digest_preview',
        'prune_dry_run',
        'migrate',
    ];

    public function index(Request $request): Response
    {
        $this->authorizeDeveloper($request);

        return Inertia::render('Developer/Index', [
            'system' => $this->systemInfo(),
            'health' => $this->healthChecks(),
            'schedule' => $this->scheduleInfo(),
            'envGroups' => $this->envSettings(),
            'lastOutput' => session('dev_output'),
            'lastAction' => session('dev_action'),
        ]);
    }

    /**
     * Schema of the .env keys editable from the Developer page. Only these keys
     * can ever be written. Secret fields are never sent back to the browser.
     *
     * @return array<string, array<string, mixed>>
     */
    private function envSchema(): array
    {
        return [
            'slack' => [
                'label' => 'Slack reports',
                'fields' => [
                    ['key' => 'SLACK_REPORT_WEBHOOK_URL', 'label' => 'Incoming webhook URL', 'type' => 'secret'],
                    ['key' => 'SLACK_REPORT_TIMEZONE', 'label' => 'Timezone', 'type' => 'text', 'placeholder' => 'Asia/Karachi'],
                    ['key' => 'SLACK_WEEKLY_REPORT_ENABLED', 'label' => 'Weekly work-hours report', 'type' => 'bool'],
                ],
            ],
            'slack_bot' => [
                'label' => 'Slack bot (channel posts + DMs)',
                'fields' => [
                    ['key' => 'SLACK_BOT_TOKEN', 'label' => 'Bot User OAuth token (xoxb-...)', 'type' => 'secret'],
                    ['key' => 'SLACK_COMPLIANCE_CHANNEL', 'label' => 'Machine-compliance alerts channel', 'type' => 'text', 'placeholder' => '#extension-application'],
                    ['key' => 'SLACK_TRACKER_HEALTH_CHANNEL', 'label' => 'Tracker-health alerts channel', 'type' => 'text', 'placeholder' => '#tracker-health'],
                    ['key' => 'SLACK_RESETS_CHANNEL', 'label' => 'Password-reset codes channel', 'type' => 'text', 'placeholder' => '#password-resets'],
                    ['key' => 'SLACK_DIGEST_CHANNEL', 'label' => 'Digest channel (future use)', 'type' => 'text', 'placeholder' => '#daily-reports'],
                ],
            ],
            'ai' => [
                'label' => 'AI (Claude API — summaries & digests)',
                'fields' => [
                    ['key' => 'ANTHROPIC_API_KEY', 'label' => 'Anthropic API key (sk-ant-...)', 'type' => 'secret'],
                ],
            ],
            's3' => [
                'label' => 'Screenshot storage (S3)',
                'fields' => [
                    ['key' => 'SCREENSHOTS_DRIVER', 'label' => 'Driver', 'type' => 'select', 'options' => ['local', 's3']],
                    ['key' => 'AWS_ACCESS_KEY_ID', 'label' => 'Access key ID', 'type' => 'secret'],
                    ['key' => 'AWS_SECRET_ACCESS_KEY', 'label' => 'Secret access key', 'type' => 'secret'],
                    ['key' => 'AWS_DEFAULT_REGION', 'label' => 'Region', 'type' => 'text', 'placeholder' => 'eu-north-1'],
                    ['key' => 'SCREENSHOTS_BUCKET', 'label' => 'Bucket name', 'type' => 'text', 'placeholder' => 'company-screenshots'],
                ],
            ],
        ];
    }

    public function updateEnv(Request $request): RedirectResponse
    {
        $this->authorizeDeveloper($request);

        $schema = $this->envSchema();
        $managed = [];
        $secretKeys = [];
        foreach ($schema as $group) {
            foreach ($group['fields'] as $field) {
                $managed[$field['key']] = $field;
                if ($field['type'] === 'secret') {
                    $secretKeys[] = $field['key'];
                }
            }
        }

        $input = (array) $request->input('values', []);
        $updates = [];

        foreach ($managed as $key => $field) {
            if (! array_key_exists($key, $input)) {
                continue;
            }
            $value = $input[$key];

            // Blank secret means "keep the current value" — never overwrite a
            // set secret with an empty string.
            if (in_array($key, $secretKeys, true) && ($value === null || $value === '')) {
                continue;
            }

            if ($field['type'] === 'bool') {
                $value = filter_var($value, FILTER_VALIDATE_BOOLEAN) ? 'true' : 'false';
            } elseif ($field['type'] === 'select' && ! in_array($value, $field['options'], true)) {
                return back()->with('error', "Invalid value for {$key}.");
            }

            $updates[$key] = (string) $value;
        }

        // Light validation on the values most likely to break things.
        if (isset($updates['SLACK_REPORT_WEBHOOK_URL']) && $updates['SLACK_REPORT_WEBHOOK_URL'] !== ''
            && ! str_starts_with($updates['SLACK_REPORT_WEBHOOK_URL'], 'https://')) {
            return back()->with('error', 'Slack webhook must be an https:// URL.');
        }
        if (isset($updates['SLACK_BOT_TOKEN']) && $updates['SLACK_BOT_TOKEN'] !== ''
            && ! str_starts_with($updates['SLACK_BOT_TOKEN'], 'xoxb-')) {
            return back()->with('error', 'Slack bot token must start with xoxb-.');
        }
        if (isset($updates['ANTHROPIC_API_KEY']) && $updates['ANTHROPIC_API_KEY'] !== ''
            && ! str_starts_with($updates['ANTHROPIC_API_KEY'], 'sk-ant-')) {
            return back()->with('error', 'Anthropic API key must start with sk-ant-.');
        }

        if (empty($updates)) {
            return back()->with('success', 'No changes to save.');
        }

        try {
            $this->writeEnv($updates);
        } catch (\Throwable $e) {
            return back()->with('error', 'Could not write .env: '.$e->getMessage());
        }

        // Re-apply config caching state so the new values take effect. Never
        // during tests: baking the test environment's config into the real
        // bootstrap/cache/config.php poisons later runs (and mid-request
        // config swaps break the response).
        if (! app()->runningUnitTests()) {
            $wasCached = file_exists(base_path('bootstrap/cache/config.php'));
            Artisan::call('config:clear');
            if ($wasCached) {
                Artisan::call('config:cache');
            }
        }
        Cache::forget('monitoring_settings.shared');

        $changed = array_keys($updates);

        return back()
            ->with('success', 'Settings saved and configuration reloaded.')
            ->with('dev_action', 'env_update')
            ->with('dev_output', 'Updated keys: '.implode(', ', $changed));
    }

    /** @return array<int, array<string, mixed>> */
    private function envSettings(): array
    {
        $current = $this->readEnvFile();
        $out = [];

        foreach ($this->envSchema() as $groupKey => $group) {
            $fields = [];
            foreach ($group['fields'] as $field) {
                $value = $current[$field['key']] ?? '';
                $entry = [
                    'key' => $field['key'],
                    'label' => $field['label'],
                    'type' => $field['type'],
                ];
                if (isset($field['placeholder'])) {
                    $entry['placeholder'] = $field['placeholder'];
                }
                if (isset($field['options'])) {
                    $entry['options'] = $field['options'];
                }
                if ($field['type'] === 'secret') {
                    $entry['is_set'] = $value !== '';   // never expose the value
                } else {
                    $entry['value'] = $value;
                }
                $fields[] = $entry;
            }
            $out[] = ['key' => $groupKey, 'label' => $group['label'], 'fields' => $fields];
        }

        return $out;
    }

    /** @return array<string, string> */
    private function readEnvFile(): array
    {
        $path = base_path('.env');
        if (! is_readable($path)) {
            return [];
        }

        $pairs = [];
        foreach (file($path, FILE_IGNORE_NEW_LINES) ?: [] as $line) {
            $trim = ltrim($line);
            if ($trim === '' || str_starts_with($trim, '#') || ! str_contains($line, '=')) {
                continue;
            }
            [$key, $value] = explode('=', $line, 2);
            $key = trim($key);
            $value = trim($value);
            if (strlen($value) >= 2 && ($value[0] === '"' || $value[0] === "'") && $value[-1] === $value[0]) {
                $value = substr($value, 1, -1);
            }
            $pairs[$key] = $value;
        }

        return $pairs;
    }

    /**
     * Update or append the given keys in .env, preserving everything else.
     *
     * @param  array<string, string>  $updates
     */
    private function writeEnv(array $updates): void
    {
        $path = base_path('.env');
        $lines = file($path, FILE_IGNORE_NEW_LINES);
        if ($lines === false) {
            throw new \RuntimeException('.env is not readable.');
        }

        $seen = [];
        foreach ($lines as $i => $line) {
            $trim = ltrim($line);
            if ($trim === '' || str_starts_with($trim, '#') || ! str_contains($line, '=')) {
                continue;
            }
            $key = trim(explode('=', $line, 2)[0]);
            if (array_key_exists($key, $updates)) {
                $lines[$i] = $key.'='.$this->envQuote($updates[$key]);
                $seen[$key] = true;
            }
        }

        foreach ($updates as $key => $value) {
            if (empty($seen[$key])) {
                $lines[] = $key.'='.$this->envQuote($value);
            }
        }

        if (file_put_contents($path, implode("\n", $lines)."\n") === false) {
            throw new \RuntimeException('.env is not writable.');
        }
    }

    private function envQuote(string $value): string
    {
        if ($value === '' || preg_match('/[\s#"\'\\\\]/', $value)) {
            return '"'.str_replace(['\\', '"'], ['\\\\', '\\"'], $value).'"';
        }

        return $value;
    }

    public function run(Request $request): RedirectResponse
    {
        $this->authorizeDeveloper($request);

        $action = (string) $request->validate([
            'action' => ['required', 'string', 'in:'.implode(',', self::ACTIONS)],
        ])['action'];

        [$message, $output] = match ($action) {
            'optimize' => $this->runOptimize(),
            'optimize_clear' => $this->runOptimizeClear(),
            'slack_test' => $this->runSlackTest(),
            's3_test' => $this->runS3Test(),
            'digest_preview' => $this->runDigestPreview(),
            'prune_dry_run' => $this->runPruneDryRun(),
            'migrate' => $this->runMigrate(),
        };

        return back()
            ->with('success', $message)
            ->with('dev_action', $action)
            ->with('dev_output', $output);
    }

    public function logs(Request $request): JsonResponse
    {
        $this->authorizeDeveloper($request);

        return response()->json([
            'file' => $this->latestLogFile() ? basename($this->latestLogFile()) : null,
            'lines' => $this->tailLog(300),
        ]);
    }

    /**
     * Recent captured diagnostics across every category (server errors, desktop
     * telemetry, attendance mis-files, tracker-health) so problems are visible
     * here instead of only over SSH.
     */
    public function diagnostics(Request $request): JsonResponse
    {
        $this->authorizeDeveloper($request);

        return response()->json([
            'counts' => \App\Support\Diagnostics::counts(),
            'recent' => \App\Support\Diagnostics::recent(50),
        ]);
    }

    /** S3 storage usage + estimated cost for the admin Storage panel. */
    public function storage(Request $request): JsonResponse
    {
        $this->authorizeDeveloper($request);

        return response()->json(
            app(\App\Services\S3UsageService::class)->usage(
                withRealCost: $request->boolean('cost'),
                fresh: $request->boolean('fresh'),
            )
        );
    }

    private function authorizeDeveloper(Request $request): void
    {
        abort_unless($request->user()?->isSuperAdmin(), 403, 'Developer tools are restricted to Super Admins.');
    }

    /** @return array<string, mixed> */
    private function systemInfo(): array
    {
        $manifest = public_path('build/manifest.json');
        $rendererIndex = base_path('desktop/renderer/dist/index.html');

        return [
            'app_env' => config('app.env'),
            'app_debug' => (bool) config('app.debug'),
            'app_url' => config('app.url'),
            'app_timezone' => config('app.timezone'),
            'server_time' => now()->toDateTimeString(),
            'php_version' => PHP_VERSION,
            'laravel_version' => app()->version(),
            'db_connection' => config('database.default'),
            'db_database' => config('database.connections.'.config('database.default').'.database'),
            'cache_driver' => config('cache.default'),
            'session_driver' => config('session.driver'),
            'queue_driver' => config('queue.default'),
            'config_cached' => file_exists(base_path('bootstrap/cache/config.php')),
            'routes_cached' => file_exists(base_path('bootstrap/cache/routes-v7.php')),
            'web_build_at' => is_file($manifest) ? Carbon::createFromTimestamp(filemtime($manifest))->toDateTimeString() : null,
            'desktop_build_at' => is_file($rendererIndex) ? Carbon::createFromTimestamp(filemtime($rendererIndex))->toDateTimeString() : null,
            'git' => $this->gitInfo(),
        ];
    }

    /** @return array<string, mixed> */
    private function gitInfo(): array
    {
        try {
            $base = base_path();
            $commit = trim((string) @shell_exec('git -C "'.$base.'" log -1 --format=%h 2>NUL'));
            $branch = trim((string) @shell_exec('git -C "'.$base.'" rev-parse --abbrev-ref HEAD 2>NUL'));
            $dirty = trim((string) @shell_exec('git -C "'.$base.'" status --porcelain 2>NUL'));

            return [
                'commit' => $commit ?: null,
                'branch' => $branch ?: null,
                'dirty_files' => $dirty === '' ? 0 : count(explode("\n", $dirty)),
            ];
        } catch (\Throwable $e) {
            return ['commit' => null, 'branch' => null, 'dirty_files' => null];
        }
    }

    /** @return array<int, array<string, mixed>> */
    private function healthChecks(): array
    {
        $checks = [];

        // Database
        try {
            $start = microtime(true);
            DB::select('select 1');
            $checks[] = ['name' => 'Database', 'ok' => true, 'detail' => round((microtime(true) - $start) * 1000).' ms'];
        } catch (\Throwable $e) {
            $checks[] = ['name' => 'Database', 'ok' => false, 'detail' => $e->getMessage()];
        }

        // Cache round-trip
        try {
            Cache::put('dev.health', 'ok', 10);
            $ok = Cache::get('dev.health') === 'ok';
            $checks[] = ['name' => 'Cache', 'ok' => $ok, 'detail' => config('cache.default')];
        } catch (\Throwable $e) {
            $checks[] = ['name' => 'Cache', 'ok' => false, 'detail' => $e->getMessage()];
        }

        // Storage disks
        foreach (['public', 'screenshots'] as $disk) {
            try {
                $probe = 'dev-health-probe.txt';
                Storage::disk($disk)->put($probe, 'ok');
                $ok = Storage::disk($disk)->exists($probe);
                Storage::disk($disk)->delete($probe);
                $checks[] = ['name' => "Storage: {$disk}", 'ok' => $ok, 'detail' => $ok ? 'writable' : 'not writable'];
            } catch (\Throwable $e) {
                $checks[] = ['name' => "Storage: {$disk}", 'ok' => false, 'detail' => $e->getMessage()];
            }
        }

        // Slack webhook configured (never reveal the URL)
        $checks[] = [
            'name' => 'Slack webhook',
            'ok' => filled(config('services.slack_reports.webhook_url')),
            'detail' => filled(config('services.slack_reports.webhook_url')) ? 'configured' : 'not set',
        ];

        // Background queue: the oldest waiting job shows whether the worker runs
        try {
            $connection = (string) config('queue.default');
            if ($connection === 'database') {
                $pending = DB::table('jobs')->count();
                $oldest = DB::table('jobs')->min('created_at');
                $waited = $oldest ? max(0, now()->timestamp - (int) $oldest) : 0;
                $failed = DB::table('failed_jobs')->count();
                $checks[] = [
                    'name' => 'Background queue',
                    'ok' => $waited < 300 && $failed === 0,
                    'detail' => "{$pending} waiting, oldest {$waited}s, {$failed} failed",
                ];
            } else {
                $checks[] = ['name' => 'Background queue', 'ok' => false, 'detail' => "{$connection}: runs inside requests"];
            }
        } catch (\Throwable $e) {
            $checks[] = ['name' => 'Background queue', 'ok' => false, 'detail' => $e->getMessage()];
        }

        // Pending migrations
        try {
            $migrator = app('migrator');
            $files = $migrator->getMigrationFiles(database_path('migrations'));
            $ran = $migrator->repositoryExists() ? $migrator->getRepository()->getRan() : [];
            $pending = array_diff(array_keys($files), $ran);
            $checks[] = [
                'name' => 'Migrations',
                'ok' => count($pending) === 0,
                'detail' => count($pending) === 0 ? 'up to date' : count($pending).' pending',
            ];
        } catch (\Throwable $e) {
            $checks[] = ['name' => 'Migrations', 'ok' => false, 'detail' => $e->getMessage()];
        }

        return $checks;
    }

    /** @return array<int, array<string, mixed>> */
    private function scheduleInfo(): array
    {
        return [
            [
                'name' => 'Weekly Slack work-hours report',
                'enabled' => (bool) config('services.slack_reports.weekly_enabled'),
                'when' => 'Sundays 10:00 '.config('services.slack_reports.timezone', 'Asia/Karachi'),
            ],
            [
                'name' => 'Screenshot retention prune',
                'enabled' => true,
                'when' => 'Daily 02:30 '.config('services.slack_reports.timezone', 'Asia/Karachi'),
            ],
        ];
    }

    /** @return array{0: string, 1: string} */
    private function runOptimize(): array
    {
        // IMPORTANT: do NOT run `optimize` / `route:cache` here. This app has
        // closure-based routes (the welcome page and avatar streamer) that
        // cannot be route-cached — a cached route file 500s the whole site.
        // Cache only config + views + events, which are safe and give the
        // real boot-time win.
        // Never bake caches from inside the test environment — leftover
        // bootstrap/cache files poison later test runs.
        if (app()->runningUnitTests()) {
            return ['Cache building is skipped while running tests.', ''];
        }

        $out = [];
        foreach (['config:cache', 'view:cache', 'event:cache'] as $cmd) {
            Artisan::call($cmd);
            $out[] = trim(Artisan::output());
        }

        return [
            'Caches built (config, views, events). Route cache is intentionally skipped — this app uses closure routes that cannot be route-cached. Run "Clear caches" before php artisan test.',
            implode("\n", array_filter($out)),
        ];
    }

    /** @return array{0: string, 1: string} */
    private function runOptimizeClear(): array
    {
        Artisan::call('optimize:clear');

        return ['All caches cleared. Safe to run the test suite now.', trim(Artisan::output())];
    }

    /** @return array{0: string, 1: string} */
    private function runSlackTest(): array
    {
        $webhook = config('services.slack_reports.webhook_url');

        if (blank($webhook)) {
            return ['Slack webhook is not configured (SLACK_REPORT_WEBHOOK_URL).', 'No request sent.'];
        }

        try {
            $response = Http::asJson()->timeout(10)->post($webhook, [
                'text' => ':white_check_mark: Timetracker developer test — webhook is working. ('.now()->toDateTimeString().')',
            ]);

            return $response->successful()
                ? ['Slack accepted the test message. Check the channel.', 'HTTP '.$response->status()]
                : ['Slack rejected the request — the webhook is probably revoked/rotated.', 'HTTP '.$response->status().' '.$response->body()];
        } catch (\Throwable $e) {
            return ['Could not reach Slack.', $e->getMessage()];
        }
    }

    /** @return array{0: string, 1: string} */
    private function runS3Test(): array
    {
        $driver = config('filesystems.disks.screenshots.driver');

        try {
            $disk = Storage::disk('screenshots');
            $probe = '_dev_s3_test_'.uniqid().'.txt';
            $disk->put($probe, 'ok');
            $ok = $disk->exists($probe) && $disk->get($probe) === 'ok';

            $signed = 'n/a (local disk)';
            if ($driver === 's3') {
                try {
                    $url = $disk->temporaryUrl($probe, now()->addMinutes(2));
                    $signed = str_contains($url, 'X-Amz-Signature') ? 'presigned URL OK' : 'presigned URL generated';
                } catch (\Throwable $e) {
                    $signed = 'presigned URL failed: '.$e->getMessage();
                }
            }

            $disk->delete($probe);

            return $ok
                ? ["Screenshot storage OK (driver: {$driver}).", "put + read + delete OK; {$signed}"]
                : ['Screenshot storage read/write mismatch.', "driver: {$driver}"];
        } catch (\Throwable $e) {
            return ["Screenshot storage test failed (driver: {$driver}).", $e->getMessage()];
        }
    }

    /** @return array{0: string, 1: string} */
    private function runDigestPreview(): array
    {
        $tz = config('services.slack_reports.timezone', 'Asia/Karachi');
        $start = Carbon::now($tz)->subDay()->startOfDay();
        $end = $start->copy()->endOfDay();

        $service = app(ActivityDigestService::class);
        $payload = $service->buildPayload($start, $end);
        $message = $service->formatSlack($payload);

        return ['Digest preview built for '.$payload['range']['label'].' (nothing was sent to Slack).', $message['text']];
    }

    /** @return array{0: string, 1: string} */
    private function runPruneDryRun(): array
    {
        Artisan::call('monitoring:prune-screenshots', ['--dry-run' => true]);

        return ['Retention dry-run complete (nothing deleted).', trim(Artisan::output())];
    }

    /** @return array{0: string, 1: string} */
    private function runMigrate(): array
    {
        if (! app()->environment('local')) {
            return ['Migrate from the browser is only allowed in the local environment.', 'Blocked: APP_ENV='.config('app.env')];
        }

        Artisan::call('migrate', ['--force' => true]);

        return ['Migrations run against the local database.', trim(Artisan::output())];
    }

    private function latestLogFile(): ?string
    {
        $files = glob(storage_path('logs/*.log')) ?: [];
        if (empty($files)) {
            return null;
        }

        usort($files, fn ($a, $b) => filemtime($b) <=> filemtime($a));

        return $files[0];
    }

    /** @return array<int, string> */
    private function tailLog(int $lines): array
    {
        $file = $this->latestLogFile();
        if (! $file || ! is_readable($file)) {
            return [];
        }

        // Read the last ~128KB and split into lines; plenty for a tail view.
        $size = filesize($file);
        $chunk = min($size, 131072);
        $handle = fopen($file, 'rb');
        if (! $handle) {
            return [];
        }
        fseek($handle, -$chunk, SEEK_END);
        $content = (string) stream_get_contents($handle);
        fclose($handle);

        $all = preg_split("/\r?\n/", trim($content)) ?: [];

        return array_slice($all, -$lines);
    }
}
