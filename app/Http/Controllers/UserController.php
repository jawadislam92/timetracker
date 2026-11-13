<?php

namespace App\Http\Controllers;

use App\Models\Designation;
use App\Models\Shift;
use App\Models\MonitoringSetting;
use App\Models\User;
use App\Models\UserShiftAssignment;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Rules\Password;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;

class UserController extends Controller
{
    use Concerns\RedirectsToReturnPath;

    public function index(Request $request)
    {
        $perPage = $request->get('perPage', 10);
        $rawRoles = $request->input('roles', $request->input('role', []));
        $rawDesignations = $request->input('designations', $request->input('designation', []));
        $roles = collect(is_array($rawRoles) ? $rawRoles : [$rawRoles])
            ->map(fn ($role) => (string) $role)
            ->filter(fn ($role) => $role !== '' && $role !== 'all')
            ->unique()
            ->values()
            ->all();
        $designations = collect(is_array($rawDesignations) ? $rawDesignations : [$rawDesignations])
            ->map(fn ($designation) => (string) $designation)
            ->filter(fn ($designation) => $designation !== '' && $designation !== 'all')
            ->unique()
            ->values()
            ->all();
        $rawShiftIds = $request->input('shift_ids', []);
        $shiftIds = collect(is_array($rawShiftIds) ? $rawShiftIds : [$rawShiftIds])
            ->map(fn ($id) => (string) $id)
            ->filter(fn ($id) => $id !== '' && $id !== 'all')
            ->unique()
            ->values()
            ->all();

        // Validate perPage to ensure it's within reasonable limits
        if (! in_array($perPage, [10, 25, 50, 100])) {
            $perPage = 10;
        }

        // Start building the query
        $query = User::query();

        // Apply search filter
        if ($request->filled('search')) {
            $search = $request->get('search');
            $query->where(function ($q) use ($search) {
                $q->where('name', 'like', '%'.$search.'%')
                    ->orWhere('email', 'like', '%'.$search.'%');
            });
        }

        // Apply designation filter.
        if (! empty($designations)) {
            $query->where(function ($designationQuery) use ($designations) {
                $regularDesignations = array_values(array_diff($designations, ['no_designation']));

                if (! empty($regularDesignations)) {
                    $designationQuery->whereIn('designation', $regularDesignations);
                }

                if (in_array('no_designation', $designations, true)) {
                    $method = empty($regularDesignations) ? 'where' : 'orWhere';
                    $designationQuery->{$method}(function ($emptyQuery) {
                        $emptyQuery->whereNull('designation')->orWhere('designation', '');
                    });
                }
            });
        }

        // Apply shift filter (curated shift ids + a "no_shift" sentinel).
        if (! empty($shiftIds)) {
            $query->where(function ($shiftQuery) use ($shiftIds) {
                $regularShiftIds = array_values(array_filter($shiftIds, fn ($id) => $id !== 'no_shift'));
                if (! empty($regularShiftIds)) {
                    $shiftQuery->whereIn('shift_id', $regularShiftIds);
                }
                if (in_array('no_shift', $shiftIds, true)) {
                    $method = empty($regularShiftIds) ? 'where' : 'orWhere';
                    $shiftQuery->{$method}(fn ($emptyQuery) => $emptyQuery->whereNull('shift_id'));
                }
            });
        }

        if (! empty($roles)) {
            $query->whereIn('role', $roles);
        }

        // Active / deactivated filter — defaults to "all" so the directory shows
        // everyone (deactivated rows are badged in the UI), with optional
        // narrowing to active-only or archived-only.
        $status = (string) $request->get('status', 'all');
        if ($status === 'active') {
            $query->where('is_active', true);
        } elseif ($status === 'archived') {
            $query->where('is_active', false);
        }

        $startOfWeek = now()->startOfWeek(MonitoringSetting::weekStartDay())->format('Y-m-d');
        $endOfWeek = now()->endOfWeek(MonitoringSetting::weekEndDay())->format('Y-m-d');

        // Sortable columns. Weekly hours sorts on a SQL subquery sum so the
        // order is correct across pages, not just within the visible page.
        $sort = (string) $request->get('sort', 'name');
        $dir = $request->get('dir') === 'desc' ? 'desc' : 'asc';
        $sortColumns = [
            'name' => 'name',
            'designation' => 'designation',
            'shift' => 'shift_start_time',
            'role' => 'role',
        ];

        // One correlated SUM on the paginated query gives every row its weekly
        // hours, so the transform below just reads it instead of firing a query
        // per user (the old code computed this twice — once to sort, once to show).
        $query->withSum([
            'workHours as weekly_hours_sum' => fn ($q) => $q->whereBetween('date', [$startOfWeek, $endOfWeek]),
        ], 'hours');

        if ($sort === 'weekly_hours') {
            $query->orderBy('weekly_hours_sum', $dir);
        } else {
            $query->orderBy($sortColumns[$sort] ?? 'name', $dir);
        }

        $users = $query->orderBy('name')
            ->paginate($perPage)
            ->appends($request->query());

        $users->getCollection()->transform(function ($user) {
            $weeklyHours = (float) ($user->weekly_hours_sum ?? 0);
            $hours = floor($weeklyHours);
            $minutes = round(($weeklyHours - $hours) * 60);

            $user->weekly_hours_worked = sprintf('%02d:%02d', $hours, $minutes);
            $user->role_label = $user->role_label; // force the accessor into the serialized payload
            $user->shift_start_display = $user->shift_start_time?->format('g:i A');
            $user->joining_date_display = $user->joining_date?->format('Y-m-d');

            return $user;
        });

        // Get all unique designations and roles for filter dropdowns.
        $allDesignations = User::whereNotNull('designation')
            ->where('designation', '!=', '')
            ->distinct()
            ->pluck('designation')
            ->sort()
            ->values();

        return Inertia::render('UsersList', [
            'users' => $users,
            'filters' => [
                'search' => $request->get('search', ''),
                'designations' => $designations,
                'shift_ids' => $shiftIds,
                'roles' => $roles,
                'status' => $status,
                'sort' => $sort,
                'dir' => $dir,
            ],
            'permissionGroups' => config('access.permissions'),
            'filterOptions' => [
                'designations' => $allDesignations,
                'shifts' => $this->shiftOptions(),
                'roles' => collect(User::ROLES)->map(
                    fn (string $label, string $value) => ['value' => $value, 'label' => $label]
                )->values(),
            ],
            'managedDesignations' => $this->designationOptions(),
            'managedShifts' => $this->shiftOptions(),
        ]);
    }

