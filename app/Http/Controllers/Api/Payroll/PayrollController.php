<?php

namespace App\Http\Controllers\Api\Payroll;

use App\Http\Controllers\Controller;
use App\Services\PayrollExportService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Read-only export consumed by the Tankhwah payroll app. Guarded by the
 * payroll.token middleware. Nothing here writes to SA Track.
 */
class PayrollController extends Controller
{
    public function __construct(private PayrollExportService $export) {}

    public function ping(): JsonResponse
    {
        return response()->json(['ok' => true, 'app' => config('app.name'), 'time' => now('Asia/Karachi')->toIso8601String()]);
    }

    public function users(): JsonResponse
    {
        return response()->json(['users' => $this->export->users()]);
    }

    public function attendance(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'month' => ['required', 'date_format:Y-m'],
            'user_ids' => ['nullable', 'string', 'regex:/^\d+(,\d+)*$/'],
        ]);

        $ids = isset($validated['user_ids']) ? array_map('intval', explode(',', $validated['user_ids'])) : null;

        return response()->json($this->export->attendance($validated['month'], $ids));
    }
}
