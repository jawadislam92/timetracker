<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Designation extends Model
{
    use HasFactory;

    protected $fillable = [
        'name',
        'department',
    ];

    /** People whose designation has no department show under this name. */
    public const UNASSIGNED = 'Unassigned';

    /**
     * Starting department for each known designation (lower-cased). Only used
     * to fill blanks; admins re-map anything from the Summary page.
     */
    public const DEFAULT_DEPARTMENTS = [
        'admin assistant' => 'Virtual Assistants',
        'virtual assistant' => 'Virtual Assistants',
        'data entry intern' => 'Virtual Assistants',
        'graphic designer' => 'Graphic Design',
        'video editor' => 'Video Editing',
        'developer' => 'Web Development',
        'web developer' => 'Web Development',
        'content writer' => 'Content & Social',
        'social media executive' => 'Content & Social',
        'bde' => 'Business Development',
        'manager' => 'Management',
        'project manager' => 'Management',
        'account manager' => 'Management',
        'executive' => 'Management',
        'admin' => 'Management',
    ];

    /**
     * Lower-cased designation name => department, for every designation that
     * has one. Matching is case-insensitive because people's free-text titles
     * vary ("Admin assistant" / "Admin Assistant").
     */
    public static function departmentMap(): array
    {
        return static::query()->whereNotNull('department')->where('department', '!=', '')
            ->get(['name', 'department'])
            ->mapWithKeys(fn ($d) => [mb_strtolower(trim($d->name)) => $d->department])
            ->all();
    }
}