    public function create()
    {
        return Inertia::render('UserCreate', $this->accessFormProps());
    }

    public function store(Request $request)
    {
        $rules = [
            'name' => 'required|string|max:255',
            'email' => ['required', 'not_regex:/[\r\n]/', 'email', 'unique:users'],
            'password' => ['required', 'string', Password::min(12)],
            'role' => ['nullable', Rule::in(array_keys(User::ROLES))],
            'permissions' => 'nullable|array',
            'permissions.*' => ['string', Rule::in($this->permissionKeys())],
            'include_in_slack_reports' => 'nullable|boolean',
            'tracks_time' => 'nullable|boolean',
            'designation' => 'nullable|string|max:255',
            'shift_id' => ['nullable', 'integer', 'exists:shifts,id'],
            'joining_date' => ['nullable', 'date_format:Y-m-d'],
            'shift_start_time' => ['nullable', 'date_format:H:i'],
            'shift_grace_minutes' => ['nullable', 'integer', 'min:0', 'max:240'],
            'work_timezone' => ['nullable', 'timezone'],
            'shift_hours' => ['nullable', 'numeric', 'min:0', 'max:24'],
            'clockout_reminder_minutes' => ['nullable', 'integer', 'min:0', 'max:240'],
            'allow_multiple_devices' => 'nullable|boolean',
            'is_active' => 'nullable|boolean',
            // When a shift field changes, this is the date the new shift STARTS
            // applying. Days before it keep being judged by the previous shift.
            // Backdating is allowed (the change really did happen last Monday);
            // future dates are not, because the users.* cache would be wrong
            // until that day arrived.
            'shift_effective_from' => ['nullable', 'date_format:Y-m-d', 'before_or_equal:'.now()->addDay()->toDateString()],
        ];

        // Only add avatar validation if file is present
        if ($request->hasFile('avatar')) {
            $rules['avatar'] = 'nullable|image|mimes:jpeg,png,jpg,gif|max:2048';
        }

        $validated = $request->validate($rules);
        $this->guardOwnerRole($validated['role'] ?? null);

        $avatarPath = null;
        if ($request->hasFile('avatar')) {
            $avatarPath = $request->file('avatar')->store('avatars', 'avatars');
        }

        $userData = [
            'name' => $validated['name'],
            'email' => $validated['email'],
            'password' => Hash::make($validated['password']),
            'role' => $request->user()->isSuperAdmin() ? ($validated['role'] ?? 'member') : 'member',
            'permissions' => $request->user()->isSuperAdmin()
                ? $this->validatedPermissions($validated['permissions'] ?? [])
                : [],
            'include_in_slack_reports' => $request->user()->isSuperAdmin()
                ? ($validated['include_in_slack_reports'] ?? true)
                : true,
            'tracks_time' => $request->user()->isSuperAdmin()
                ? (bool) ($validated['tracks_time'] ?? true)
                : true,
            'designation' => $validated['designation'] ?? null,
            'shift_id' => $validated['shift_id'] ?? null,
            'joining_date' => $validated['joining_date'] ?? null,
            'shift_start_time' => $validated['shift_start_time'] ?? null,
            'shift_grace_minutes' => $validated['shift_grace_minutes'] ?? 15,
            'work_timezone' => $validated['work_timezone'] ?? 'Asia/Karachi',
            'shift_hours' => $validated['shift_hours'] ?? null,
            'clockout_reminder_minutes' => $validated['clockout_reminder_minutes'] ?? null,
            'allow_multiple_devices' => $request->user()->isSuperAdmin()
                ? (bool) ($validated['allow_multiple_devices'] ?? false)
                : false,
            'is_active' => (bool) ($validated['is_active'] ?? true),
        ];

        // Only add avatar if we have one
        if ($avatarPath) {
            $userData['avatar'] = $avatarPath;
        }

        User::create($userData);
        $this->rememberDesignation($userData['designation']);

        return redirect()->route('users.index')->with('success', 'User created successfully!');
    }

