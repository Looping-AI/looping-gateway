INSERT OR IGNORE INTO workspaces (id, name) VALUES (0, 'org');
--> statement-breakpoint
INSERT OR IGNORE INTO agents (name, kind, display_name, enabled, workspace_id)
  VALUES ('admin', 'admin', 'Admin Agent', 1, 0),
         ('onboarding', 'onboarding', 'Onboarding Agent', 1, 0);
