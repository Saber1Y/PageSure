CREATE TABLE `activity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`type` text NOT NULL,
	`ok` integer DEFAULT true NOT NULL,
	`message` text NOT NULL,
	`service_id` text,
	`session_id` text,
	`request_id` text,
	`amount_base` text,
	`asset_code` text,
	`decimals` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `payment_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `activity_events_created_idx` ON `activity_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `activity_events_organization_idx` ON `activity_events` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `auth_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`window_start` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_attempts_window_idx` ON `auth_attempts` (`window_start`);--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`request_id` text,
	`session_id` text,
	`service_id` text,
	`payer` text NOT NULL,
	`amount_base` text NOT NULL,
	`asset_code` text DEFAULT '' NOT NULL,
	`decimals` integer DEFAULT 7 NOT NULL,
	`reason` text NOT NULL,
	`policy_trace` text,
	`payment_tx_hash` text,
	`acknowledged_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `payment_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `incidents_open_idx` ON `incidents` (`acknowledged_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `incidents_organization_idx` ON `incidents` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `login_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`purpose` text NOT NULL,
	`wallet_public_key` text,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_challenges_expiry_idx` ON `login_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`settlement_recipient` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `organizations_recipient_idx` ON `organizations` (`settlement_recipient`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_idx` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE INDEX `passkeys_user_idx` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `payment_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`ref` text NOT NULL,
	`service_id` text NOT NULL,
	`channel_contract` text NOT NULL,
	`funder` text NOT NULL,
	`recipient` text NOT NULL,
	`asset_contract` text NOT NULL,
	`decimals` integer DEFAULT 7 NOT NULL,
	`commitment_public_key` text NOT NULL,
	`cumulative_base` text DEFAULT '0' NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`funded_base` text NOT NULL,
	`status` text DEFAULT 'opening' NOT NULL,
	`close_effective_at_ledger` integer,
	`settlement_id` text,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_sessions_channel_idx` ON `payment_sessions` (`channel_contract`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_sessions_ref_idx` ON `payment_sessions` (`ref`);--> statement-breakpoint
CREATE INDEX `payment_sessions_status_idx` ON `payment_sessions` (`status`);--> statement-breakpoint
CREATE INDEX `payment_sessions_service_idx` ON `payment_sessions` (`service_id`);--> statement-breakpoint
CREATE INDEX `payment_sessions_organization_idx` ON `payment_sessions` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`unknown_action` text DEFAULT 'review' NOT NULL,
	`max_amount_per_request_base` text,
	`daily_cap_per_wallet_base` text,
	`ungranted_spend_cap_base` text,
	`rate_limit_per_min` integer,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `policies_organization_idx` ON `policies` (`organization_id`);--> statement-breakpoint
CREATE TABLE `policy_allowlist` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`wallet` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_allowlist_unique` ON `policy_allowlist` (`policy_id`,`wallet`);--> statement-breakpoint
CREATE TABLE `policy_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`asset_contract` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_assets_unique` ON `policy_assets` (`policy_id`,`asset_contract`);--> statement-breakpoint
CREATE TABLE `policy_denylist` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`wallet` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_denylist_unique` ON `policy_denylist` (`policy_id`,`wallet`);--> statement-breakpoint
CREATE TABLE `policy_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`service_id` text,
	`wallet` text NOT NULL,
	`granted_from_review_id` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `policy_grants_lookup_idx` ON `policy_grants` (`policy_id`,`wallet`,`service_id`);--> statement-breakpoint
CREATE INDEX `policy_grants_expiry_idx` ON `policy_grants` (`expires_at`);--> statement-breakpoint
CREATE TABLE `policy_networks` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`network` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_networks_unique` ON `policy_networks` (`policy_id`,`network`);--> statement-breakpoint
CREATE TABLE `policy_service_links` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`service_id` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_service_links_unique` ON `policy_service_links` (`policy_id`,`service_id`);--> statement-breakpoint
CREATE TABLE `rate_limit_buckets` (
	`key` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`wallet` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rate_limit_buckets_window_idx` ON `rate_limit_buckets` (`window_start`);--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`service_id` text NOT NULL,
	`policy_id` text,
	`session_id` text,
	`review_id` text,
	`claimed_payer` text,
	`verified_payer` text,
	`mode` text NOT NULL,
	`amount_base` text NOT NULL,
	`status` text NOT NULL,
	`policy_decision` text NOT NULL,
	`policy_trace` text NOT NULL,
	`receipt_reference` text,
	`payment_tx_hash` text,
	`settlement_id` text,
	`upstream_provider` text,
	`upstream_status` integer,
	`latency_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `payment_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`review_id`) REFERENCES `review_decisions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `requests_service_idx` ON `requests` (`service_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `requests_status_idx` ON `requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `requests_session_idx` ON `requests` (`session_id`);--> statement-breakpoint
CREATE INDEX `requests_payment_tx_idx` ON `requests` (`payment_tx_hash`);--> statement-breakpoint
CREATE INDEX `requests_organization_idx` ON `requests` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `review_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`service_id` text,
	`wallet` text NOT NULL,
	`reason` text NOT NULL,
	`policy_trace` text NOT NULL,
	`amount_base` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`note` text DEFAULT '' NOT NULL,
	`replays` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`policy_id`) REFERENCES `policies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `review_decisions_status_idx` ON `review_decisions` (`status`);--> statement-breakpoint
CREATE INDEX `review_decisions_wallet_idx` ON `review_decisions` (`policy_id`,`wallet`,`service_id`);--> statement-breakpoint
CREATE INDEX `review_decisions_organization_idx` ON `review_decisions` (`organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `schema_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`asset_code` text NOT NULL,
	`asset_contract` text NOT NULL,
	`decimals` integer DEFAULT 7 NOT NULL,
	`price_base` text NOT NULL,
	`mode` text DEFAULT 'charge' NOT NULL,
	`upstream_kind` text NOT NULL,
	`upstream_config` text DEFAULT '{}' NOT NULL,
	`policy_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `services_slug_idx` ON `services` (`slug`);--> statement-breakpoint
CREATE INDEX `services_status_idx` ON `services` (`status`);--> statement-breakpoint
CREATE INDEX `services_organization_idx` ON `services` (`organization_id`);--> statement-breakpoint
CREATE TABLE `session_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`amount_base` text,
	`request_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `payment_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_events_session_idx` ON `session_events` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_sessions_user_idx` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`request_id` text,
	`session_id` text,
	`request_count` integer DEFAULT 1 NOT NULL,
	`amount_base` text NOT NULL,
	`asset_contract` text NOT NULL,
	`asset_code` text NOT NULL,
	`decimals` integer DEFAULT 7 NOT NULL,
	`payer` text NOT NULL,
	`recipient` text NOT NULL,
	`network` text NOT NULL,
	`tx_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`ledger` integer,
	`explorer_url` text,
	`created_at` integer NOT NULL,
	`confirmed_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `payment_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settlements_tx_idx` ON `settlements` (`tx_hash`);--> statement-breakpoint
CREATE INDEX `settlements_status_idx` ON `settlements` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `settlements_organization_idx` ON `settlements` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`email` text,
	`wallet_public_key` text,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'owner' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_wallet_idx` ON `users` (`wallet_public_key`);--> statement-breakpoint
CREATE INDEX `users_organization_idx` ON `users` (`organization_id`);