    public function edit(User $user)
    {
        $this->guardSuperAdminTarget($user);

        return Inertia::render('UserEdit', [
            'user' => [
                'id' => $user->id,
                'name' => $user->name,
                'email' => $user->email,
                'role' => $user->role,
                'permissions' => $user->permissions ?? [],
                'include_in_slack_reports' => $user->include_in_slack_reports,
                'tracks_time' => (bool) $user->tracks_time,
                'avatar_url' => $user->avatar_url,
                'designation' => $user->designation,
                'shift_id' => $user->shift_id,
                'joining_date' => $user->joining_date?->format('Y-m-d'),
                'shift_start_time' => $user->shift_start_time?->format('H:i'),
                'shift_grace_minutes' => $user->shift_grace_minutes ?? 15,
                'work_timezone' => $user->work_timezone ?: 'Asia/Karachi',
                'shift_hours' => $user->shift_hours !== null ? (float) $user->shift_hours : '',
                'clockout_reminder_minutes' => $user->clockout_reminder_minutes !== null ? (int) $user->clockout_reminder_minutes : '',
                'allow_multiple_devices' => (bool) $user->allow_multiple_devices,
                'is_active' => (bool) $user->is_active,
                'return_to' => request('return_to'),
            ],
            // Also exposed top-level: UserEdit destructures `return_to` from the
            // page props, and only kept working because UserForm fell back to
            // digging it out of the nested user object.
            'return_to' => request('return_to'),
            ...$this->accessFormProps(),
        ]);
    }

