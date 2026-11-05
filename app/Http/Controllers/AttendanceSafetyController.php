<?php

namespace App\Http\Controllers;

use App\Models\AttendanceBulkAction;
use App\Models\CompanyHoliday;
use App\Models\ManualAttendanceAudit;
use App\Models\ManualAttendanceMark;
use App\Models\TimeEntry;
use App\Models\TrackingAuditLog;
use App\Support\AttendanceStatus;
use Carbon\Carbon;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/** Undo for bulk attendance changes, and the Company Holidays list. */
class AttendanceSafetyController extends Controller
{
    /**
     * Puts each cell back as it was. A cell someone changed after the bulk
     * action is left alone: that later edit was deliberate.
     */
    public function undo(Request $request, AttendanceBulkAction $bulkAction)
    {
        [$restored, $skipped] = DB::transaction(function () use ($request, $bulkAction) {
            $action = AttendanceBulkAction::query()->lockForUpdate()->findOrFail($bulkAction->id);

            if ($action->undone_at) {
                throw ValidationException::withMessages(['bulk_action' => 'This change was already undone.']);
            }

            $restored = 0;
            $skipped = 0;
            $reason = 'Undo of bulk change #'.$action->id;

            foreach ($action->audits()->orderByDesc('id')->get() as $audit) {
                $date = $audit->attendance_date->toDateString();
                $mark = ManualAttendanceMark::query()
                    ->where('user_id', $audit->user_id)
                    ->whereDate('attendance_date', $date)
                    ->first();

                if ($mark?->status_code !== $audit->new_status_code) {
                    $skipped++;

                    continue;
                }

                ManualAttendanceAudit::create([
                    'user_id' => $audit->user_id,
                    'attendance_date' => $date,
                    'old_status_code' => $mark?->status_code,
                    'new_status_code' => $audit->old_status_code,
                    'changed_by_user_id' => $request->user()->id,
                    'changed_at' => Carbon::now('Asia/Karachi'),
                    'reason' => $reason,
                    'old_note' => $mark?->note,
                ]);

                if ($audit->old_status_code === null) {
                    $mark?->delete();
                } else {
                    $mark ??= new ManualAttendanceMark(['user_id' => $audit->user_id, 'attendance_date' => $date]);
                    $mark->fill([
                        'marked_by_user_id' => $request->user()->id,
                        'status_code' => $audit->old_status_code,
                        'note' => $audit->old_note,
                    ])->save();
                }

                $restored++;
            }

            $action->update(['undone_at' => Carbon::now('Asia/Karachi'), 'undone_by_user_id' => $request->user()->id]);

            return [$restored, $skipped];
        });

        $message = "Restored {$restored} ".($restored === 1 ? 'cell' : 'cells').'.';
        if ($skipped > 0) {
            $message .= " {$skipped} changed since then and ".($skipped === 1 ? 'was' : 'were').' left as is.';
        }

        return response()->json(['message' => $message, 'restored' => $restored, 'skipped' => $skipped]);
    }

    public function holidays(Request $request)
    {
        $validated = $request->validate(['year' => ['nullable', 'integer', 'min:2000', 'max:2100']]);
        $year = $validated['year'] ?? Carbon::now('Asia/Karachi')->year;

        $holidays = collect(CompanyHoliday::between("{$year}-01-01", "{$year}-12-31"))
            ->sortKeys()
            ->values()
            ->map(fn (CompanyHoliday $holiday) => [
                'id' => $holiday->id,
                'date' => $holiday->date->toDateString(),
                'label' => $holiday->date->format('D j M Y'),
                'name' => $holiday->name,
                'status_code' => $holiday->status_code,
                'status_label' => AttendanceStatus::CODES[$holiday->status_code] ?? $holiday->status_code,
            ]);

        return response()->json(['year' => $year, 'holidays' => $holidays]);
    }

    public function storeHoliday(Request $request)
    {
        $validated = $request->validate([
            'date' => ['required', 'date_format:Y-m-d'],
            'name' => ['required', 'string', 'max:120'],
            'status_code' => ['required', Rule::in(CompanyHoliday::STATUS_CODES)],
        ]);

        if (CompanyHoliday::query()->whereDate('date', $validated['date'])->exists()) {
            throw ValidationException::withMessages(['date' => 'That date is already on the list.']);
        }

        $holiday = CompanyHoliday::create($validated + ['created_by_user_id' => $request->user()->id]);

        $clockedIn = TimeEntry::query()
            ->whereDate('action_date', $validated['date'])
            ->where('action_type', 'clock_in')
            ->distinct()
            ->count('user_id');

        $this->log($request, 'attendance.holiday_added', $holiday);

        return response()->json([
            'message' => $clockedIn > 0
                ? "Holiday added. {$clockedIn} ".($clockedIn === 1 ? 'person' : 'people').' clocked in that day and will stay Present.'
                : 'Holiday added.',
            'id' => $holiday->id,
        ], 201);
    }

    public function destroyHoliday(Request $request, CompanyHoliday $holiday)
    {
        $this->log($request, 'attendance.holiday_removed', $holiday);
        $holiday->delete();

        return response()->json(['message' => 'Holiday removed.']);
    }

    private function log(Request $request, string $action, CompanyHoliday $holiday): void
    {
        TrackingAuditLog::record([
            'subject_user_id' => $request->user()->id,
            'actor_user_id' => $request->user()->id,
            'action' => $action,
            'event_date' => $holiday->date->toDateString(),
            'new_value' => ['name' => $holiday->name, 'status_code' => $holiday->status_code],
        ]);
    }
}
