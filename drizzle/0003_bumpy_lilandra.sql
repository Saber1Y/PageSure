CREATE TABLE `email_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`purpose` text NOT NULL,
	`organization_id` text,
	`role` text,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `email_tokens_email_idx` ON `email_tokens` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `email_tokens_token_idx` ON `email_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `email_tokens_expiry_idx` ON `email_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `organization_members` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'operator' NOT NULL,
	`invited_by` text,
	`accepted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_members_unique_idx` ON `organization_members` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `organization_members_user_idx` ON `organization_members` (`user_id`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `treasury_verified` integer DEFAULT false NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`settlement_recipient` text,
	`commitment_public_key` text,
	`commitment_signer_url` text,
	`commitment_signer_token_env` text,
	`treasury_verified` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_organizations`("id", "name", "settlement_recipient", "commitment_public_key", "commitment_signer_url", "commitment_signer_token_env", "treasury_verified", "created_at") SELECT "id", "name", "settlement_recipient", "commitment_public_key", "commitment_signer_url", "commitment_signer_token_env", "treasury_verified", "created_at" FROM `organizations`;--> statement-breakpoint
DROP TABLE `organizations`;--> statement-breakpoint
ALTER TABLE `__new_organizations` RENAME TO `organizations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `organizations_recipient_idx` ON `organizations` (`settlement_recipient`);
--> statement-breakpoint
-- Backfill memberships for organizations that already exist.
--
-- Before this migration the tenant lived in `users.organizationId` and the role lived in
-- `users.role`. `currentUser()` resolves a session by joining `organization_members`, so every
-- pre-existing tenant user would come back as "no such user" after the upgrade: signed in,
-- holding a valid session, and locked out of every page by a redirect loop.
--
-- The membership is not optional bookkeeping here, it is the only thing that grants access, so
-- it has to be reconstructed for the rows that predate the table. The id is derived from the
-- user id to stay stable across re-runs, and `accepted_at` is backdated to the account's own
-- creation time rather than left null: these memberships were granted when the account was made,
-- not today.
--
-- Users with a null organizationId are deliberately skipped. They are the signed-in-but-tenantless
-- case (an invitation waiting to be accepted), and inventing a membership for them would put
-- somebody in an organization they never joined.
INSERT OR IGNORE INTO `organization_members` (`id`, `organization_id`, `user_id`, `role`, `invited_by`, `accepted_at`, `created_at`)
SELECT 'mem_legacy_' || `id`, `organization_id`, `id`, `role`, NULL, `created_at`, `created_at`
FROM `users`
WHERE `organization_id` IS NOT NULL;