    public function update(Request $request, User $user)
    {
        $rules = [
            'name' => 'required|string|max:255',
            'email' => [
                'required',
                'not_regex:/[\r\n]/',
                'email',
                Rule::unique('users')->ignore($user->id),
            ],
            'password' => ['nullable', 'string', Password::min(12)],
            'role' => ['nullable', Rule::in(array_keys(User::ROLES))],
            'permissions' => 'nullable|array',
            'permissions.*' => ['string', Rule::in($this->permissionKeys())],
            'include_in_slack_reports' => 'nullable|boolean',
            'tracks_time' => 'nullable|boolean',
            'designation' => 'nullable|string|max:255',
            'shift_id' => ['nullable', 'integer', 'exists:shifts,id'],
            'joining_date' => ['nullable', 'date_format:Y-m-d'],
            'shift_start_time' => ['nullable', 'date_format:H:i'],
            'shift_grace_minutes' => ['nullable', 'integer', 'min:0', 'max:240'],
            'work_timezone' => ['nullable', 'timezone'],
            'shift_hours' => ['nullable', 'numeric', 'min:0', 'max:24'],
            'clockout_reminder_minutes' => ['nullable', 'integer', 'min:0', 'max:240'],
            'allow_multiple_devices' => 'nullable|boolean',
            'is_active' => 'nullable|boolean',
            // When a shift field changes, this is the date the new shift STARTS
            // applying. Days before it keep being judged by the previous shift.
            // Backdating is allowed (the change really did happen last Monday);
            // future dates are not — the users.* cache would be wrong until then.
            'shift_effective_from' => ['nullable', 'date_format:Y-m-d', 'before_or_equal:'.now()->addDay()->toDateString()],
        ];

        // Only add avatar validation if file is present
        if ($request->hasFile('avatar')) {
            $rules['avatar'] = 'nullable|image|mimes:jpeg,png,jpg,gif|max:2048';
        }

        $validated = $request->validate($rules);
        $this->guardSuperAdminTarget($user);
        if ($request->user()->isSuperAdmin()) {
            $this->guardOwnerRole($validated['role'] ?? null);
        }

        if ($request->user()->is($user)
            && $request->user()->isSuperAdmin()
            && ($validated['role'] ?? 'member') !== $user->role) {
            throw ValidationException::withMessages([
                'role' => $user->isOwner()
                    ? 'You cannot remove Owner from your own account.'
                    : 'You cannot remove Super Admin access from your own account.',
            ]);
        }
        $wasOwner = $user->isOwner();

        // Snapshot the shift config BEFORE the edit so we can tell whether this
        // request actually changed it (an unrelated profile edit must not add a
        // history row).
        $shiftBefore = $this->shiftSnapshot($user);

        $user->name = $validated['name'];
        $user->email = $validated['email'];
        $user->designation = $validated['designation'] ?? null;
        $user->shift_id = $validated['shift_id'] ?? null;
        $user->joining_date = $validated['joining_date'] ?? null;
        $user->shift_start_time = $validated['shift_start_time'] ?? null;
        $user->shift_grace_minutes = $validated['shift_grace_minutes'] ?? 15;
        $user->work_timezone = $validated['work_timezone'] ?? 'Asia/Karachi';
        $user->shift_hours = $validated['shift_hours'] ?? null;
        $user->clockout_reminder_minutes = $validated['clockout_reminder_minutes'] ?? null;

        if ($request->user()->isSuperAdmin()) {
            $user->role = $validated['role'] ?? 'member';
            $user->permissions = $user->isSuperAdmin()
                ? []
                : $this->validatedPermissions($validated['permissions'] ?? []);
            $user->include_in_slack_reports = $validated['include_in_slack_reports'] ?? true;
            $user->tracks_time = (bool) ($validated['tracks_time'] ?? true);
            $user->allow_multiple_devices = (bool) ($validated['allow_multiple_devices'] ?? false);

            $newActive = (bool) ($validated['is_active'] ?? true);
            if (! $newActive && $request->user()->is($user)) {
                throw ValidationException::withMessages(['is_active' => 'You cannot deactivate your own account.']);
            }
            $user->is_active = $newActive;
        }

        // Only update password if it's provided and not empty
        if (! empty($validated['password']) && $validated['password'] !== '') {
            $user->password = Hash::make($validated['password']);
        }

        if ($request->hasFile('avatar')) {
            // Delete old avatar if exists
            if ($user->avatar && Storage::disk('avatars')->exists($user->avatar)) {
                Storage::disk('avatars')->delete($user->avatar);
            }
            $user->avatar = $request->file('avatar')->store('avatars', 'avatars');
        }

        $user->save();

        // Record the new standing-shift era if this edit actually changed one of
        // the shift fields. Without it, the change would silently re-judge every
        // past attendance day against the new times.
        $this->recordShiftEra(
            $user,
            $shiftBefore,
            $validated['shift_effective_from'] ?? null,
            $request->user()->id
        );

        $this->rememberDesignation($user->designation);

        if (! $user->isActive() || ($user->isOwner() && ! $wasOwner)) {
            // Deactivated, or just made an Owner (Owners are not tracked):
            // revoke desktop tokens so the tracker app stops immediately.
            $user->tokens()->delete();
        }

        return $this->redirectToReturnPath($request, 'users.index', [
            'success' => 'User updated successfully!',
        ]);
    }

    public function destroy(Request $request, User $user)
    {
        if ($request->user()->is($user)) {
            throw ValidationException::withMessages([
                'user' => 'You cannot delete your own account.',
            ]);
        }

        $this->guardSuperAdminTarget($user);
        $user->delete();

        return $this->redirectToReturnPath($request, 'users.index', [
            'success' => 'User deleted successfully.',
        ]);
    }

