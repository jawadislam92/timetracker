<?php

use App\Http\Controllers\Api\Desktop\ActivityController as DesktopActivityController;
use App\Http\Controllers\Api\Desktop\AuthController as DesktopAuthController;
use App\Http\Controllers\Api\Desktop\DiagnosticsController as DesktopDiagnosticsController;
use App\Http\Controllers\Api\Desktop\MachineReportController as DesktopMachineReportController;
use App\Http\Controllers\Api\Desktop\MetaController as DesktopMetaController;
use App\Http\Controllers\Api\Desktop\ScreenshotController as DesktopScreenshotController;
use App\Http\Controllers\Api\Desktop\SessionController as DesktopSessionController;
use App\Http\Controllers\Api\Desktop\TimeClockController as DesktopTimeClockController;
use App\Http\Controllers\SlackInteractionController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| API Routes
|--------------------------------------------------------------------------
|
| Here is where you can register API routes for your application. These
| routes are loaded by the RouteServiceProvider and all of them will
| be assigned to the "api" middleware group. Make something great!
|
*/

Route::middleware('auth:sanctum')->get('/user', function (Request $request) {
    return $request->user();
});

/*
|--------------------------------------------------------------------------
| Payroll export (read-only, static bearer token: PAYROLL_API_TOKEN)
|--------------------------------------------------------------------------
| Consumed by the Tankhwah payroll app. Returns users and resolved attendance
| per day for a month. Disabled entirely (404) when the token is not set.
*/
Route::prefix('payroll')->middleware(['payroll.token', 'throttle:60,1'])->group(function () {
    Route::get('/ping', [\App\Http\Controllers\Api\Payroll\PayrollController::class, 'ping'])->name('payroll.ping');
    Route::get('/users', [\App\Http\Controllers\Api\Payroll\PayrollController::class, 'users'])->name('payroll.users');
    Route::get('/attendance', [\App\Http\Controllers\Api\Payroll\PayrollController::class, 'attendance'])->name('payroll.attendance');
});

// Slack interactive button clicks (the "still working?" attendance check).
// No auth middleware — authenticity is proven by the Slack signing-secret HMAC
// verified inside the controller.
Route::post('/slack/interact', [SlackInteractionController::class, 'handle'])->name('slack.interact');

/*
|--------------------------------------------------------------------------
| Desktop Tracker API (Sanctum token auth)
|--------------------------------------------------------------------------
*/
Route::prefix('desktop')->group(function () {
    Route::post('/login', [DesktopAuthController::class, 'login'])->name('desktop.login');

    Route::middleware(['auth:sanctum', 'active'])->group(function () {
        Route::get('/me', [DesktopAuthController::class, 'me'])->name('desktop.me');
        Route::post('/logout', [DesktopAuthController::class, 'logout'])->name('desktop.logout');

        Route::get('/clients', [DesktopMetaController::class, 'clients'])->name('desktop.clients');
        Route::get('/work-types', [DesktopMetaController::class, 'workTypes'])->name('desktop.work-types');
        Route::get('/upwork-profiles', [DesktopMetaController::class, 'upworkProfiles'])->name('desktop.upwork-profiles');
        Route::get('/settings', [DesktopMetaController::class, 'settings'])->name('desktop.settings');

        Route::post('/sessions/start', [DesktopSessionController::class, 'start'])->name('desktop.sessions.start');
        Route::patch('/sessions/{session}/heartbeat', [DesktopSessionController::class, 'heartbeat'])->name('desktop.sessions.heartbeat');
        Route::post('/sessions/{session}/stop', [DesktopSessionController::class, 'stop'])->name('desktop.sessions.stop');
        Route::get('/sessions/today', [DesktopSessionController::class, 'today'])->name('desktop.sessions.today');
        Route::get('/sessions/week', [DesktopSessionController::class, 'week'])->name('desktop.sessions.week');
        Route::get('/sessions/recent-clients', [DesktopSessionController::class, 'recentClients'])->name('desktop.sessions.recent-clients');

        Route::get('/time-clock', [DesktopTimeClockController::class, 'status'])->name('desktop.time-clock.status');
        Route::post('/time-clock', [DesktopTimeClockController::class, 'act'])->name('desktop.time-clock.act');

        Route::post('/screenshots', [DesktopScreenshotController::class, 'store'])->name('desktop.screenshots.store');
        Route::post('/activity/batch', [DesktopActivityController::class, 'batch'])->name('desktop.activity.batch');

        // Client-side error / telemetry the tracker uploads (capture failures,
        // pause/break transitions, crashes) → the 'desktop' diagnostics category.
        Route::post('/diagnostics', [DesktopDiagnosticsController::class, 'store'])->name('desktop.diagnostics.store');

        // Endpoint compliance inventory (extensions, programs, processes, VPN) →
        // blocklist-matched for the Machine Compliance dashboard.
        Route::post('/machine-report', [DesktopMachineReportController::class, 'store'])->name('desktop.machine-report.store');
    });
});
