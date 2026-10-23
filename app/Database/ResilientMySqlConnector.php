<?php

namespace App\Database;

use Illuminate\Database\Connectors\MySqlConnector;
use PDOException;

/**
 * A MySQL connector that retries a refused connection.
 *
 * This host refuses MySQL connections in short bursts — the socket returns
 * EPERM ("[2002] Operation not permitted") for a fraction of a second and then
 * accepts again. Laravel treats that as fatal, so a burst that lasts 200ms
 * turned every request in that window into a 500, including every login.
 *
 * Retrying across ~1.4 seconds rides out a burst. It is a cushion, not a cure:
 * if the host refuses connections for longer than that the request still
 * fails, which is the honest outcome.
 */
class ResilientMySqlConnector extends MySqlConnector
{
    /** Milliseconds to wait before each retry. */
    private const BACKOFF_MS = [50, 150, 400, 800];

    public function connect(array $config)
    {
        $attempt = 0;

        while (true) {
            try {
                return parent::connect($config);
            } catch (PDOException $e) {
                if ($attempt >= count(self::BACKOFF_MS) || ! $this->worthRetrying($e)) {
                    throw $e;
                }

                usleep(self::BACKOFF_MS[$attempt] * 1000);
                $attempt++;
            }
        }
    }

    /**
     * Only transport-level failures are retried. A wrong password or a missing
     * database is not going to fix itself, and retrying would only slow the
     * error down.
     */
    private function worthRetrying(PDOException $e): bool
    {
        $message = $e->getMessage();

        foreach (['[2002]', '[2006]', '[2013]', '[1040]', '[1203]'] as $transient) {
            if (str_contains($message, $transient)) {
                return true;
            }
        }

        return false;
    }
}