    public function storeDesignation(Request $request)
    {
        if (! $request->user()->hasPermission('users.manage')) {
            abort(403);
        }

        $validated = $request->validate([
            'name' => ['required', 'string', 'max:255'],
        ]);

        $name = $this->normalizeDesignationName($validated['name']);

        if ($name === '') {
            throw ValidationException::withMessages([
                'name' => 'Enter a designation name.',
            ]);
        }

        if (Designation::query()->whereRaw('LOWER(name) = ?', [mb_strtolower($name)])->exists()) {
            throw ValidationException::withMessages([
                'name' => 'This designation already exists.',
            ]);
        }

        Designation::create(['name' => $name]);

        return $this->redirectToReturnPath($request, 'users.index', [
            'success' => 'Designation added.',
        ]);
    }

    public function destroyDesignation(Request $request, Designation $designation)
    {
        if (! $request->user()->hasPermission('users.manage')) {
            abort(403);
        }

        // Clear it from anyone who has it FIRST, so rememberDesignation() can't
        // resurrect it on their next save (the "comes back after delete" bug),
        // and no user is left pointing at a removed suggestion.
        User::where('designation', $designation->name)->update(['designation' => null]);
        $designation->delete();

        return $this->redirectToReturnPath($request, 'users.index', [
            'success' => 'Designation removed.',
        ]);
    }

    public function storeShift(Request $request)
    {
        if (! $request->user()->hasPermission('users.manage')) {
            abort(403);
        }

        $validated = $request->validate(['name' => ['required', 'string', 'max:100']]);
        $name = $this->normalizeDesignationName($validated['name']);

        if ($name === '') {
            throw ValidationException::withMessages(['name' => 'Enter a shift name.']);
        }
        if (Shift::query()->whereRaw('LOWER(name) = ?', [mb_strtolower($name)])->exists()) {
            throw ValidationException::withMessages(['name' => 'This shift already exists.']);
        }

        Shift::create(['name' => $name, 'sort_order' => ((int) Shift::max('sort_order')) + 1]);

        return $this->redirectToReturnPath($request, 'users.index', [
            'success' => 'Shift added.',
        ]);
    }

    public function destroyShift(Request $request, Shift $shift)
    {
        if (! $request->user()->hasPermission('users.manage')) {
            abort(403);
        }

        // Clear it from everyone who had it (owner's choice), then delete. The
        // FK's nullOnDelete is the DB backstop; doing it explicitly keeps the
        // behaviour identical on SQLite (tests) and MySQL (prod).
        User::where('shift_id', $shift->id)->update(['shift_id' => null]);
        $shift->delete();

        return $this->redirectToReturnPath($request, 'users.index', [
            'success' => 'Shift removed.',
        ]);
    }

    private function accessFormProps(): array
    {
        return [
            'roles' => request()->user()->isOwner()
                ? config('access.roles')
                : array_diff_key(config('access.roles'), [User::OWNER => true]),
            'permissionGroups' => config('access.permissions'),
            'canManageAccess' => request()->user()->isSuperAdmin(),
            'designationOptions' => $this->designationOptions()->pluck('name')->values()->all(),
            'shiftOptions' => $this->shiftOptions(),
        ];
    }

    private function designationOptions()
    {
        return Designation::query()
            ->orderBy('name')
            ->get(['id', 'name']);
    }

    /** The curated shift list (id + name), ordered for the pick-only dropdown. */
    private function shiftOptions()
    {
        return Shift::query()
            ->orderBy('sort_order')->orderBy('name')
            ->get(['id', 'name']);
    }

    /**
     * The shift fields that define an era, as a comparable array.
     */
    private function shiftSnapshot(User $user): array
    {
        return [
            'shift_start_time' => optional($user->shift_start_time)->format('H:i'),
            'shift_grace_minutes' => $user->shift_grace_minutes === null ? null : (int) $user->shift_grace_minutes,
            'shift_hours' => $user->shift_hours === null ? null : (float) $user->shift_hours,
            'work_timezone' => $user->work_timezone,
            'shift_id' => $user->shift_id,
        ];
    }

