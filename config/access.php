<?php

return [
    'roles' => [
        'owner' => [
            'label' => 'Owner',
            'description' => 'Full control, but not tracked: never in attendance, reports or alerts. Only an Owner can assign it.',
        ],
        'super_admin' => [
            'label' => 'Super Admin',
            'description' => 'Full system access, including roles and permissions.',
        ],
        'admin' => [
            'label' => 'Admin',
            'description' => 'Management access selected by a Super Admin.',
        ],
        'member' => [
            'label' => 'Member',
            'description' => 'Personal time tracking with optional selected access.',
        ],
    ],

    /*
    |--------------------------------------------------------------------------
    | Permission catalog
    |--------------------------------------------------------------------------
    | Keys are stable identifiers used in code — never rename them. Labels and
    | descriptions feed the user form so a Super Admin can see exactly what
    | each toggle grants (and what it costs) before assigning it.
    */
    'permissions' => [
        'Dashboard' => [
            'dashboard.view_team' => [
                'label' => 'View team activity',
                'description' => 'Shows the whole team\'s table on the dashboard: who is working, in-office vs tracked hours, and the coverage score. Without it, a person only sees their own day.',
            ],
        ],
        'AI Assistant' => [
            'ai.assistant' => [
                'label' => 'Use the AI Assistant',
                'description' => 'Shows the floating AI chat bubble and the "Summarize this day" button. Every question/summary spends a few cents of Anthropic API credit, so grant this only to people who manage others.',
            ],
        ],
        'Reports' => [
            'reports.view' => [
                'label' => 'View reports',
                'description' => 'Opens the Work Hours Report for the whole team, including clickable per-person and per-client breakdowns.',
            ],
            'reports.export' => [
                'label' => 'Export reports',
                'description' => 'Allows downloading team work-hour reports as CSV files that leave the system.',
            ],
            'reports.send_slack' => [
                'label' => 'Send reports to Slack',
                'description' => 'Can push work-hour and attendance digests into the company Slack channels.',
            ],
        ],
        'Attendance' => [
            'attendance.view' => [
                'label' => 'View team attendance',
                'description' => 'Opens the Attendance page: monthly grid, daily summary, activity, and timeline tabs for every employee.',
            ],
            'attendance.manual_mark' => [
                'label' => 'Mark attendance manually',
                'description' => 'Can override attendance statuses (Present, Leave, Holiday…) and schedule company-wide marks. Every change is recorded in the audit history.',
            ],
            'attendance.edit_times' => [
                'label' => 'Edit clock-in/out times',
                'description' => 'Can set or correct an employee\'s clock-in, clock-out, and break times for a day — e.g. when they forgot to clock in. This creates the in-office window so the employee can then log their own manual time. Every edit is recorded in the audit history.',
            ],
            'attendance.export' => [
                'label' => 'Export attendance',
                'description' => 'Allows downloading attendance data as CSV.',
            ],
        ],
        'Schedule' => [
            'shift.edit_own' => [
                'label' => 'Change own shift for a day',
                'description' => 'Lets a person set a one-day shift change for themselves — a different start time and/or length on a specific date (e.g. start earlier on Friday because they are off Saturday). Today or future dates only. It only moves that day\'s schedule (and the auto clock-out window); it never creates clock-ins or hours, so it cannot inflate time.',
            ],
            'shift.manage_all' => [
                'label' => 'Change anyone\'s shift for a day',
                'description' => 'Set or remove a one-day shift change for any employee, including backdated days — e.g. to approve a teammate\'s adjusted day. Every change is recorded in the audit history.',
            ],
        ],
        'Work Diary' => [
            'work_hours.manage_all' => [
                'label' => 'Edit anyone\'s work entries',
                'description' => 'Can edit and delete work-diary entries belonging to other users — normally people can only touch their own. Affects reported hours, so keep this rare.',
            ],
        ],
        'Monitoring & Timeline' => [
            'timeline.view_others' => [
                'label' => 'View others\' timelines',
                'description' => 'Opens Team Performance and any member\'s daily timeline (sessions, apps & URLs, activity ruler).',
            ],
            'analytics.view' => [
                'label' => 'View performance analytics',
                'description' => 'Opens the per-person Analytics page (charts of hours, activity trend, and top apps/clients over a date range). Charts only — no screenshot-level timeline; grant this to managers who need trends without the privacy-sensitive timeline.',
            ],
            'monitoring.view' => [
                'label' => 'View tracking sessions',
                'description' => 'Lists raw desktop-tracker sessions across the team (admin monitoring pages).',
            ],
            'monitoring.view_screenshots' => [
                'label' => 'View screenshots',
                'description' => 'Shows the actual captured screenshots of other users on timelines and session pages. The most privacy-sensitive permission — grant deliberately.',
            ],
            'monitoring.manage' => [
                'label' => 'Manage sessions & flags',
                'description' => 'Can stop or abandon tracking sessions and flag/unflag screenshots for review.',
            ],
            'monitoring.delete_screenshots' => [
                'label' => 'Delete screenshots',
                'description' => 'Can permanently remove captured screenshots (reason is recorded in the audit log).',
            ],
        ],
        'Users' => [
            'users.view' => [
                'label' => 'View user directory',
                'description' => 'Opens the Users page: names, designations, shifts, roles, and weekly hours.',
            ],
            'users.manage' => [
                'label' => 'Create & edit users',
                'description' => 'Can add accounts, change designations and shift times, and reset details for ordinary users. Cannot touch Super Admins.',
            ],
            'users.delete' => [
                'label' => 'Delete users',
                'description' => 'Can permanently delete ordinary user accounts and their access. Use sparingly.',
            ],
        ],
        'Clients' => [
            'clients.view' => [
                'label' => 'View clients',
                'description' => 'Opens the Clients list with work types, profiles, tags, and weekly hours per client.',
            ],
            'clients.manage' => [
                'label' => 'Create, edit & delete clients',
                'description' => 'Full write access to client records — renames and deletions affect how past hours are reported.',
            ],
            'clients.import_export' => [
                'label' => 'Import & export clients',
                'description' => 'Bulk CSV import and export of the entire client list.',
            ],
        ],
        'Upwork Profiles' => [
            'profiles.view' => [
                'label' => 'View profiles',
                'description' => 'Opens the Upwork profiles list used to attribute tracked work.',
            ],
            'profiles.manage' => [
                'label' => 'Manage profiles',
                'description' => 'Can create, edit, and delete Upwork profiles.',
            ],
        ],
        'Help & Feedback' => [
            'feedback.manage' => [
                'label' => 'Manage the feedback inbox',
                'description' => 'Opens the Feedback Inbox: questions and feature requests submitted by the team (including searches the Help docs couldn\'t answer). Can change a request\'s status and reply. Everyone can submit feedback and see their own; this grants the triage view.',
            ],
            'help.manage' => [
                'label' => 'Edit help articles',
                'description' => 'Can add and edit the Help knowledge-base articles that power the searchable Help page. Content only — no access to anyone\'s data.',
            ],
        ],
        'System' => [
            'monitoring.settings' => [
                'label' => 'Change tracking settings',
                'description' => 'Can change team-wide and per-person tracking configuration: screenshot frequency, activity tracking, auto-pause, display format — and edit the AI assistant\'s common questions. Affects every employee\'s tracker.',
            ],
        ],
    ],
];
