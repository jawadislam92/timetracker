<?php

namespace App\Console\Commands;

use App\Models\User;
use Illuminate\Console\Command;

/**
 * Promote existing accounts to Owner (above Super Admin, not tracked). This is
 * how the first Owner is made; after that an Owner can assign it in the app.
 */
class MakeOwner extends Command
{
    protected $signature = 'user:make-owner {email* : One or more account emails} {--dry-run : Show who would change without saving}';

    protected $description = 'Make accounts Owners: full control, never tracked or shown as staff';

    public function handle(): int
    {
        $failed = false;

        foreach ($this->argument('email') as $email) {
            $user = User::where('email', $email)->first();

            if (! $user) {
                $this->error("No account with email {$email}");
                $failed = true;

                continue;
            }

            if ($user->isOwner()) {
                $this->line("{$user->name} <{$email}> is already an Owner");

                continue;
            }

            if ($this->option('dry-run')) {
                $this->line("Would make {$user->name} <{$email}> an Owner (now {$user->role_label})");

                continue;
            }

            $user->role = User::OWNER;
            $user->permissions = [];
            $user->save();
            $user->tokens()->delete(); // stop any desktop tracker signed in as them

            $this->info("{$user->name} <{$email}> is now an Owner");
        }

        return $failed ? self::FAILURE : self::SUCCESS;
    }
}