    /**
     * Open a new standing-shift era when the shift actually changed.
     *
     * Attendance status is computed live, so without an era boundary a shift
     * edit silently re-judges the person's ENTIRE past - days they arrived on
     * time start reading as "late". The era row freezes history before
     * `effective_from` and applies the new shift from that date on.
     *
     * Nothing is written when the shift is untouched, so ordinary profile edits
     * don't accumulate rows. A second change on the same date updates that era
     * rather than stacking another row.
     *
     * @param  array<string, mixed>  $before  snapshot taken before the edit
     */
    private function recordShiftEra(User $user, array $before, ?string $effectiveFrom, ?int $actorId): void
    {
        $after = $this->shiftSnapshot($user->refresh());
        if ($before == $after) {
            return;
        }

        $date = $effectiveFrom ?: now($user->workTimezone())->toDateString();

        $values = [
            'shift_start_time' => $after['shift_start_time'],
            'shift_grace_minutes' => $after['shift_grace_minutes'],
            'shift_hours' => $after['shift_hours'],
            'work_timezone' => $after['work_timezone'],
            'shift_id' => $after['shift_id'],
            'created_by' => $actorId,
            'reason' => 'Shift updated',
        ];

        // Look the era up with whereDate rather than updateOrCreate's exact
        // match: the `date` cast writes "2026-08-16 00:00:00" into the column,
        // so an equality match on "2026-08-16" misses the row and then trips
        // the unique index. whereDate compares the date part on both MySQL and
        // SQLite, so a second change on the same day updates that era.
        $era = UserShiftAssignment::where('user_id', $user->id)
            ->whereDate('effective_from', $date)
            ->first();

        if ($era) {
            $era->update($values);

            return;
        }

        UserShiftAssignment::create($values + [
            'user_id' => $user->id,
            'effective_from' => $date,
        ]);
    }

    private function rememberDesignation(?string $designation): void
    {
        $name = $this->normalizeDesignationName($designation ?? '');

        if ($name === '') {
            return;
        }

        Designation::query()->firstOrCreate(['name' => $name]);
    }

    private function normalizeDesignationName(string $name): string
    {
        return trim((string) preg_replace('/\s+/', ' ', $name));
    }


