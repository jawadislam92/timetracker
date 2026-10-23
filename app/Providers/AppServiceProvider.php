<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use App\Database\ResilientMySqlConnector;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        // This host refuses MySQL connections in short bursts; the connector
        // retries them instead of turning each burst into a page of 500s.
        $this->app->bind('db.connector.mysql', fn () => new ResilientMySqlConnector);
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        // Ensure avatars directory exists
        $avatarsPath = storage_path('app/public/avatars');
        if (! file_exists($avatarsPath)) {
            mkdir($avatarsPath, 0755, true);
        }
    }
}
