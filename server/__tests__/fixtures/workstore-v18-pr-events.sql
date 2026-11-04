-- Populated v18 history for task "task". PR observations consumed lifecycle versions in v18.
UPDATE tasks SET version = 6 WHERE key = 'task';
INSERT INTO domain_events VALUES (42,'p','task','PR_UPDATED','REVIEW','REVIEW',5,0,'','pr-monitor','2026-01-02');
INSERT INTO domain_events VALUES (43,'p','task','PR_UPDATED','REVIEW','REVIEW',6,0,'','pr-monitor','2026-01-03');