    /**
     * Bulk edit selected users. Only the sections the admin explicitly
     * enabled are applied; everything else is left untouched. Permission
     * changes require Super Admin, and non-supers can never modify a
     * Super Admin account.
     */
    public function bulkUpdate(Request $request)
    {
        $actor = $request->user();

        $data = $request->validate([
            'user_ids' => ['required', 'array', 'min:1', 'max:200'],
            'user_ids.*' => ['integer', 'exists:users,id'],
            // Attendance / profile — any actor with users.manage may set these
            // (mirrors the unconditional attendance block in update()).
            'set_shift' => ['boolean'],
            'shift_start_time' => ['nullable', 'date_format:H:i'],
            'shift_grace_minutes' => ['nullable', 'integer', 'min:0', 'max:240'],
            'set_shift_hours' => ['boolean'],
            'shift_hours' => ['nullable', 'numeric', 'min:0', 'max:24'],
            'set_clockout_reminder' => ['boolean'],
            'clockout_reminder_minutes' => ['nullable', 'integer', 'min:0', 'max:240'],
            'set_designation' => ['boolean'],
            'designation' => ['nullable', 'string', 'max:255'],
            'set_shift_id' => ['boolean'],
            'shift_id' => ['nullable', 'integer', 'exists:shifts,id'],
            'set_work_timezone' => ['boolean'],
            'work_timezone' => ['nullable', 'timezone'],
            // Access-sensitive — Super Admin only (mirrors the isSuperAdmin gate
            // in store()/update()); enforced below before anything is applied.
            'set_role' => ['boolean'],
            'role' => ['nullable', Rule::in(array_keys(User::ROLES))],
            'set_tracks_time' => ['boolean'],
            'tracks_time' => ['nullable', 'boolean'],
            'set_allow_multiple_devices' => ['boolean'],
            'allow_multiple_devices' => ['nullable', 'boolean'],
            'permissions_add' => ['array'],
            'permissions_add.*' => [Rule::in($this->permissionKeys())],
            'permissions_remove' => ['array'],
            'permissions_remove.*' => [Rule::in($this->permissionKeys())],
            'slack_reports' => ['nullable', Rule::in(['include', 'exclude'])],
        ]);

        $wantsPermissionChanges = ! empty($data['permissions_add']) || ! empty($data['permissions_remove']);
        $wantsSensitiveChanges = ! empty($data['set_role'])
            || ! empty($data['set_tracks_time'])
            || ! empty($data['set_allow_multiple_devices'])
            || ! empty($data['slack_reports']); // Slack inclusion is Super-Admin-only in store()/update()
        if (($wantsPermissionChanges || $wantsSensitiveChanges) && ! $actor->isSuperAdmin()) {
            abort(403, 'Only Super Admins can change roles, permissions, tracking, device, or Slack-report access.');
        }

        if (! empty($data['set_role'])) {
            $this->guardOwnerRole($data['role'] ?? null);
        }

        $users = User::whereIn('id', $data['user_ids'])->get();
        $updated = 0;

        foreach ($users as $user) {
            if ($user->isSuperAdmin() && ! $actor->isSuperAdmin()) {
                continue;
            }
            if ($user->isOwner() && ! $actor->isOwner()) {
                continue; // only an Owner can change an Owner
            }
            $wasOwner = $user->isOwner();

            if (! empty($data['set_shift'])) {
                $user->shift_start_time = $data['shift_start_time'] ?? null;
                if (array_key_exists('shift_grace_minutes', $data) && $data['shift_grace_minutes'] !== null) {
                    $user->shift_grace_minutes = $data['shift_grace_minutes'];
                }
            }

            if (! empty($data['set_shift_hours'])) {
                $user->shift_hours = $data['shift_hours'] ?? null; // blank clears → team default
            }

            if (! empty($data['set_clockout_reminder'])) {
                $user->clockout_reminder_minutes = $data['clockout_reminder_minutes'] ?? null;
            }

            if (! empty($data['set_designation'])) {
                $user->designation = $data['designation'] ?: null;
            }

            if (! empty($data['set_shift_id'])) {
                $user->shift_id = $data['shift_id'] ?: null;
            }

            if (! empty($data['set_work_timezone']) && ! empty($data['work_timezone'])) {
                $user->work_timezone = $data['work_timezone'];
            }

            // Role change (Super Admin only). Requires an explicit role — a
            // toggled-but-unpicked role must never silently demote to member.
            // Never demote yourself out of Super Admin in a bulk action;
            // promoting to Super Admin clears explicit permissions like
            // store()/update() do.
            if (! empty($data['set_role']) && ! empty($data['role']) && $actor->isSuperAdmin()) {
                $newRole = $data['role'];
                if (! ($actor->is($user) && $newRole !== $user->role)) {
                    $user->role = $newRole;
                    if ($user->isSuperAdmin()) {
                        $user->permissions = [];
                    }
                }
            }

            if (! empty($data['set_tracks_time']) && $actor->isSuperAdmin()) {
                $user->tracks_time = (bool) ($data['tracks_time'] ?? false);
            }

            if (! empty($data['set_allow_multiple_devices']) && $actor->isSuperAdmin()) {
                $user->allow_multiple_devices = (bool) ($data['allow_multiple_devices'] ?? false);
            }

            if ($wantsPermissionChanges && ! $user->isSuperAdmin()) {
                $user->permissions = collect($user->permissions ?? [])
                    ->merge($data['permissions_add'] ?? [])
                    ->unique()
                    ->reject(fn ($p) => in_array($p, $data['permissions_remove'] ?? [], true))
                    ->values()
                    ->all();
            }

            if (! empty($data['slack_reports']) && $actor->isSuperAdmin()) {
                $user->include_in_slack_reports = $data['slack_reports'] === 'include';
            }

            if ($user->isDirty()) {
                $user->save();
                if ($user->isOwner() && ! $wasOwner) {
                    $user->tokens()->delete(); // Owners are not tracked
                }
                $updated++;
            }
        }

        return response()->json(['message' => "Updated {$updated} user(s).", 'updated' => $updated]);
    }

    /**
     * Activate / deactivate a single user. Deactivating someone who left the
     * company blocks their web + desktop login and revokes any live desktop
     * token immediately; their history is untouched. Can't touch a Super Admin
     * (unless you are one) or deactivate your own account.
     */
    public function setStatus(Request $request, User $user)
    {
        $data = $request->validate(['is_active' => ['required', 'boolean']]);
        $this->guardSuperAdminTarget($user);

        if (! $data['is_active'] && $request->user()->is($user)) {
            throw ValidationException::withMessages(['is_active' => 'You cannot deactivate your own account.']);
        }

        $user->is_active = $data['is_active'];
        $user->save();

        if (! $user->is_active) {
            $user->tokens()->delete(); // revoke desktop access immediately
        }

        return $this->redirectToReturnPath($request, 'users.index', [
            'success' => $data['is_active'] ? 'User reactivated.' : 'User deactivated.',
        ]);
    }

