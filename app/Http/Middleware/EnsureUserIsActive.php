<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;

/**
 * Rejects a user who was DEACTIVATED while still holding a live web session or
 * desktop token. Login already blocks deactivated users, but an existing
 * session/token survives a deactivation — this boots it on the very next
 * request, so "deactivate" takes effect immediately everywhere.
 *
 * - Web (has a session, incl. Inertia): log out + redirect to login.
 * - Desktop / token auth (no session): revoke the token + JSON 403.
 */
class EnsureUserIsActive
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();

        if ($user && ! $user->isActive()) {
            if (! $request->hasSession()) {
                // Token-authenticated desktop client — kill this token and refuse.
                $user->currentAccessToken()?->delete();

                return response()->json(['message' => 'Your account has been deactivated.'], 403);
            }

            Auth::guard('web')->logout();
            $request->session()->invalidate();
            $request->session()->regenerateToken();

            return redirect()->route('login')->withErrors([
                'email' => 'Your account has been deactivated. Please contact your administrator.',
            ]);
        }

        // Owners are not tracked: a desktop token that predates the promotion
        // is revoked on its next call, so the tracker app stops at once.
        if ($user && $user->isOwner() && ! $request->hasSession()) {
            $user->currentAccessToken()?->delete();

            return response()->json(['message' => 'Owner accounts are not tracked. Sign in on the website to manage the team.'], 403);
        }

        return $next($request);
    }
}
