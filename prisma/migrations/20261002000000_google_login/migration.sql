ALTER TABLE users ADD COLUMN google_subject text;
CREATE UNIQUE INDEX users_google_subject_key ON users(google_subject);
ALTER TABLE auth_challenges ADD COLUMN attempts integer NOT NULL DEFAULT 0;