    /**
     * Bulk activate / deactivate. Either an explicit list of ids, or — for the
     * first big cleanup — every user matching the current directory filters
     * ("select all N matching"). Skips Super Admins (unless the actor is one)
     * and the actor's own account; revokes desktop tokens for anyone deactivated.
     */
    public function bulkStatus(Request $request)
    {
        $actor = $request->user();

        $data = $request->validate([
            'is_active' => ['required', 'boolean'],
            'ids' => ['nullable', 'array'],
            'ids.*' => ['integer'],
            'all_matching' => ['nullable', 'boolean'],
            'search' => ['nullable', 'string'],
            'roles' => ['nullable', 'array'],
            'designations' => ['nullable', 'array'],
            'status' => ['nullable', 'string'],
        ]);

        $ids = ! empty($data['all_matching'])
            ? $this->filteredUserQuery($request)->pluck('id')->all()
            : ($data['ids'] ?? []);

        $isActive = (bool) $data['is_active'];
        $changed = 0;

        foreach (User::whereIn('id', $ids)->get() as $user) {
            if ($user->isSuperAdmin() && ! $actor->isSuperAdmin()) {
                continue; // can't touch a Super Admin unless you are one
            }
            if ($user->isOwner() && ! $actor->isOwner()) {
                continue; // only an Owner can change an Owner
            }
            if ($actor->is($user)) {
                continue; // never flip your own account in a bulk action
            }
            if ((bool) $user->is_active === $isActive) {
                continue;
            }

            $user->is_active = $isActive;
            $user->save();
            if (! $isActive) {
                $user->tokens()->delete();
            }
            $changed++;
        }

        $verb = $isActive ? 'Reactivated' : 'Deactivated';

        return $this->redirectToReturnPath($request, 'users.index', [
            'success' => "{$verb} {$changed} user(s).",
        ]);
    }

    /**
     * The directory query with the same search / role / designation filters
     * index() applies (status filter intentionally excluded so "select all
     * matching" targets the whole filtered set regardless of active state).
     */
    private function filteredUserQuery(Request $request)
    {
        $rawRoles = $request->input('roles', $request->input('role', []));
        $rawDesignations = $request->input('designations', $request->input('designation', []));
        $roles = collect(is_array($rawRoles) ? $rawRoles : [$rawRoles])
            ->map(fn ($role) => (string) $role)
            ->filter(fn ($role) => $role !== '' && $role !== 'all')->unique()->values()->all();
        $designations = collect(is_array($rawDesignations) ? $rawDesignations : [$rawDesignations])
            ->map(fn ($d) => (string) $d)
            ->filter(fn ($d) => $d !== '' && $d !== 'all')->unique()->values()->all();

        $query = User::query();

        if ($request->filled('search')) {
            $search = $request->get('search');
            $query->where(function ($q) use ($search) {
                $q->where('name', 'like', '%'.$search.'%')->orWhere('email', 'like', '%'.$search.'%');
            });
        }
        if (! empty($designations)) {
            $query->where(function ($dq) use ($designations) {
                $regular = array_values(array_diff($designations, ['no_designation']));
                if (! empty($regular)) {
                    $dq->whereIn('designation', $regular);
                }
                if (in_array('no_designation', $designations, true)) {
                    $method = empty($regular) ? 'where' : 'orWhere';
                    $dq->{$method}(fn ($eq) => $eq->whereNull('designation')->orWhere('designation', ''));
                }
            });
        }
        if (! empty($roles)) {
            $query->whereIn('role', $roles);
        }

        return $query;
    }

    private function permissionKeys(): array
    {
        return collect(config('access.permissions'))
            ->flatMap(fn (array $permissions) => array_keys($permissions))
            ->values()
            ->all();
    }

    private function validatedPermissions(array $permissions): array
    {
        return array_values(array_unique(array_intersect($permissions, $this->permissionKeys())));
    }

    private function guardSuperAdminTarget(User $user): void
    {
        if ($user->isOwner() && ! request()->user()->isOwner()) {
            abort(403, 'Only an Owner can manage an Owner account.');
        }
        if ($user->isSuperAdmin() && ! request()->user()->isSuperAdmin()) {
            abort(403, 'Only a Super Admin can manage another Super Admin account.');
        }
    }

    /** Only an Owner may hand out the Owner role. */
    private function guardOwnerRole(?string $role): void
    {
        if ($role === User::OWNER && ! request()->user()->isOwner()) {
            throw ValidationException::withMessages([
                'role' => 'Only an Owner can make someone an Owner.',
            ]);
        }
    }
}
