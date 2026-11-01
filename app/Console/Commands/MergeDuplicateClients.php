<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;

/**
 * Merge clients that are the same person entered more than once — names that
 * differ only by case or spacing ("Vishal Sardana" / "Vishal sardana",
 * "Sander\tBaas"). Their hours were split across rows in every report.
 *
 * For each group the record with the most work-hour rows survives (ties: the
 * active one, then the oldest). Work hours and tracking sessions move to it,
 * Upwork-profile links are combined, blank contact fields are filled from the
 * duplicates, it stays active if any copy was active, and its name loses
 * stray tabs/double spaces. Everything touched is written to a JSON backup
 * first. Dry run unless --apply.
 */
class MergeDuplicateClients extends Command
{
    protected $signature = 'clients:merge-duplicates {--apply : Make the changes (default is a dry run)}';

    protected $description = 'Merge clients whose names differ only by case or spacing';

    private const CONTACT_FIELDS = ['email', 'phone', 'preferred_contact', 'contact_notes', 'tags', 'work_type', 'upwork_profile_id'];

    public static function normalize(string $name): string
    {
        return mb_strtolower(trim(preg_replace('/\s+/u', ' ', $name)));
    }

    public function handle(): int
    {
        $apply = (bool) $this->option('apply');
        $counts = DB::table('work_hours')->whereNotNull('client_id')->selectRaw('client_id, COUNT(*) as n')->groupBy('client_id')->pluck('n', 'client_id');

        $groups = DB::table('clients')->orderBy('id')->get()
            ->groupBy(fn ($c) => self::normalize($c->name))
            ->filter(fn ($g) => $g->count() > 1);

        if ($groups->isEmpty()) {
            $this->info('No duplicate clients found.');

            return self::SUCCESS;
        }

        $plan = $groups->map(function ($g) use ($counts) {
            $sorted = $g->sortBy([
                fn ($a, $b) => ($counts[$b->id] ?? 0) <=> ($counts[$a->id] ?? 0),
                fn ($a, $b) => (int) ($b->is_active ?? 1) <=> (int) ($a->is_active ?? 1),
                fn ($a, $b) => $a->id <=> $b->id,
            ])->values();

            return ['keep' => $sorted->first(), 'merge' => $sorted->slice(1)->values()];
        })->values();

        $this->table(['Keep', 'Name', 'Rows', 'Merging in (id: rows)'], $plan->map(fn ($p) => [
            $p['keep']->id,
            preg_replace('/\s+/u', ' ', trim($p['keep']->name)),
            $counts[$p['keep']->id] ?? 0,
            $p['merge']->map(fn ($c) => $c->id.': '.($counts[$c->id] ?? 0))->implode(', '),
        ])->all());

        $extra = $plan->sum(fn ($p) => $p['merge']->count());
        $movedRows = $plan->sum(fn ($p) => $p['merge']->sum(fn ($c) => $counts[$c->id] ?? 0));
        $this->line("{$plan->count()} groups, {$extra} duplicate records, {$movedRows} work-hour rows to move.");

        if (! $apply) {
            $this->warn('Dry run — nothing changed. Re-run with --apply to merge.');

            return self::SUCCESS;
        }

        $mergeIds = $plan->flatMap(fn ($p) => $p['merge']->pluck('id'))->all();
        $keepIds = $plan->pluck('keep.id')->all();
        $backup = [
            'taken_at' => now()->toIso8601String(),
            'clients' => DB::table('clients')->whereIn('id', array_merge($keepIds, $mergeIds))->get(),
            'client_upwork_profile' => DB::table('client_upwork_profile')->whereIn('client_id', array_merge($keepIds, $mergeIds))->get(),
            'work_hours' => DB::table('work_hours')->whereIn('client_id', $mergeIds)->get(['id', 'client_id']),
            'tracking_sessions' => DB::table('tracking_sessions')->whereIn('client_id', $mergeIds)->get(['id', 'client_id']),
            'plan' => $plan->map(fn ($p) => ['keep' => $p['keep']->id, 'merge' => $p['merge']->pluck('id')])->all(),
        ];
        $path = 'client-merge-backups/client-merge-'.now()->format('Ymd-His').'.json';
        Storage::disk('local')->put($path, json_encode($backup, JSON_PRETTY_PRINT));
        $this->info('Backup written to storage/app/'.$path);

        DB::transaction(function () use ($plan) {
            foreach ($plan as $p) {
                $keep = $p['keep'];
                $ids = $p['merge']->pluck('id')->all();

                DB::table('work_hours')->whereIn('client_id', $ids)->update(['client_id' => $keep->id]);
                DB::table('tracking_sessions')->whereIn('client_id', $ids)->update(['client_id' => $keep->id]);

                $profiles = DB::table('client_upwork_profile')->whereIn('client_id', array_merge([$keep->id], $ids))->pluck('upwork_profile_id')->unique();
                DB::table('client_upwork_profile')->whereIn('client_id', array_merge([$keep->id], $ids))->delete();
                foreach ($profiles as $profileId) {
                    DB::table('client_upwork_profile')->insert(['client_id' => $keep->id, 'upwork_profile_id' => $profileId, 'created_at' => now(), 'updated_at' => now()]);
                }

                $update = ['name' => preg_replace('/\s+/u', ' ', trim($keep->name)), 'updated_at' => now()];
                foreach (self::CONTACT_FIELDS as $field) {
                    if (property_exists($keep, $field) && ($keep->{$field} === null || $keep->{$field} === '')) {
                        $value = $p['merge']->first(fn ($c) => isset($c->{$field}) && $c->{$field} !== '')?->{$field};
                        if ($value !== null) {
                            $update[$field] = $value;
                        }
                    }
                }
                if (property_exists($keep, 'is_active') && $p['merge']->contains(fn ($c) => (bool) $c->is_active)) {
                    $update['is_active'] = true;
                }
                DB::table('clients')->where('id', $keep->id)->update($update);
                DB::table('clients')->whereIn('id', $ids)->delete();
            }
        });

        $this->info("Merged {$extra} duplicate records into {$plan->count()} clients.");

        return self::SUCCESS;
    }
}
