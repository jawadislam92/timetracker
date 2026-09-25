<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Guards the read-only payroll export (/api/payroll/*). One static bearer
 * token, configured as PAYROLL_API_TOKEN; leave it unset to disable the
 * endpoints entirely (they then 404 like the scheduler trigger does).
 */
class PayrollTokenMiddleware
{
    public function handle(Request $request, Closure $next): Response
    {
        $expected = (string) config('services.payroll.token', '');

        if ($expected === '') {
            abort(404);
        }

        $given = (string) $request->bearerToken();

        if ($given === '' || ! hash_equals($expected, $given)) {
            return response()->json(['message' => 'Invalid payroll token.'], 401);
        }

        return $next($request);
    }
}
